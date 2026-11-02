// Teste manual: node scripts/test-audio-linux.js
// Liga o roteamento, mostra o que foi movido, espera 8 s e desliga.
const { createRouter } = require('../src/linux-audio');
const { execFileSync } = require('node:child_process');
(async () => {
  const r = createRouter({ log: console.log });
  console.log(await r.start());
  console.log(execFileSync('pactl', ['list', 'short', 'sink-inputs']).toString());
  console.log(execFileSync('pactl', ['list', 'short', 'sources']).toString().split('\n').filter((l) => /telaviva/.test(l)).join('\n'));
  await new Promise((res) => setTimeout(res, 8000));
  console.log(await r.stop());
  console.log(execFileSync('pactl', ['list', 'short', 'modules']).toString().split('\n').filter((l) => /telaviva/.test(l)).join('\n') || '(nenhum módulo restante)');
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
