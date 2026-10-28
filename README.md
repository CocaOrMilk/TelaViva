# Tela Viva — site de compartilhamento de tela com login

Protótipo funcional de compartilhamento de tela **ao vivo** no navegador, com autenticação, sala por convite e transmissão WebRTC. Na v1.4 há captura de **janela/tela com áudio nativo quando o navegador permite**, sem remover os modos seletivos que evitam o áudio do Discord. Interface em português, responsiva e com controles para iniciar/parar a transmissão.

## Requisitos

- Ubuntu, Windows ou macOS
- **Node.js 20 ou superior** e npm
- Navegador recente (Chrome, Edge ou Firefox)

## Executar no Ubuntu

Abra um terminal dentro da pasta do projeto:

```bash
npm install
cp .env.example .env
```

Edite o arquivo `.env` e substitua `SESSION_SECRET` por uma chave aleatória gerada assim:

```bash
openssl rand -hex 32
```

Agora cadastre o primeiro usuário:

```bash
npm run criar-usuario
```

O terminal solicitará o e-mail e uma senha de **pelo menos 10 caracteres**. A senha não ficará visível enquanto você digita e será armazenada como hash com scrypt em `data/users.json`.

Inicie o servidor:

```bash
npm start
```

Abra **http://localhost:3000** no navegador. Entre com o e-mail e senha criados. Clique em **Criar sala**, depois em **Iniciar compartilhamento**, e escolha a tela/janela autorizada pelo navegador.

Para adicionar outras contas, execute `npm run criar-usuario` novamente. **Cada participante deve fazer login** para acessar uma sala.

### Trocar a senha de um usuário já cadastrado

No terminal aberto na pasta do TelaViva, execute:

```bash
npm run alterar-senha
```

Digite o e-mail cadastrado, a nova senha (mínimo 10 caracteres) e confirme. A conta mantém o mesmo identificador e a senha é novamente armazenada com hash `scrypt` em `data/users.json`. Não é necessário alterar `SESSION_SECRET` nem apagar a conta. Este comando redefine **somente** a senha do login TelaViva, não a senha do serviço de e-mail. Execute apenas no servidor, por uma pessoa autorizada a administrar as contas.


## Como convidar pessoas

1. Crie uma sala e clique em **Copiar link de convite**.
2. Envie o link para a pessoa, que precisa ter uma conta criada pelo administrador.
3. Ela faz login e entra na sala. Se abriu o convite, o código é preenchido automaticamente.
4. Quando você clicar em **Iniciar compartilhamento**, o navegador pedirá sua autorização. A outra pessoa começará a assistir.
5. Você pode interromper usando **Parar compartilhamento** ou o botão do próprio navegador.

**Para duas abas no mesmo computador:** use a primeira aba como apresentador e uma janela anônima como espectador, ambas autenticadas; isso permite verificar a interface e a sinalização localmente.

## Uso por outras pessoas na internet

`http://localhost:3000` só funciona no seu próprio computador. Para acesso externo, publique o Node.js em um servidor e configure:

- **HTTPS obrigatório** para captura de tela em sites publicados (localhost é uma exceção de desenvolvimento).
- Proxy reverso compatível com WebSocket, por exemplo Nginx ou Caddy.
- Serviço **TURN** com credenciais, como coturn, se quiser estabilidade entre redes diferentes. Configure `ICE_SERVERS_JSON` no `.env` com o STUN/TURN utilizado.
- `NODE_ENV=production` e `SESSION_SECRET` forte, com cookie seguro sobre HTTPS.
- Um armazenamento persistente de sessões (por exemplo Redis) no lugar do MemoryStore, antes de atender múltiplos usuários de forma estável.
- Controle de contas e revisão de segurança do sistema para exposição pública.

O aplicativo é um **protótipo de demonstração**, não uma plataforma auditada para ambientes sensíveis ou produção em larga escala. O servidor de sinalização **não grava nem armazena vídeo**; o fluxo vai pelo WebRTC entre navegadores (ou por um servidor TURN, quando necessário). O servidor mantém as salas apenas em memória e as encerra quando todos saem. O limite é de **8 participantes por sala**; não foi otimizado para transmissões grandes.

## Segurança e privacidade

- Apenas pessoas autenticadas, com o código da sala, podem entrar.
- Senhas são protegidas por hash scrypt e sessões usam cookie `HttpOnly`.
- A captura só começa após um **clique e permissão explícita** do usuário.
- O compartilhamento pode ser interrompido a qualquer momento.
- Não há controle remoto do computador, gravação automática, acesso a arquivos ou coleta de teclas.
- Nunca compartilhe uma tela contendo senhas, documentos privados ou informações pessoais.
- O link é um convite à sala, não um substituto para uma conta de login.

## Estrutura

```text
tela-viva/
├── server.js               # Express, login, salas e sinalização Socket.IO
├── scripts/create-user.js  # Cadastro de contas pela linha de comando
├── public/
│   ├── index.html          # Interface de login e salas
│   ├── styles.css          # Design responsivo
│   └── app.js              # WebRTC e interação do usuário
├── data/                   # Usuários locais (criados na primeira execução)
├── .env.example            # Modelo de configuração
└── package.json
```

---

# Versão 1.1 — tela COM áudio e Discord de fora

Na versão 1.1, o site não capturava áudio geral. Na versão 1.3, existe um modo nativo opcional que pode capturá-lo. O modo seletivo **não captura o áudio geral do sistema** e **não possui um filtro que identifica o Discord automaticamente**: em vez disso, permite escolher uma fonte que não contenha o áudio do Discord.

## Modos seletivos disponíveis na sala (sem Discord)

1. **Aba com vídeo e áudio**: clique em Compartilhar, selecione uma ABA (não janela nem monitor) e marque **Compartilhar áudio da aba** no seletor do navegador. Esta fonte não captura o Discord instalado no sistema. Se você selecionar uma aba do Discord Web, o som dessa aba será incluído. Se a aba não fornecer áudio, a transmissão não começa.
2. **Tela inteira + áudio de uma aba**: clique em Compartilhar, escolha a tela/janela (primeira permissão). Depois clique em **2. Selecionar áudio** e escolha a aba com o áudio desejado (segunda permissão). O vídeo é da tela, mas o som só vem da aba; o áudio do sistema inteiro não é enviado. O modo depende do navegador permitir áudio de abas.
3. **Tela inteira + áudio virtual isolado**: use com programas nativos e jogos no Ubuntu. Primeiro crie `TelaVivaAudio`/`TelaVivaFonte` com o script abaixo; mantenha Discord na saída física/padrão e mova os **demais programas que deseja compartilhar** para a saída virtual. Na sala escolha esse modo, clique em **Identificar nomes das entradas** (permite o microfone momentaneamente apenas para mostrar os nomes; a captura é encerrada sem transmitir), selecione **TelaVivaFonte**, escolha a tela e depois clique em **2. Selecionar áudio**. Somente a entrada virtual é enviada.

### Configurar áudio isolado no Ubuntu (PipeWire ou PulseAudio)

Verifique primeiro se o áudio do Ubuntu está funcionando normalmente. Rode:

```bash
sudo apt install pavucontrol pulseaudio-utils
bash scripts/audio-ubuntu-iniciar.sh
pavucontrol
```

Na aba **Reprodução** do `pavucontrol`, reproduza um som no jogo ou programa desejado; em seu seletor de saída escolha **TelaVivaAudio**. Repita nos programas que quiser transmitir. **Deixe o Discord na saída real/padrão do computador, nunca em TelaVivaAudio**. A entrada **TelaVivaFonte**, criada pelo script, representa o monitor apenas dessa saída virtual. Um loopback permite ouvir esses programas no fone/alto-falante padrão ao mesmo tempo.

Depois, atualize o site, selecione **Tela inteira + áudio virtual isolado** e siga a sequência indicada. Se não encontrar `TelaVivaFonte`, pressione **Identificar nomes das entradas**. Confira em uma segunda conta se o jogo é ouvido e se sons do Discord **não** são transmitidos antes de convidar pessoas.

Para remover os módulos criados nesta sessão:

```bash
bash scripts/audio-ubuntu-parar.sh
```

**Atenção:** esses comandos não escolhem automaticamente quais programas entram na transmissão. A separação é configurada manualmente no sistema. Se o Discord for transferido para `TelaVivaAudio`, ele também poderá ser transmitido. Se o dispositivo padrão for alterado depois de criar a rota, revise o loopback. Os módulos virtuais desta implementação não são permanentes após reiniciar o serviço de áudio/sistema; rode novamente o script quando necessário. O modo "áudio virtual" foi preparado especificamente para Ubuntu e a fonte criada por este script. Não é uma solução de roteamento pronta para Windows/macOS.

### Por que são necessárias duas permissões em alguns modos?

Navegadores modernos exigem interação direta do usuário para cada chamada de captura de tela (`getDisplayMedia`). O projeto não tenta burlar essa permissão: a escolha do vídeo e a escolha do áudio da aba são dois botões diferentes. Se cancelar o áudio, a transmissão ainda não começa. O usuário pode cancelar a pré-seleção da tela a qualquer momento.

### Limitações

- O modo de aba depende de **Chrome/Chromium/Edge** e do suporte do navegador/OS a áudio de abas. Não assegura áudio no Firefox ou em todas as configurações Linux.
- O browser não tem acesso para "descontar o som do Discord" do áudio geral. A exclusão depende de uma origem isolada que não contenha Discord.
- A opção `systemAudio: 'exclude'` ajuda a não capturar áudio geral, mas os navegadores têm diferenças. Por segurança o app também **rejeita** fontes que não sejam aba quando a intenção é capturar áudio de aba.
- Em fontes virtuais, o aplicativo permite transmitir apenas a entrada identificada como `TelaVivaFonte`. A transmissão nunca usa automaticamente o microfone do usuário.
- A fonte virtual pode precisar de configuração adicional ou drivers específicos dependendo da versão do sistema de som.
- A transmissão local começa após obter uma fonte de vídeo válida e, quando solicitado, uma fonte de áudio válida; é possível optar por compartilhar sem som. O apresentador vê sua prévia **sem som** para evitar retorno.
- O projeto ainda precisa de HTTPS, TURN e testes de segurança para disponibilização na internet.


---

# Versão 1.2 — qualidade de transmissão ajustável

O seletor **Qualidade da transmissão** aparece na sala antes de compartilhar a tela. Perfis:

| Opção | Resolução solicitada | FPS desejado | Teto de bitrate de vídeo por espectador |
|---|---|---|---|
| HD | 1280 × 720 | 30 FPS | 3 Mb/s |
| Full HD | 1920 × 1080 | 30 FPS | 6 Mb/s |
| Full HD fluido | 1920 × 1080 | 60 FPS | 10 Mb/s |

**Padrão:** Full HD / 30 FPS. Escolha o perfil **antes de clicar em Compartilhar minha tela**. Para mudar durante uma transmissão, pare e inicie novamente. O seletor é desativado enquanto há uma captura pendente ou uma transmissão ativa.

A captura solicita resolução e taxa de quadros ao navegador e tenta aplicar essas restrições no track de vídeo. Para enviar aos participantes, a conexão WebRTC recebe um teto de bitrate (`RTCRtpSender`/`sendEncodings`) e um fator de redução quando a fonte original exceder a resolução escolhida. Se o navegador não suportar esses controles, a transmissão continua com o melhor esforço disponível. **Full HD/60 FPS não é garantido**, especialmente com telas menores, navegadores incompatíveis, conexão lenta ou muitos participantes.

O rodapé do vídeo mostra estatísticas WebRTC de envio (para um espectador conectado) ou recebimento, conforme os dados disponibilizados por `getStats()`: resolução real, FPS e taxa de dados de vídeo estimada. O número apresentado pode ficar vazio até haver dados suficientes. **A taxa de bitrate é um teto**, não um valor fixo.

Como a arquitetura é P2P, o upload total cresce com a quantidade de espectadores (por exemplo: três espectadores a 6 Mb/s podem usar cerca de 18 Mb/s de upload só para vídeo, além de áudio e overhead). Em redes mais lentas, escolha 720p/30 FPS. A qualidade selecionada **não altera a fonte de áudio**; o modo nativo da versão 1.3 pode incluir áudio geral do sistema, enquanto os modos seletivos permanecem disponíveis.

## Atualizar de uma versão anterior

Se já tem uma versão do TelaViva funcionando, pare o servidor e faça backup da pasta `data/` e do arquivo `.env`. Extraia a v1.2 e copie **seus** `data/` e `.env` para o novo projeto (não compartilhe esses arquivos). Depois execute `npm install` (se necessário), `npm start` e atualize a página com `Ctrl+Shift+R` para evitar usar scripts antigos no cache.


---

# Versão 1.3 — compartilhar JANELA ou TELA com áudio

O seletor de áudio oferece agora **Janela ou tela inteira + áudio nativo (se disponível)**, além das opções seguras de áudio de aba e áudio virtual.

1. Escolha **Janela ou tela inteira + áudio nativo** e confirme o aviso de privacidade (o som pode incluir Discord).
2. Clique em **Compartilhar minha tela** e selecione a **Janela** ou **Tela inteira** no diálogo do navegador.
3. Se aparecer, ative a caixa **Compartilhar áudio**, **Compartilhar áudio do sistema** ou similar, antes de confirmar.
4. Se houver vídeo e áudio, o site os envia no mesmo fluxo WebRTC com o perfil HD/Full HD escolhido. Verifique o botão **Ativar som recebido** no lado de quem assiste, caso o autoplay bloqueie o áudio.

## Quando não aparece áudio ao compartilhar uma janela

**Não depende apenas do site.** `getDisplayMedia()` permite ao navegador fornecer vídeo mesmo que o app solicite áudio. No modo nativo, o TelaViva usa `audio: true`, `systemAudio: 'include'` e `windowAudio: 'window'`, mas esses valores são preferências e **não obrigam o navegador** a capturar o som daquela janela. O suporte varia por sistema operacional e versão do Chrome/Edge/Firefox.

Se o navegador retornar só vídeo, a transmissão **não começa silenciosa**. O site mantém o vídeo selecionado, mostra **Áudio: não disponibilizado pelo navegador** e oferece **2. Selecionar áudio**, usando uma entrada `TelaVivaFonte` criada pela configuração de áudio virtual no Ubuntu. Se não houver essa entrada, clique em **Cancelar seleção**, configure a rota virtual e tente novamente com **Janela ou tela inteira + áudio virtual isolado**.

**No Ubuntu/Linux:** para jogos e aplicativos nativos, a forma mais consistente é `TelaVivaAudio`/`TelaVivaFonte` com PipeWire/PulseAudio e `pavucontrol` (veja scripts anteriores). Separe o Discord na saída de áudio normal. É possível mostrar **qualquer janela** ou **a tela inteira** enquanto o som enviado vem da saída virtual.

**No Windows:** Chrome ou Edge podem oferecer áudio do sistema ao compartilhar a tela, e certas versões podem disponibilizar áudio de janela; não é garantido em todas as combinações. O áudio do sistema **pode incluir Discord**: para impedir isso use fonte de áudio isolada. Os scripts Linux não funcionam no Windows.

> Importante: selecionar `windowAudio: 'window'` pede que o navegador ofereça áudio da janela; não implementa filtragem de Discord. O app não possui acesso direto ao mixer do sistema.

### Atualização

Mantenha seus arquivos `.env` e `data/users.json` da instalação anterior; eles **não** são distribuídos neste ZIP. Extraia o projeto, copie esses arquivos na nova pasta, execute `npm install` e `npm start`, depois `Ctrl+Shift+R` no navegador.

Referências: [MDN — getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) e [Chrome — screen sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).


---

# v1.3.2 — diagnóstico de piscadas pretas durante rolagem

**O que mudou**

- Evita reiniciar o elemento `<video>` toda vez que o WebRTC entrega uma segunda trilha (áudio/vídeo), corrigindo um reset desnecessário na apresentação inicial. Isso não garante eliminar falhas geradas no capturador do sistema operacional.
- Mostra o estado da **fonte de captura** e da **conexão WebRTC**, com contadores de congelamentos, perda de pacotes e quadros descartados quando o navegador expõe essas métricas.
- Botão **Copiar diagnóstico**: copia apenas estado técnico, resolução, perfil e identificação de navegador. Não inclui senha, e-mail, convite, IP, áudio nem imagens da transmissão.
- Aplica também o limite de FPS nas preferências de codificação por participante quando suportado.
- Preserva login, áudio e seleção de HD/Full HD.

**Como localizar a causa**

1. Inicie a transmissão e abra a sala em outro computador ou conta para comparar a prévia local e o vídeo remoto.
2. Reproduza a piscada rolando uma página. Veja se ocorre **na prévia do apresentador**, **só na recepção**, ou **na tela do usuário fora do vídeo transmitido**.
3. Se apenas o espectador vê o problema, copie o diagnóstico no navegador dele e compare com a sua prévia. Congelamentos/perdas podem apontar para rede, renderização ou codificação; nem toda tela preta gera contador WebRTC.
4. Se a **prévia também fica preta**, faça um teste em outro navegador, com 720p/30 FPS. Se estiver no Ubuntu/Wayland, teste, se disponível, uma sessão X11/Xorg ou experimente desativar a aceleração gráfica do Chrome **somente como diagnóstico** (reinicie o navegador após modificar). O problema pode estar no PipeWire/compositor/driver gráfico e não é corrigível apenas por JavaScript.
5. Para comparar navegadores, compartilhe uma aba com áudio e depois toda a tela. Se o defeito aparece apenas em tela/janela, isso reforça a suspeita sobre o caminho de captura do sistema.

Existe relato recente de flicker durante deslocamento/rolagem em Ubuntu + Wayland + NVIDIA, com diferenças entre prévia local e imagem transmitida. Veja [relato do bug no Ubuntu](https://bugs.launchpad.net/ubuntu/+source/gnome-shell/+bug/2170629) e a documentação [WebRTC stats](https://www.w3.org/TR/webrtc-stats/).

Esta versão foi verificada quanto à sintaxe e à integridade dos arquivos, mas o defeito específico depende de GPU, sessão gráfica, navegador e rede; a correção definitiva exige um teste no computador onde ocorre.


---

# Versão 1.4 — interface de áudio simplificada

Na sala há **duas escolhas simples**: **Tela ou janela** (padrão) e **Uma aba**. A opção **Compartilhar som também** fica marcada por padrão. A qualidade HD/Full HD continua disponível na seção anterior.

## Para tentar compartilhar navegador/janela inteiro com som

1. Selecione **Tela ou janela** e deixe **Compartilhar som também** marcado.
2. Clique em **Iniciar compartilhamento** e, no seletor nativo do navegador, escolha **Tela inteira** ou a janela desejada.
3. **Se o navegador mostrar** “Compartilhar áudio do sistema” ou “Compartilhar áudio da janela”, ative a opção antes de confirmar.
4. Se o navegador **não** oferecer o áudio, o site apresentará escolhas simples para adicionar o som **de uma aba**, usar uma **fonte virtual** configurada no Ubuntu ou prosseguir sem áudio.

**Importante:** não existe como obrigar o navegador a capturar som de uma janela que não oferece áudio. No Chrome/Edge em Windows, a captura do sistema ao escolher a tela inteira pode estar disponível, dependendo da versão. No Chrome/Chromium no Ubuntu, áudio de telas e janelas geralmente não é disponibilizado nativamente; a saída é usar uma fonte de áudio virtual **TelaVivaFonte** ou compartilhar apenas uma aba com áudio. A API `getDisplayMedia` pode retornar somente vídeo mesmo quando o site solicita áudio.

## Se quiser excluir o Discord

Abra **Configuração avançada de áudio**, marque **Usar áudio isolado (sem Discord)**, selecione a tela/janela e depois a fonte virtual `TelaVivaFonte`. Antes disso, configure a saída virtual conforme os scripts `scripts/audio-ubuntu-iniciar.sh` e o procedimento de `pavucontrol` descritos neste README. **A exclusão depende do roteamento manual**, não de um filtro automático do site. Se usar som nativo do sistema, o Discord pode entrar na transmissão.

## Recuperação quando não há áudio

Se a captura de tela não retornar áudio, o TelaViva preserva a captura de vídeo e mostra **Usar o som de uma aba**, **Usar uma fonte de som do computador** (virtual previamente configurada) e **Continuar sem som**. Se optar por uma aba, a segunda permissão captura apenas o áudio dela, mas mantém o vídeo da janela ou tela já selecionada. Isso **não** equivale a capturar o som de todo o navegador.
