# TelaViva

Compartilhamento de **tela ao vivo** em salas privadas, feito para grupos pequenos (por exemplo, amigos jogando e
conversando no Discord). Login com e-mail e senha, 3 salas fixas, vídeo por **WebRTC** direto entre os participantes
e, com o **app desktop**, áudio por programa **sem o som do Discord**.

> O servidor só faz login, salas e sinalização. **Nenhum vídeo ou áudio passa por ele nem é gravado.**

## Recursos

- **3 salas fixas** (sem criar/digitar código): até 8 pessoas e 3 transmissões simultâneas por sala.
- Qualidade **720p30, 1080p30 e 1080p60**, com prioridade *fluidez* (reduz a resolução antes do FPS) ou *nitidez*.
- Divisão automática do **upload** entre os espectadores (mede o upload ao entrar na sala) e piso de bitrate, para a
  resolução não oscilar.
- **Som**: sem som, com som do computador, ou **com som sem o Discord** (app desktop, Linux e Windows).
- **Mixer** por programa (app desktop): volume que *você* ouve × volume enviado à transmissão, independentes.
- Trocar a própria senha na interface; **relatórios de erro** opcionais (ou automáticos no app desktop) gravados em `data/logs/`.

## Início rápido

Requisitos: **Node.js 20+** e um navegador recente (Chrome, Edge ou Firefox).

```bash
npm install
cp .env.example .env            # edite SESSION_SECRET (openssl rand -hex 32)
npm run criar-usuario           # cadastra e-mail e senha (mínimo 10 caracteres)
npm start                       # http://localhost:3000
```

Cada pessoa precisa de uma conta (`npm run criar-usuario`). Para trocar uma senha pelo terminal: `npm run alterar-senha`
(ou pela própria interface, em *Alterar senha*).

## Configuração (`.env`)

| Variável | Para quê |
|---|---|
| `SESSION_SECRET` | Chave longa e aleatória das sessões (obrigatória em produção). |
| `PORT`, `HOST` | Porta e interface (`HOST=127.0.0.1` atrás de proxy reverso). |
| `NODE_ENV` | `production` exige HTTPS (cookie de sessão `secure`). |
| `DATA_DIR` | Pasta de `users.json` e `logs/` (padrão `./data`). |
| `ROOM_NAMES` | Nomes das 3 salas, separados por vírgula. |
| `ICE_SERVERS_JSON` | Servidores STUN/TURN (veja [docs/DEPLOY.md](docs/DEPLOY.md)). |

## App desktop (áudio sem Discord)

Um navegador **não** consegue separar o áudio de um programa do resto do sistema. O app em [`desktop/`](desktop/) (Electron,
versão *portable* para Windows e Linux) abre o seu servidor TelaViva e faz isso no nível do sistema operacional:

- **Linux**: cada programa ganha uma saída virtual (PipeWire/PulseAudio) com dois caminhos: seu fone e a transmissão.
- **Windows**: helper nativo em C++ ([`desktop/native/win`](desktop/native/win)) com a *Process Loopback API*
  (Windows 10 versão 2004+).

Instruções de build em [desktop/README.md](desktop/README.md).

## Como funciona

```
navegador/app ──login, salas, sinalização (Socket.IO)──► servidor Node (Express)
      ▲                                                        │
      └──────────── vídeo e áudio WebRTC (P2P) ◄───────────────┘  (TURN só quando a rede exige)
```

Cada espectador recebe um fluxo próprio do transmissor (malha P2P): **o upload e a CPU de quem transmite crescem com o
número de espectadores**. Para grupos maiores, o caminho seria um servidor intermediário (SFU), que não faz parte deste projeto.

## Segurança e privacidade

- Senhas com hash `scrypt`; sessões em cookie `HttpOnly`; limitação de tentativas de login, troca de senha e relatórios.
- A captura só começa após clique e permissão explícitas; não há controle remoto, gravação nem acesso a arquivos.
- `data/` (contas e logs) e `.env` **nunca** devem ir para o repositório (já estão no `.gitignore`).
- Relatórios de erro contêm apenas informação técnica (eventos, versões, estado da conexão), nunca imagem, áudio ou senha.
- O armazenamento de sessões é em memória: um reinício do servidor desloga todos. Para vários processos, use Redis ou similar.
- Projeto de uso entre amigos, **não auditado** para exposição ampla. Revise antes de abrir ao público.

## Testes

```bash
npm test     # API HTTP (login, trocar senha, relatórios, teste de upload) e utilitários do front-end
```

## Estrutura

```
server.js          Express + Socket.IO (login, salas fixas, sinalização, relatórios)
public/            interface (index.html, app.js, styles.css, pcm-worklet.js)
scripts/           criar-usuario, alterar-senha e scripts de áudio virtual para Ubuntu (uso sem o app desktop)
tests/             testes (node --test)
docs/DEPLOY.md    HTTPS, proxy reverso, TURN e systemd
desktop/           app Electron + helper de áudio do Windows
```

## Autor

Criado e mantido por **Filipe F. Nunes** ([@CocaOrMilk](https://github.com/CocaOrMilk)). Dúvidas e sugestões: abra uma *issue*.

## Limitações conhecidas

- Malha P2P (veja acima) e sem SFU; para redes restritivas é necessário um servidor **TURN**.
- A captura de áudio do sistema por navegador varia muito entre sistemas; o app desktop existe por isso.
- O `.exe` do Windows não é assinado (o SmartScreen avisa na primeira execução).
- Ainda não há licença definida: defina uma antes de redistribuir.
