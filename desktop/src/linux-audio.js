'use strict';
// Roteamento de áudio no Linux (PipeWire-Pulse / PulseAudio).
//
// Cada programa ganha uma "cadeia" própria, para que o volume que VOCÊ ouve e
// o volume ENVIADO à transmissão sejam independentes:
//
//   programa ──► tv_app_N (saída virtual do programa)
//                   ├─ loopback "local" ──► seu fone/alto-falante padrão   (volume local)
//                   └─ loopback "tx"    ──► TelaVivaMix (mistura enviada) (volume da transmissão)
//
//   TelaVivaMix.monitor ──► TelaVivaFonte  (é o que o site captura)
//
// Discord e o próprio TelaViva ficam de fora (a menos que includeDiscord seja true).

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Nome novo de propósito: o WirePlumber guardava um 'target: telaviva_audio' antigo por programa e puxava
// de volta qualquer fluxo movido. Com um nome inédito esse vício não se aplica.
const SINK = 'telaviva_mix';
const LEGACY_SINK = 'telaviva_audio';
const SOURCE = 'telaviva_fonte';
const APP_PREFIX = 'tv_app_';
const IDLE_MS = 30000; // cadeia sem som por 30 s é desmontada (os volumes escolhidos são lembrados)
const DEFAULT_EXCLUDE = /discord|vesktop|webcord|armcord|legcord|vencord|webrtc voiceengine/i;

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}
async function pactlJson(args) { return JSON.parse(await pactl(['--format=json', ...args])); }

function parentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch { return 0; }
}
function isDescendantOf(pid, ancestor) {
  for (let i = 0; pid > 1 && i < 64; i++) {
    if (pid === ancestor) return true;
    pid = parentPid(pid);
  }
  return false;
}
const percentOf = (volume) => {
  const values = Object.values(volume || {}).map((v) => Number(String(v.value_percent).replace('%', '')) || 0);
  return values.length ? Math.max(...values) : 100;
};
const clampPct = (value) => {
  const pct = Math.round(Number(value));
  if (!Number.isFinite(pct)) throw new Error('Volume inválido.');
  return Math.min(150, Math.max(0, pct));
};
const appKey = (input) => {
  const p = input.properties || {};
  return String(p['application.name'] || p['application.process.binary'] || p['media.name'] || `fluxo-${input.index}`);
};

function createRouter({ log = () => {}, extraExclude = [] } = {}) {
  const exclude = [DEFAULT_EXCLUDE, ...extraExclude.map((s) => new RegExp(s, 'i'))];
  const ownBinary = path.basename(process.execPath);
  const moved = new Map();   // id do fluxo -> sink original
  const chains = new Map();  // programa -> { n, sinkName, name, modules, localMod, txMod, lastSeen, applied }
  const desired = new Map(); // programa -> { local:{volume,muted}, tx:{volume,muted} }
  let baseModules = [];
  let counter = 0;
  let running = false;
  let includeDiscord = false;
  let watcher = null;
  let timer = null;
  let sweeping = false;
  let sweepAgain = false;

  function shouldExclude(input) {
    const p = input.properties || {};
    if (input.owner_module != null) return true; // loopbacks do próprio roteamento
    const pid = Number(p['application.process.id']);
    if (pid && isDescendantOf(pid, process.pid)) return true; // áudio do próprio TelaViva
    if (p['application.process.binary'] === ownBinary) return true;
    if (/^telaviva/i.test(p['application.process.binary'] || '')) return true; // outra instância (evita eco)
    const hay = [
      p['application.name'], p['application.process.binary'], p['application.id'],
      p['application.flatpak.id'], p['pipewire.access.portal.app_id'], p['node.name'], p['media.name']
    ].filter(Boolean).join(' | ');
    return !includeDiscord && exclude.some((re) => re.test(hay));
  }

  const loadModule = async (...args) => (await pactl(['load-module', ...args])).trim();
  async function unload(ids) { for (const id of [...ids].reverse()) await pactl(['unload-module', String(id)]).catch(() => {}); }

  async function createChain(key, name) {
    const n = ++counter;
    // Nome estável por programa: o WirePlumber memoriza a saída de cada app pelo nome do sink, e um nome que
    // muda a cada execução faria o app "voltar" para a saída antiga logo depois de movido.
    const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'app';
    let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const sinkName = `${APP_PREFIX}${slug}_${h.toString(16).slice(0, 6)}`;
    const defaultSink = (await pactl(['get-default-sink'])).trim();
    const modules = [];
    try {
      modules.push(await loadModule('module-null-sink', `sink_name=${sinkName}`, `sink_properties=device.description=TelaViva-${slug}`));
      const localMod = await loadModule('module-loopback', `source=${sinkName}.monitor`, `sink=${defaultSink}`, 'latency_msec=60');
      modules.push(localMod);
      const txMod = await loadModule('module-loopback', `source=${sinkName}.monitor`, `sink=${SINK}`, 'latency_msec=30');
      modules.push(txMod);
      const chain = { n, sinkName, name, modules, localMod, txMod, lastSeen: Date.now(), applied: false };
      chains.set(key, chain);
      log(`cadeia criada: ${name} (${sinkName})`);
      return chain;
    } catch (e) {
      await unload(modules);
      throw e;
    }
  }

  // Aplica o volume/mudo escolhido nos loopbacks da cadeia (eles só aparecem como fluxos um instante depois).
  async function applyChain(key, chain, inputs) {
    const want = desired.get(key);
    const find = (mod) => inputs.find((i) => String(i.owner_module) === String(mod));
    const local = find(chain.localMod); const tx = find(chain.txMod);
    if (!local || !tx) return false;
    for (const [which, input] of [['local', local], ['tx', tx]]) {
      // O WirePlumber lembra volume/mudo por nome de fluxo ("loopback-N output") de execuções anteriores:
      // sempre define explicitamente (o escolhido no mixer, ou 100% sem mudo).
      const w = want?.[which] || {};
      await pactl(['set-sink-input-volume', String(input.index), `${w.volume ?? 100}%`]).catch(() => {});
      await pactl(['set-sink-input-mute', String(input.index), w.muted ? '1' : '0']).catch(() => {});
    }
    return true;
  }

  async function sweep() {
    if (!running) return;
    if (sweeping) { sweepAgain = true; return; }
    sweeping = true;
    try {
      const sinks = await pactlJson(['list', 'sinks']);
      const chainBySink = new Map();
      for (const [key, chain] of chains) {
        const sink = sinks.find((s) => s.name === chain.sinkName);
        if (sink) chainBySink.set(sink.index, [key, chain]);
      }
      const managedSinks = new Set(sinks.filter((x) => x.name === SINK || x.name.startsWith(APP_PREFIX)).map((x) => x.index));
      const realSink = (await pactl(['get-default-sink'])).trim();
      let inputs = await pactlJson(['list', 'sink-inputs']);
      const now = Date.now();
      for (const input of inputs) {
        if (input.owner_module != null) continue;
        if (chainBySink.has(input.sink)) { chainBySink.get(input.sink)[1].lastSeen = now; continue; }
        if (shouldExclude(input)) {
          // Discord & cia nunca podem ir para a transmissão: se pararem num sink gerenciado, voltam para a saída real.
          if (input.owner_module == null && (managedSinks.has(input.sink))) {
            await pactl(['move-sink-input', String(input.index), realSink]).catch(() => {});
            log(`devolvido à saída real: ${appKey(input)}`);
          }
          continue;
        }
        const key = appKey(input);
        try {
          const chain = chains.get(key) || await createChain(key, input.properties['application.name'] || key);
          await pactl(['move-sink-input', String(input.index), chain.sinkName]);
          chain.lastSeen = now;
          if (!moved.has(input.index)) moved.set(input.index, input.sink);
          log(`movido: ${key} (fluxo ${input.index}, estava no sink ${input.sink} -> ${chain.sinkName})`);
        } catch (e) { log(`falha ao mover ${input.index}: ${e.message}`); }
      }
      inputs = await pactlJson(['list', 'sink-inputs']);
      for (const [key, chain] of chains) {
        if (!chain.applied) chain.applied = await applyChain(key, chain, inputs);
        if (now - chain.lastSeen > IDLE_MS) { // ninguém toca há um tempo: desmonta a cadeia
          await unload(chain.modules);
          chains.delete(key);
          log(`cadeia removida: ${key}`);
        }
      }
    } catch (e) {
      log(`varredura falhou: ${e.message}`);
    } finally {
      sweeping = false;
      if (sweepAgain) { sweepAgain = false; setTimeout(sweep, 50); }
    }
  }

  async function removeStaleModules() {
    const list = await pactl(['list', 'short', 'modules']);
    const ids = list.split('\n').filter((l) => l.includes(SINK) || l.includes(LEGACY_SINK) || l.includes(SOURCE) || l.includes(APP_PREFIX))
      .map((l) => l.split('\t')[0]).reverse();
    for (const id of ids) await pactl(['unload-module', id]).catch(() => {});
  }

  async function start(opts = {}) {
    const wantDiscord = !!opts.includeDiscord;
    if (running && wantDiscord !== includeDiscord) await stop();
    if (running) return status();
    includeDiscord = wantDiscord;
    await pactl(['info']); // falha cedo se não houver servidor de áudio
    const defaultSink = (await pactl(['get-default-sink'])).trim();
    if (!defaultSink || defaultSink === SINK || defaultSink.startsWith(APP_PREFIX)) {
      throw new Error('Defina um fone/alto-falante real como saída padrão do sistema antes de continuar.');
    }
    await removeStaleModules();
    try {
      baseModules.push(await loadModule('module-null-sink', `sink_name=${SINK}`, 'sink_properties=device.description=TelaVivaMix'));
      baseModules.push(await loadModule('module-remap-source', `master=${SINK}.monitor`, `source_name=${SOURCE}`, 'source_properties=device.description=TelaVivaFonte'));
    } catch (e) {
      await unload(baseModules); baseModules = [];
      throw e;
    }
    // O WirePlumber lembra o volume da fonte da sessão anterior: sempre começa em 100%, sem mudo.
    await pactl(['set-source-volume', SOURCE, '100%']).catch(() => {});
    await pactl(['set-source-mute', SOURCE, '0']).catch(() => {});
    running = true;
    // LC_ALL=C: o pactl traduz a mensagem dos eventos; stdbuf: sem isso eles chegam em blocos, com atraso.
    watcher = spawn('stdbuf', ['-oL', 'pactl', 'subscribe'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
    watcher.stdout.on('data', (d) => { if (/'(new|change)' on sink-input/.test(String(d))) setTimeout(sweep, 120); });
    watcher.on('error', () => {});
    timer = setInterval(sweep, 3000);
    await sweep();
    log(`roteamento ativo (saída real: ${defaultSink})`);
    return status();
  }

  async function stop() {
    if (!running && !baseModules.length && !chains.size) return status();
    running = false;
    clearInterval(timer); timer = null;
    if (watcher) { watcher.kill(); watcher = null; }
    // Devolve cada programa para a saída em que estava (ou a padrão) ANTES de desmontar as cadeias.
    const fallback = (await pactl(['get-default-sink']).catch(() => '')).trim();
    const sinks = await pactlJson(['list', 'sinks']).catch(() => []);
    for (const [id, sinkIdx] of moved) {
      const dest = sinks.find((s) => s.index === sinkIdx && s.name !== SINK && !s.name.startsWith(APP_PREFIX))?.name || fallback;
      if (dest) await pactl(['move-sink-input', String(id), dest]).catch(() => {});
    }
    moved.clear();
    for (const chain of chains.values()) await unload(chain.modules);
    chains.clear(); desired.clear();
    await unload(baseModules); baseModules = [];
    log('roteamento encerrado');
    return status();
  }

  // ---- mixer: volume local e volume da transmissão, independentes --------------------------
  async function loopbackInputs() { return pactlJson(['list', 'sink-inputs']); }
  async function listApps() {
    if (!running) return [];
    const inputs = await loopbackInputs();
    const sinks = await pactlJson(['list', 'sinks']);
    const out = [];
    for (const [key, chain] of chains) {
      const idx = sinks.find((s) => s.name === chain.sinkName)?.index;
      const find = (mod) => inputs.find((i) => String(i.owner_module) === String(mod));
      const local = find(chain.localMod); const tx = find(chain.txMod);
      if (!local || !tx) continue;
      out.push({
        key, name: chain.name,
        active: inputs.some((i) => i.owner_module == null && i.sink === idx),
        local: { volume: percentOf(local.volume), muted: !!local.mute },
        tx: { volume: percentOf(tx.volume), muted: !!tx.mute }
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  function checkWhich(which) { if (which !== 'local' && which !== 'tx') throw new Error('Destino inválido.'); return which; }
  async function setAppVolume(key, which, percent) {
    checkWhich(which); const pct = clampPct(percent);
    const cur = desired.get(key) || {};
    desired.set(key, { ...cur, [which]: { ...(cur[which] || {}), volume: pct } });
    const chain = chains.get(key);
    if (chain) {
      const input = (await loopbackInputs()).find((i) => String(i.owner_module) === String(which === 'local' ? chain.localMod : chain.txMod));
      if (input) await pactl(['set-sink-input-volume', String(input.index), `${pct}%`]);
    }
    return { key, which, volume: pct };
  }
  async function setAppMute(key, which, muted) {
    checkWhich(which);
    const cur = desired.get(key) || {};
    desired.set(key, { ...cur, [which]: { ...(cur[which] || {}), muted: !!muted } });
    const chain = chains.get(key);
    if (chain) {
      const input = (await loopbackInputs()).find((i) => String(i.owner_module) === String(which === 'local' ? chain.localMod : chain.txMod));
      if (input) await pactl(['set-sink-input-mute', String(input.index), muted ? '1' : '0']);
    }
    return { key, which, muted: !!muted };
  }
  // Volume geral do que é ENVIADO (não muda o que você ouve).
  async function getMaster() {
    if (!running) return 100;
    const src = (await pactlJson(['list', 'sources'])).find((x) => x.name === SOURCE);
    return src ? percentOf(src.volume) : 100;
  }
  async function setMaster(percent) {
    const pct = clampPct(percent);
    if (!running) throw new Error('Roteamento de áudio desligado.');
    await pactl(['set-source-volume', SOURCE, `${pct}%`]);
    return { master: pct };
  }

  function status() { return { running, platform: 'linux', source: 'TelaVivaFonte', excluded: includeDiscord ? null : 'Discord' }; }
  return { start, stop, status, listApps, setAppVolume, setAppMute, getMaster, setMaster };
}

module.exports = { createRouter, DEFAULT_EXCLUDE };
