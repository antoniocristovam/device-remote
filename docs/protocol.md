# Protocolo — Remote Controller v1

Fonte da verdade para as duas implementações:

- TypeScript (referência): `packages/protocol` (esquemas) e `packages/crypto-proto` (handshake)
- Kotlin (Android): `apps/android-app/android/app/src/main/java/com/remotecontroller/android/core/crypto`

A compatibilidade entre as duas é verificada por vetores de teste:

```
npm run build:packages
node scripts/gen-test-vectors.mjs                      # TS -> vectors.json
cd apps/android-app/android && ./gradlew :app:testDebugUnitTest   # Kotlin verifica TS e gera mensagens próprias
node scripts/verify-android-vectors.mjs                # TS verifica Kotlin
```

## 1. Primitivas

| Item | Definição |
|---|---|
| Chave de identidade | ECDSA P-256. Android: Keystore (StrongBox se houver), não exportável. Desktop: WebCrypto, privada cifrada com `safeStorage` (DPAPI/Keychain). |
| Chave pública | SPKI DER, transportada em base64url sem padding |
| Fingerprint | hex minúsculo de `SHA-256(SPKI)`; exibição curta: 16 primeiros hex em grupos de 4 |
| Assinatura | ECDSA/SHA-256 em formato IEEE P1363 (`r‖s`, 64 bytes). O Android converte de/para DER. |
| Transcript | concatenação, para cada campo, de `u32be(len) ‖ bytes`. Strings em UTF-8; números como string decimal. |
| Rótulos | todo transcript começa com um rótulo de domínio (`rc/<contexto>/v1`), o que impede reaproveitar uma assinatura em outro contexto |

## 2. Sinalização (cliente ⇄ servidor)

JSON sobre WebSocket. O servidor só roteia `relay` entre os dois pares de uma sala (no máximo um `desktop` e um `android`) e não consegue forjar nada do que vai dentro: tudo é autenticado ponta a ponta.

- `join {room, role}` → `joined {room, peers}`; o outro par recebe `peer-joined`
- `relay {room, data}` → o outro par recebe `relay {room, from, data}`
- `turn` → `turn-credentials {iceServers, ttl}`: credenciais TURN efêmeras (TURN REST API do coturn, HMAC-SHA1, TTL de 10 min)
- Limites: 64 KB por mensagem; token bucket por conexão; heartbeat a cada 30 s

Salas são 32 caracteres hex: na fase de pareamento são derivadas do código; depois são o `channelId` aleatório escolhido pelo celular.

## 3. Pareamento

Código: 16 caracteres Crockford base32 (80 bits), exibido como `XXXX-XXXX-XXXX-XXXX`, com TTL de 2 min.
QR: `rc1:` + base64url(JSON `{s: signalingUrl, c: code, f: desktopFingerprint, n: desktopName}`).

```
room = hex(SHA-256(T("rc/pair-room/v1", code)))[0:32]
K    = HKDF-SHA256(ikm=code, salt="rc/pair/v1", info="mac-key", 32)
```

| # | Direção | Mensagem |
|---|---|---|
| 1 | A→D | `pair.req {nonceA}` |
| 2 | D→A | `pair.offer {nonceD, desktopPub, desktopName, mac = HMAC(K, T("rc/pair-offer/v1", nonceA, nonceD, desktopPub, desktopName))}` |
| — | A | verifica o MAC (prova que o desktop conhece o código) e, via QR, que `fp(desktopPub) == f`. Mostra nome, fingerprint e **SAS**. **Nada do celular foi enviado até aqui.** |
| 3 | A→D | após o toque em **Aceitar**: `pair.accept {androidPub, androidName, channelId, mac, sig}` com `mac = HMAC(K, T("rc/pair-accept/v1", nonceA, nonceD, desktopPub, desktopName, androidPub, androidName, channelId))` e `sig = Sign_A(T("rc/pair-sig/v1", "android", …mesmos campos))` |
| 4 | D→A | `pair.done {sig = Sign_D(T("rc/pair-sig/v1", "desktop", …))}` |

`SAS = u32be(SHA-256(T("rc/sas/v1", nonceA, nonceD, desktopPub))[0:4]) mod 10^6`, com 6 dígitos, exibido nas duas telas.
Ao final, cada lado fixa (pin) a chave pública do outro e o `channelId`.

## 4. Sessão

Sala = `channelId`. O celular só escuta enquanto o usuário ativa **Ficar disponível**.

| # | Direção | Mensagem |
|---|---|---|
| 1 | D→A | `sess.req {nonceD, ts, sig = Sign_D(T("rc/sess-req/v1", channelId, nonceD, ts))}` (com `|now−ts| ≤ 2 min`) |
| — | A | verifica a assinatura com a chave fixada → pede consentimento no app → diálogo de captura de tela do Android → sobe o foreground service (indicador visível) |
| 2 | A→D | `sess.accept {token, nonceA, sig = Sign_A(T("rc/sess-accept/v1", channelId, nonceD, nonceA, sid, desktopFp, androidFp, iat, exp))}` com token `{sid, desktopFp, androidFp, iat, exp = iat + 12h}` |
| 3 | A→D | `sdp {sid, type:"offer", sdp, sig = Sign_A(T("rc/sdp/v1", sid, "android", "offer", F))}` |
| 4 | D→A | `sdp {sid, type:"answer", sdp, sig = Sign_D(T("rc/sdp/v1", sid, "desktop", "answer", F))}` |
| * | ⇄ | `ice {sid, candidate, sdpMid, sdpMLineIndex}` (sem assinatura: o DTLS já está amarrado à identidade) |
| — | ⇄ | `sess.end {sid, reason}` com `reason ∈ user, revoked, expired, error` |

`F` = linhas `a=fingerprint:` do SDP, normalizadas (minúsculas, únicas, ordenadas, separadas por `\n`).
Assinar o fingerprint DTLS com a chave de identidade **amarra a conexão criptografada (DTLS/SRTP) ao dispositivo pareado**: nem o servidor de sinalização nem o TURN conseguem fazer MITM.

**Retomada** (troca de rede): `sess.resume {sid, nonceD, ts, sig = Sign_D(T("rc/sess-resume/v1", channelId, sid, nonceD, ts))}`. Se o `sid` ainda estiver ativo e o token válido, o celular gera uma nova oferta com ICE restart, sem novo consentimento: o indicador nunca saiu da tela. Se o `sid` for desconhecido (por exemplo, o app foi reiniciado), o celular responde `sess.end {reason: "expired"}`.

**Reconexão automática.** O celular é quem faz a oferta, então é ele que conduz a recuperação:

| Gatilho | Ação |
|---|---|
| Rede padrão do Android muda (Wi-Fi ⇄ dados móveis) | ICE restart proativo e imediato |
| `connectionState` = `failed` | ICE restart imediato e depois a cada 4 s |
| `connectionState` = `disconnected` | Espera 2 s (pode se recuperar sozinho) e então ICE restart a cada 4 s |
| Sinalização reconecta durante uma queda | ICE restart |
| `sess.resume` do desktop (desktop sem link por mais de 3 s, repetido a cada 6 s) | ICE restart |

- Os restarts têm intervalo mínimo de 2,5 s, e o loop de tentativas consulta o estado real do PeerConnection, porque um restart pode curar o link sem disparar um novo evento.
- Se o link não voltar em **90 s**, os dois lados encerram com `reason: "lost"`.
- A queda da sinalização sozinha não encerra nem marca a sessão como caída: o link P2P continua. O cliente do desktop reconecta com backoff de até 5 s; o do celular, até 10 s.
- Cada queda recuperada incrementa `reconnects` no log da sessão, nos dois lados.

Verificado no emulador:

| Cenário | Resultado |
|---|---|
| Wi-Fi → LTE | ~2,5 s sem frames |
| LTE → Wi-Fi | Sem interrupção |
| Servidor de sinalização reiniciado | Sessão intacta |
| Queda total de ~20 s | Recuperação ~2 s depois da volta da rede |
| Queda acima de 90 s | `lost` nos dois lados |

## 5. Transporte USB

Com o celular no cabo e a Depuração USB autorizada, a sessão pode passar inteira pelo cabo, sem Wi-Fi nem servidor de sinalização. O protocolo das seções 3 e 4 não muda: só o caminho dos bytes muda.

```
celular localhost:38787 ──adb reverse──▶ desktop 127.0.0.1:<porta livre>  sinalização embutida (mesmo código de apps/signaling)
celular localhost:38788 ──adb reverse──▶ desktop 127.0.0.1:<porta livre>  relay TURN-TCP embutido
```

- **Desktop** (`apps/desktop/src/main/usb/`): sobe a sinalização e o relay só em loopback. A cada 2 s, `adb devices` aplica os dois `adb reverse` em cada aparelho autorizado. Usa o adb do sistema, se houver; senão, o que vem no instalador.
- **Celular**: com **Ficar disponível** ligado, mantém um segundo cliente de sinalização em `ws://127.0.0.1:38787` (backoff de no máximo 2 s) e entra nas mesmas salas nos dois links.
- **Escolha do link**: o desktop entra na sala nos dois servidores e **prefere o USB**. Se o celular aparecer primeiro pela rede, o desktop espera 400 ms pelo cabo antes de mandar o `sess.req`. O celular responde pelo link em que o pedido chegou, e a sessão fica presa a ele: `sdp`, `ice`, `sess.resume` e `sess.end` só valem por esse link. Plugar o cabo no meio de uma sessão pela rede só vale para a próxima sessão.
- **Mídia**: os dois lados usam `iceTransportPolicy = relay` com o relay local. O relay implementa um subconjunto da RFC 8656 sobre TCP (Allocate, Refresh, CreatePermission, ChannelBind, Send/Data e ChannelData). Os endereços relayed são virtuais (`192.0.2.1:<porta>`): os dados só passam entre alocações do próprio relay, sem sockets UDP. As credenciais são as da TURN REST API (seção 2), com um segredo aleatório por execução do desktop.
- **Garantias**: as mesmas. DTLS/SRTP continua amarrado às chaves pareadas pelo SDP assinado. A porta 38787 no celular fica aberta para qualquer app local enquanto o cabo está ligado, e a sinalização e o relay do desktop aceitam qualquer processo local, mas nenhum deles consegue forjar `sess.req`, `sess.accept` ou o SDP. O pior que conseguem é atrapalhar a conexão, como um servidor de sinalização hostil.
- A sessão pelo cabo aparece como **USB** nos dois lados (pílula no desktop, "via USB" no celular). O monitor de troca de rede do celular fica desligado nela.

## 6. DataChannels (criados pelo celular)

| Label | Entrega | Uso |
|---|---|---|
| `control` | não ordenado, `maxRetransmits: 0` | `pm` (movimento de ponteiro) |
| `control-r` | confiável e ordenado | `pd`, `pu`, `scroll`, `global`, `text`, `edit` |
| `session` | confiável | `screen`, `quality`, `quality-applied`, `hb`, `end` |
| `chat` | confiável | `msg {id, text, ts}` e recibo `ack {id}` |
| `file` | confiável | quadros JSON de controle + quadros binários de dados |

Coordenadas são normalizadas em `[0,1]` relativas à tela atual (já considerando a rotação).
Esquemas em `packages/protocol/src/channels.ts`.

**Qualidade** (canal `session`):

| Preset | Lado maior | FPS | Bitrate máx. | Degradação |
|---|---|---|---|---|
| `high` | 1920 px | 60 | 8 Mbps | balanceada |
| `medium` | 1280 px | 30 | 2,5 Mbps | balanceada |
| `low` | 960 px | 24 | 0,8 Mbps | mantém o FPS |

- O desktop manda `quality {preset}`. O celular redimensiona o VirtualDisplay (sem recriá-lo, ver `ProjectionCapturer`), ajusta `RtpSender.setParameters` e confirma com `quality-applied {preset, w, h, fps, maxBitrate}`.
- A cada segundo o celular envia `sender-stats {availableBitrate, rttMs, encodeFps, qualityLimitation}`, que é a estimativa de banda do WebRTC, disponível só no lado que envia.
- **Modo Auto** (`qualityController.ts`, no desktop) começa em Média e combina perda de pacotes e buffer de jitter do intervalo, RTT, banda estimada e limitação de banda do encoder:
  - Desce um nível após 3 s ruins: perda acima de 4%, RTT acima de 300 ms, buffer acima de 200 ms, ou limitação de banda com estimativa abaixo de 60% do teto.
  - Sobe um nível após 10 s bons: perda abaixo de 1%, RTT abaixo de 150 ms, buffer abaixo de 100 ms e banda de pelo menos 90% do teto atual.
  - Se a subida falha em até 20 s, a próxima espera dobra, até 2 min. Há sempre pelo menos 4 s entre mudanças.
- A limitação por CPU do encoder é ignorada de propósito: o WebRTC já reduz a resolução dentro do nível, e esse sinal fica "grudado" em telas quase paradas.

**Transferência de arquivos** (qualquer direção, vários arquivos em paralelo):

1. `offer {id, name, size, mime}`: `id` é aleatório (16 bytes em hex), limite de 2 GiB.
2. O receptor responde `accept {id}`, ou `reject {id, reason}` se o arquivo for grande demais ou não houver armazenamento.
3. O emissor manda quadros binários de até 16 KiB: os 16 bytes do `id` seguidos de até 16 368 bytes de dados. Há contrapressão: o emissor espera quando há mais de 4 MiB na fila do canal.
4. O emissor manda `done {id, sha256}`. O receptor compara com o hash calculado durante o recebimento e responde `ack {id, ok}`.
5. `cancel {id, reason}`, de qualquer lado, interrompe a transferência; o receptor apaga o parcial.

O receptor reduz `name` a um nome-base seguro (`safeFileName`: sem diretórios, caracteres reservados ou nomes de dispositivo do Windows) e descarta a transferência se receber mais bytes que `size`. O arquivo só aparece com o nome final depois que o hash confere:

- Desktop: `Downloads/Remote Controller/<nome>.part`, renomeado no final.
- Android: MediaStore em `Download/Remote Controller` com `IS_PENDING`.

Arquivos recebidos nunca são abertos automaticamente. O histórico do chat fica salvo localmente nos dois lados, por dispositivo pareado, e é apagado quando o dispositivo é removido.

## 7. Garantias e limites

- **Sem sessão silenciosa**: toda sessão exige aceite no app e o diálogo de captura de tela do sistema (o Android 14+ exige isso a cada sessão).
- **Indicador**: notificação de foreground service com "Encerrar agora" (reaparece se for dispensada) + overlay de acessibilidade "Controle remoto ativo" + o indicador de captura de tela do próprio sistema.
- **Revogação**: "Encerrar agora" ou "Revogar acesso" agem localmente e na hora (fecham a captura e o PeerConnection) e depois avisam o desktop.
- **Replay**: `sess.req` e `sess.resume` têm timestamp com janela de ±2 min e são vinculados ao `channelId`; `sess.accept` é vinculado ao `nonceD` do pedido.
- **Força do código de pareamento**: 80 bits com TTL de 2 min, mais o SAS. O servidor vê MACs, mas não consegue quebrar 2^80 offline dentro do TTL.
