# Remote Controller

Controle remoto de Android a partir do computador (Windows primeiro, macOS depois), com consentimento explícito, indicador sempre visível e revogação instantânea no celular.

```
packages/protocol      Esquemas zod: sinalização, mensagens E2E, DataChannels
packages/crypto-proto  Handshake de pareamento e sessão (referência TS; espelhado em Kotlin)
apps/signaling         Servidor de sinalização (Node + ws) com credenciais TURN efêmeras
apps/desktop           Controlador: Electron + React + Tailwind
apps/android-app       Dispositivo controlado: React Native (UI) + Kotlin (Keystore, WebRTC, MediaProjection, Acessibilidade)
infra/                 docker-compose com sinalização + coturn
docs/protocol.md       Especificação do protocolo e das garantias de segurança
docs/build.md          Build, assinatura e diferenças por plataforma (macOS/Windows)
.github/workflows/     CI: testes, APK Android, instaladores macOS e Windows
scripts/               Vetores de teste entre linguagens e um "desktop falso" para testes
```

## Rodando localmente

Pré-requisitos: Node 22+, JDK 17, Android SDK (API 37) e um aparelho ou emulador.

```bash
npm install
```

```bash
npm run build:packages
```

```bash
npm run dev:signaling
```

```bash
npm run dev:desktop
```

Android (em outro terminal, dentro de `apps/android-app`):

```bash
npx react-native run-android
```

Em rede local, o QR code do desktop troca `localhost` pelo IP da máquina, então o celular precisa alcançar a porta 8787 do PC (libere-a no firewall do Windows). No emulador, `adb reverse tcp:8787 tcp:8787` e `ws://localhost:8787` em Ajustes.

Fluxo: no desktop, **Parear dispositivo** → no celular, **Escanear QR code** (ou digitar o código) → confirmar que o código de 6 dígitos é o mesmo → **Aceitar e parear**. Para conectar: no celular, ative **Ficar disponível**; no desktop, **Conectar**; no celular, **Aceitar** e depois **Compartilhar tela**. Para tocar e digitar, ative o serviço "Remote Controller" em Acessibilidade.

## Testes

```bash
npm test
```

Interoperabilidade TS ⇄ Kotlin (ver `docs/protocol.md`):

```bash
node scripts/gen-test-vectors.mjs
```

```bash
cd apps/android-app/android && ./gradlew :app:testDebugUnitTest && cd ../../.. && node scripts/verify-android-vectors.mjs
```

## Status por fase

- **Fase 0 (fundação)** ✅: monorepo, protocolo, sinalização com testes, coturn.
- **Fase 1 (pareamento + vídeo + controle)** ✅ verificada no emulador: pareamento com SAS, sessão com consentimento duplo, vídeo WebRTC com encoder por hardware (com fallback em software), indicadores, revogação e logs nos dois lados. Controle verificado no emulador: toques (10/10), arrastar, roda do mouse, digitação com acentos, Backspace, Enter, Ctrl+A, Voltar/Início/Recentes/Notificações, Esc e botão direito.
- **Fase 2 (chat + arquivos)** ✅ verificada no emulador: chat nos dois sentidos com recibo de entrega e histórico local; arquivos nos dois sentidos (botão de anexo, arrastar e soltar no desktop, seletor de documentos no Android), com SHA-256 conferido, vários em paralelo e cancelamento com remoção do parcial.
- **Fase 3 (qualidade)** ✅ verificada no emulador: seletor Auto/Alta/Média/Baixa (lembrado entre sessões), presets aplicados ao vivo sem recriar a captura, modo Auto que desceu de Alta a Baixa com a rede limitada (1,5 Mbps + 200 ms) e voltou a Alta ao normalizar.
- **Fase 4 (reconexão + histórico)** ✅ verificada no emulador: ICE restart automático na troca Wi-Fi ⇄ dados móveis (~2,5 s sem imagem; no sentido inverso, sem interrupção), sessão intacta com o servidor de sinalização reiniciado, recuperação após queda total de rede e encerramento como "Conexão perdida" depois de 90 s. Histórico revisado nos dois lados: totais, filtro por dispositivo, agrupamento por dia, reconexões, motivo do encerramento e atualização ao vivo.
- **Fase 5 (macOS + build)** ✅ empacotamento com electron-builder (NSIS no Windows; DMG + ZIP arm64/x64 no macOS), ícone, entitlements mínimos, `NSLocalNetworkUsageDescription`, menu nativo do macOS com roteamento de Cmd+C/V/X/A para o celular, sessão encerrada ao fechar a janela, Option/AltGr preservados, colar do clipboard local no celular. Instalador do Windows gerado e app empacotado verificado localmente; o build do macOS roda no CI (`.github/workflows/build.yml`, runner `macos-14`) e **ainda não foi executado**. Veja [docs/build.md](docs/build.md).
