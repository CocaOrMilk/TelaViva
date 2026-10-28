'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const file = path.join(__dirname, '..', 'data', 'users.json');

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const input = process.stdin;
    if (!input.isTTY) return reject(new Error('Execute em um terminal interativo.'));
    input.setRawMode(true);
    input.resume();
    let password = '';
    const done = (error, value) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\r' || char === '\n') return done(null, password);
        if (char === '\u0003') return done(new Error('Cancelado.'));
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
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question('E-mail do novo usuário: ')).trim().toLowerCase();
  rl.close();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) throw new Error('Informe um e-mail válido.');
  const password = await askHidden('Senha (mínimo 10 caracteres): ');
  if (password.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const users = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (users.some((user) => user.email === email)) throw new Error('Este e-mail já está cadastrado.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  users.push({ id: crypto.randomUUID(), email, passwordHash: `${salt}:${hash}` });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.log('Usuário criado com sucesso. Agora você pode entrar pelo site.');
}
main().catch((err) => { console.error('Erro:', err.message); process.exitCode = 1; });
