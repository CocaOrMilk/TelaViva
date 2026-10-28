'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const file = path.join(__dirname, '..', 'data', 'users.json');

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    if (!input.isTTY) return reject(new Error('Execute em um terminal interativo.'));
    input.setRawMode(true);
    input.resume();
    let password = '';
    const finish = (error) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(password);
    };
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelado.'));
        if (char === '\u007f' || char === '\b') {
          if (password.length) { password = password.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (char >= ' ' && password.length < 200) {
          password += char;
          process.stdout.write('*');
        }
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  if (!fs.existsSync(file)) throw new Error('Não há usuários cadastrados em data/users.json.');
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(users)) throw new Error('Formato de data/users.json inválido.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question('E-mail do usuário que deseja alterar: ')).trim().toLowerCase();
  rl.close();
  const user = users.find((entry) => entry.email === email);
  if (!user) throw new Error('E-mail não encontrado. Nenhuma alteração foi feita.');

  const password = await askHidden('Nova senha (mínimo 10 caracteres): ');
  if (password.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres.');
  const confirm = await askHidden('Confirme a nova senha: ');
  if (password !== confirm) throw new Error('As senhas não coincidem. Nenhuma alteração foi feita.');

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  user.passwordHash = `${salt}:${hash}`;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  console.log('Senha alterada com sucesso para:', email);
  console.log('A senha do seu provedor de e-mail NÃO foi alterada.');
}

main().catch((error) => { console.error('Erro:', error.message); process.exitCode = 1; });
