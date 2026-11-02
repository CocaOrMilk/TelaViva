# TelaViva Desktop (protótipo 0.2)

Cliente portable que abre o seu servidor TelaViva (endereço padrão `http://localhost:3000/`; altere em **TelaViva → Alterar endereço do servidor…** ou com a variável `TELAVIVA_URL`) e adiciona **áudio da transmissão sem o Discord**, com mixer
por programa (volume que você ouve × volume enviado).

- Linux: `TelaViva-*-linux-x86_64.AppImage` (precisa de `libfuse2t64`) ou `.tar.gz` (rodar `TelaViva.sh`).
- Windows: `TelaViva-*-windows-portable.exe` (Windows 10 versão 2004 ou mais nova).

## Como o áudio funciona
**Linux** (`src/linux-audio.js`): cada programa ganha uma saída virtual própria; dela saem dois caminhos
(seu fone e a transmissão), com volumes independentes. Discord e o TelaViva ficam de fora.

**Windows** (`src/win-audio.js` + `native/win/tv-audio-win.cpp`): o helper `tv-audio-win.exe` usa a
Process Loopback API: captura **cada programa que está tocando** separadamente, aplica o volume da
transmissão e manda o áudio mixado ao app (stdout). O Discord (e o TelaViva) nunca são capturados.
- "Transmissão" = ganho aplicado pelo helper (independente do que você ouve).
- "Meu som" = volume do programa no mixer do Windows (até 100%).
- Se o Discord fechar ou abrir durante a live, nada muda: ele simplesmente nunca é capturado.

## Relatórios de erro automáticos
O app envia sozinho ao servidor (`/api/report`, vai para `/var/lib/telaviva/logs/telaviva.log`) um relatório técnico quando algo
dá errado: erro não tratado, janela ou processo interno que encerra, falha do helper de áudio, servidor que não abre e erros
da página. Vai só: eventos do app, versão do app/Electron/Windows, estado do áudio. Nunca imagem, áudio ou senha.
- Se a pessoa ainda não fez login, o relatório fica numa fila local (`pending-reports.json`) e é enviado assim que ela entrar.
- Limites: o mesmo problema só é reenviado após 5 min; no máximo 8 por hora.
- Desligar: menu **TelaViva → Enviar relatórios de erro automaticamente**.

## Desenvolvimento
```bash
npm install
npm start                          # electron . --no-sandbox
node scripts/test-audio-linux.js   # roteamento do Linux
bash native/win/build.sh           # compila o helper do Windows (mingw-w64: sudo apt install g++-mingw-w64-x86-64-posix)
npm run dist:linux                 # AppImage + tar.gz
npm run dist:win                   # .exe portable (inclui o helper)
```
Testar o caminho do Windows no Linux (helper sob Wine, áudio sintético):
`TV_FORCE_WIN_AUDIO=1 TV_AUDIO_SYNTHETIC=1 TV_AUDIO_HELPER_CMD=/caminho/wine-helper.sh npm start`

Estrutura: `src/main.js` (janela, seletor de tela, menu), `src/linux-audio.js`, `src/win-audio.js`,
`src/preload.js` (API `window.telavivaDesktop` para o site), `native/win/` (helper C++).
