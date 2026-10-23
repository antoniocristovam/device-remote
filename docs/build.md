# Build e distribuição

## Desktop

| Plataforma | Comando (em `apps/desktop`) | Saída em `apps/desktop/release/<versão>/` |
|---|---|---|
| Windows | `npm run dist:win` | `Remote Controller-<v>-win-x64.exe` (instalador NSIS) |
| macOS (somente em um Mac) | `npm run dist:mac` | `.dmg` e `.zip` para `arm64` e `x64` |
| Pasta sem instalador | `npm run dist:dir` | `win-unpacked/` ou `mac*/Remote Controller.app` |

Antes disso, na raiz: `npm ci && npm run build:packages`.

- Toda a configuração fica em `apps/desktop/electron-builder.yml`.
- O ícone vem de `build/icon.svg`. `npm run icon` o converte em `build/icon.png` (1024 px) usando o próprio Electron, e o electron-builder deriva o `.icns` e o `.ico` a partir desse PNG.
- O electron-builder não gera builds de macOS a partir do Windows ou do Linux. Para isso existe o CI (`.github/workflows/build.yml`), que roda num runner `macos-14`.

### macOS: assinatura e notarização

| Situação | Variáveis | Resultado |
|---|---|---|
| Sem certificado (padrão no CI) | nenhuma | Assinatura ad-hoc, sem hardened runtime e sem notarização. O app roda, mas o Gatekeeper bloqueia o primeiro uso: abra com **clique direito › Abrir**, ou rode `xattr -dr com.apple.quarantine "/Applications/Remote Controller.app"`. |
| Developer ID | `CSC_LINK` (o `.p12` em base64 ou um caminho) e `CSC_KEY_PASSWORD` | Assinado, com hardened runtime e os entitlements de `build/entitlements.mac.plist` |
| + notarização | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` (ou `APPLE_API_KEY`, `APPLE_API_KEY_ID` e `APPLE_API_ISSUER`) | Notarizado automaticamente pelo electron-builder; abre sem aviso |

No CI, cadastre como secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. O passo "Verify macOS bundle" confere três coisas:

- a assinatura, com `codesign --verify --deep --strict`;
- os entitlements;
- a chave `NSLocalNetworkUsageDescription` e a arquitetura, com `lipo`.

**Entitlements:** só `allow-jit` e `allow-unsigned-executable-memory`, que o V8/Electron exige. Não há câmera, microfone nem gravação de tela: o desktop só *exibe* a tela do celular e nunca captura a do Mac.

### Windows: assinatura

`WIN_CSC_LINK` e `WIN_CSC_KEY_PASSWORD` (certificado Authenticode). Sem eles, o instalador sai sem assinatura e o SmartScreen mostra "Editor desconhecido".

## Diferenças de comportamento no macOS

| Tema | macOS | Windows |
|---|---|---|
| Barra de título | Botões nativos de semáforo; o conteúdo começa depois deles | Overlay com os botões do Windows, em cor do tema |
| Menu | Menu nativo em português: App, Editar, Visualizar, Janela. Cmd+, abre Ajustes, Cmd+Y o Histórico, Cmd+N o Pareamento | Sem menu (barra customizada) |
| Copiar e colar | Os itens de Editar passam pelo renderer: com a tela do celular em foco, Cmd+C/X/A vão para o celular e Cmd+V cola o texto da área de transferência do Mac no celular. Em campos locais, como o chat, a ação é a nativa | Mesmo comportamento com Ctrl |
| Fechar a janela | O app continua no Dock, como é padrão no macOS; qualquer sessão aberta é encerrada junto com a janela | Fecha o app |
| Chave de identidade | Keychain, via `safeStorage`. Sem Developer ID, o macOS pede permissão ("…quer usar informações confidenciais…") na primeira execução | DPAPI |
| Rede local | O macOS 15+ pergunta se o app pode acessar a rede local, com o texto de `NSLocalNetworkUsageDescription`. Sem essa permissão, o servidor de sinalização na LAN e a conexão P2P falham | Firewall do Windows: libere a porta do servidor de sinalização |
| Teclas compostas | Option+C → "ç" e similares chegam como texto | AltGr (por exemplo, `@` e `/` no ABNT2) chega como texto |

## Android

- `apps/android-app`: `npx react-native run-android`, ou um APK de debug com `./gradlew :app:assembleDebug` em `android/`.
- O CI gera o APK de debug, roda os testes JUnit de interoperabilidade e faz a verificação reversa em TypeScript.
- Ainda não há configuração de release com keystore própria; por enquanto o APK de release usa a chave de debug do template.
