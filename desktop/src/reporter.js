'use strict';
// Relatórios de erro automáticos do app desktop para o servidor TelaViva (POST /api/report).
// Só informações técnicas: eventos do app, versão do sistema e do app, estado do helper de áudio.
// Nunca vai imagem, áudio, senha ou conteúdo da tela. Pode ser desligado no menu.
// Se o usuário ainda não fez login (o servidor responde 401), o relatório fica numa fila local e é reenviado depois.

const { app, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_EVENTS = 100;
const MAX_QUEUE = 20;
const MIN_REPEAT_MS = 5 * 60 * 1000;   // o mesmo problema só é reportado de novo depois de 5 min
const MAX_PER_HOUR = 8;

function createReporter({ getBaseUrl, isEnabled, getExtraContext = () => ({}) }) {
  const events = [];
  const recent = new Map();   // assinatura -> instante do último relatório
  const sentTimes = [];
  const queueFile = () => path.join(app.getPath('userData'), 'pending-reports.json');
  let flushing = false;

  function log(type, msg) {
    events.push({ t: Date.now(), type: String(type).slice(0, 30), msg: String(msg ?? '').slice(0, 400) });
    if (events.length > MAX_EVENTS) events.shift();
  }
  const mainEvents = () => events.slice(-60);

  function readQueue() { try { return JSON.parse(fs.readFileSync(queueFile(), 'utf8')); } catch { return []; } }
  function writeQueue(q) {
    try { fs.mkdirSync(path.dirname(queueFile()), { recursive: true }); fs.writeFileSync(queueFile(), JSON.stringify(q.slice(-MAX_QUEUE))); } catch { /* sem disco: perde */ }
  }
  function describe(reason) {
    return {
      source: 'desktop-main', reason, auto: true,
      app: `TelaViva Desktop ${app.getVersion()}`, packaged: app.isPackaged,
      platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`,
      electron: process.versions.electron, chrome: process.versions.chrome,
      ...getExtraContext()
    };
  }
  async function post(body) {
    const url = new URL('api/report', getBaseUrl()).href;
    const response = await session.defaultSession.fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return response.status;
  }

  // Registra e, se permitido, envia. Nunca lança erro.
  async function report(reason, detail) {
    try {
      log('erro', `${reason}: ${detail ?? ''}`);
      if (!isEnabled()) return;
      const signature = `${reason}|${String(detail ?? '').slice(0, 80)}`;
      const now = Date.now();
      if (now - (recent.get(signature) || 0) < MIN_REPEAT_MS) return;
      while (sentTimes.length && now - sentTimes[0] > 3600 * 1000) sentTimes.shift();
      if (sentTimes.length >= MAX_PER_HOUR) return;
      recent.set(signature, now); sentTimes.push(now);
      const body = { events: events.slice(-80), context: describe(reason), note: `automático: ${reason}` };
      let status = 0;
      try { status = await post(body); } catch { status = 0; }
      if (status !== 200) writeQueue([...readQueue(), body]); // 401 (sem login) ou rede fora: tenta de novo depois
    } catch { /* o relatório nunca pode causar outro erro */ }
  }

  async function flush() {
    if (flushing || !isEnabled()) return;
    const queue = readQueue();
    if (!queue.length) return;
    flushing = true;
    try {
      const rest = [];
      let stop = false;
      for (const body of queue) {
        if (stop) { rest.push(body); continue; }
        let status = 0;
        try { status = await post(body); } catch { status = 0; }
        if (status !== 200) { rest.push(body); stop = true; } // sem login ou sem rede: mantém o resto
      }
      writeQueue(rest);
    } finally { flushing = false; }
  }
  return { log, report, flush, mainEvents };
}

module.exports = { createReporter };
