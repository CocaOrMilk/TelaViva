// Teste manual: node scripts/test-mixer-linux.js  (volume local x transmissão independentes)
const { createRouter } = require('../src/linux-audio');
const { execFileSync, spawn } = require('node:child_process');
const NAME = 'Jogo-Teste-' + Date.now();
const startTone = () => spawn('setsid', ['-f', 'bash', '-c', `pacat --client-name=${NAME} --rate=44100 --format=s16le --channels=2 < /dev/zero`]);
const stopTone = () => { try { execFileSync('pkill', ['-f', `client-name=${NAME}`]); } catch {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// o que o programa de verdade está tocando (volume do próprio programa — não deve mudar)
const appVol = () => JSON.parse(execFileSync('pactl', ['--format=json', 'list', 'sink-inputs'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  .filter((i) => i.properties['application.name'] === NAME).map((i) => `${i.volume['front-left'].value_percent}/mute=${i.mute}`)[0];
(async () => {
  const r = createRouter({ log: console.log });
  await r.start();
  startTone(); await wait(2500);
  console.log('apps:', JSON.stringify(await r.listApps()));
  console.log('volume do próprio programa (antes):', appVol());
  await r.setAppVolume(NAME, 'tx', 25); await wait(300);
  let a = (await r.listApps()).find((x) => x.key === NAME);
  console.log('após transmissão=25%  ->', JSON.stringify({ local: a.local, tx: a.tx }), '(local deve continuar 100)');
  await r.setAppVolume(NAME, 'local', 140); await wait(300);
  a = (await r.listApps()).find((x) => x.key === NAME);
  console.log('após local=140%       ->', JSON.stringify({ local: a.local, tx: a.tx }), '(tx deve continuar 25)');
  await r.setAppMute(NAME, 'local', true); await wait(300);
  a = (await r.listApps()).find((x) => x.key === NAME);
  console.log('local mudo            ->', JSON.stringify({ local: a.local, tx: a.tx }), '(tx NÃO pode ficar mudo)');
  console.log('volume do próprio programa (depois):', appVol(), '(deve ser igual ao de antes)');
  stopTone(); await wait(500); startTone(); await wait(3000);
  a = (await r.listApps()).find((x) => x.key === NAME);
  console.log('novo fluxo do mesmo programa ->', JSON.stringify(a && { local: a.local, tx: a.tx }));
  stopTone(); await r.stop();
  console.log('desligado:', JSON.stringify(await r.listApps()));
  console.log('módulos restantes:', execFileSync('pactl', ['list', 'short', 'modules']).toString().split('\n').filter((l) => /telaviva|tv_app/.test(l)).length);
})().catch((e) => { console.error('ERRO', e); stopTone(); process.exit(1); });
