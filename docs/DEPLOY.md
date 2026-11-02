# Publicando o TelaViva

Captura de tela exige **HTTPS** (exceto em `localhost`). Os exemplos usam `exemplo.com` e `IP_DO_SERVIDOR`: troque pelos seus.

## 1. Servidor Node

```bash
git clone <seu-repositorio> /opt/telaviva && cd /opt/telaviva
npm ci --omit=dev
cp .env.example .env     # SESSION_SECRET forte, NODE_ENV=production, HOST=127.0.0.1, DATA_DIR=/var/lib/telaviva
npm run criar-usuario
```

Exemplo de serviço (`/etc/systemd/system/telaviva.service`):

```ini
[Unit]
Description=TelaViva
After=network.target

[Service]
WorkingDirectory=/opt/telaviva
EnvironmentFile=/opt/telaviva/.env
ExecStart=/usr/bin/node server.js
User=telaviva
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
StateDirectory=telaviva
UMask=0077

[Install]
WantedBy=multi-user.target
```

## 2. Proxy reverso com HTTPS e WebSocket (nginx)

```nginx
server {
    listen 443 ssl;
    server_name exemplo.com;
    # ssl_certificate / ssl_certificate_key (ex.: Let's Encrypt)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 3. TURN (coturn), para quem está atrás de NAT restritivo

`/etc/turnserver.conf` (mínimo):

```ini
listening-port=3478
listening-ip=IP_DO_SERVIDOR
relay-ip=IP_DO_SERVIDOR
min-port=49160
max-port=49260
fingerprint
lt-cred-mech
realm=exemplo.com
user=USUARIO:SENHA_FORTE
no-cli
no-multicast-peers
```

Libere no firewall `3478/tcp`, `3478/udp` e `49160:49260/udp`, e informe ao servidor:

```ini
ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:IP_DO_SERVIDOR:3478?transport=udp","turn:IP_DO_SERVIDOR:3478?transport=tcp"],"username":"USUARIO","credential":"SENHA_FORTE"}]
```

A credencial TURN é entregue só a usuários autenticados (`/api/config`), mas é **compartilhada**: use uma senha própria
para este fim e troque-a se vazar.

## 4. Operação

- Logs de erro (servidor e relatórios dos usuários): `DATA_DIR/logs/telaviva.log` (JSON por linha; rotaciona em 2 MB).
- Contas: `DATA_DIR/users.json` (faça backup; contém apenas e-mails e hashes de senha).
- Atualizar: `git pull && npm ci --omit=dev && sudo systemctl restart telaviva`.
