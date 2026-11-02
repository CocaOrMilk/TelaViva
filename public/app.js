'use strict';

const $ = (id) => document.getElementById(id);
// ---- registro local de eventos ----------------------------------------
// Fica só neste navegador. Só vai ao servidor se a pessoa clicar em "Enviar relatório".
const logBuffer = [];
function logEvent(type, msg) {
  logBuffer.push({ t: Date.now(), type, msg: String(msg ?? '').slice(0, 400) });
  if (logBuffer.length > 80) logBuffer.shift();
}
let lastReportOffer = 0;
function offerReport() {
  const bar = document.getElementById('reportBar');
  if (!bar || Date.now() - lastReportOffer < 60000) return;
  lastReportOffer = Date.now();
  const desktopApp = window.telavivaDesktop;
  if (desktopApp?.report) { // app desktop: envia sozinho (se "Enviar relatórios de erro automaticamente" estiver ligado no menu)
    desktopApp.report.isAuto().then((auto) => { if (auto) sendReport(true); else bar.classList.remove('hidden'); }).catch(() => bar.classList.remove('hidden'));
    return;
  }
  bar.classList.remove('hidden');
}
window.addEventListener('error', (e) => { logEvent('js-error', `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`); offerReport(); });
window.addEventListener('unhandledrejection', (e) => { logEvent('promise', e.reason?.message || e.reason); offerReport(); });
for (const level of ['warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { logEvent(`console.${level}`, args.map((a) => a?.message || String(a)).join(' ')); original(...args); };
}
const views = { auth: $('authView'), dashboard: $('dashboardView'), room: $('roomView') };
const stageVideo = $('stageVideo');
const stageEmpty = $('stageEmpty');
let socket = null;
let currentRoom = null;
let activeSharers = new Set();
let localStream = null;
let sourceStreams = []; // Streams originais são encerrados com a transmissão.
let pendingScreenStream = null;
let pendingMode = null;
let pendingRoom = null;
let activeAudioMode = null;
let desktopRoutedAudio = false;
let availableAudioDevices = new Map();
let isPresenter = false;
let viewerPeers = new Map();
let remoteStreams = new Map();
let videoTiles = new Map();
let peers = new Map();
let iceQueue = new Map();
let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxMembers: 8, maxSharers: 3 };
let toastTimer;
// Perfis de transmissão: limites desejados, não garantias de rede/codificador.
const QUALITY_PROFILES = Object.freeze({
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 4_000_000, label: 'HD 720p · 30 FPS' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 8_000_000, label: 'Full HD 1080p · 30 FPS' },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 14_000_000, label: 'Full HD 1080p · 60 FPS' }
});
let activeQuality = null;
let statsTimer = null;
let previousStats = null;
// Indicadores locais: não gravam a tela, não são enviados ao servidor.
const observedTracks = new WeakSet();
const diagnosticState = { capture: 'aguardando', network: 'aguardando', lastVideo: 'sem dados' };
function renderDiagnostics() {
  $('captureHealth').textContent = `Captura: ${diagnosticState.capture}`;
  $('connectionHealth').textContent = `WebRTC: ${diagnosticState.network}`;
}
function setCaptureHealth(message) {
  diagnosticState.capture = message;
  renderDiagnostics();
}
function setNetworkHealth(message) {
  diagnosticState.network = message;
  renderDiagnostics();
}
function observeVideoTrack(track, local = false) {
  if (!track || track.kind !== 'video' || observedTracks.has(track)) return;
  observedTracks.add(track);
  const update = () => {
    if (track.readyState === 'ended') {
      if (local) setCaptureHealth('captura encerrada');
      else setNetworkHealth('vídeo remoto encerrado');
    } else if (track.muted) {
      if (local) setCaptureHealth('fonte suspensa pelo navegador');
      else setNetworkHealth('trilha de vídeo silenciada');
    } else if (local) {
      const surface = track.getSettings?.().displaySurface || 'desconhecida';
      setCaptureHealth(`ativa (${surface})`);
    } else {
      setNetworkHealth('vídeo remoto ativo');
    }
  };
  track.addEventListener('mute', update);
  track.addEventListener('unmute', update);
  track.addEventListener('ended', update);
  update();
}
const inviteCode = new URLSearchParams(window.location.search).get('sala');

function showView(name) {
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
  $('topPublic').classList.toggle('hidden', name !== 'auth');
  $('topPrivate').classList.toggle('hidden', name === 'auth');
}
function toast(message, error = false) {
  if (error) { logEvent('erro', message); offerReport(); }
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 4500);
}
async function sendReport(automatic = false) {
  const describe = (map, dir) => [...map.entries()].map(([id, p]) => `${dir} ${String(id).slice(0, 4)}: ${p.connectionState}/${p.iceConnectionState}`);
  const context = {
    app: 'TelaViva 1.7', ua: navigator.userAgent, online: navigator.onLine,
    desktop: window.telavivaDesktop ? { platform: window.telavivaDesktop.platform } : null,
    room: currentRoom, presenter: isPresenter, sharers: activeSharers.size,
    quality: (activeQuality || selectedQuality()).label, sound: soundMode(),
    capture: diagnosticState.capture, network: diagnosticState.network, lastVideo: diagnosticState.lastVideo,
    uplinkMbps: uplinkMbps ? +uplinkMbps.toFixed(1) : null, codecChoice: $('codecSelect')?.value || 'auto', priority: preferSharp() ? 'nitidez' : 'fluidez',
    peers: [...describe(peers, 'envio'), ...describe(viewerPeers, 'recepção')],
    turn: (config.iceServers || []).map((server) => [].concat(server.urls).join(',')) // sem usuário/senha
  };
  let events = logBuffer;
  if (window.telavivaDesktop) { // junta o que o app desktop registrou (áudio, helper, processos internos)
    try {
      context.desktop = await window.telavivaDesktop.info();
      const appEvents = (await window.telavivaDesktop.report.mainEvents()).map((e) => ({ ...e, type: `app:${e.type}` }));
      events = [...appEvents, ...logBuffer].sort((a, b) => a.t - b.t).slice(-100);
      context.automatic = automatic;
    } catch { /* segue só com o que a página tem */ }
  }
  const button = $('reportSendBtn');
  button.disabled = true;
  try {
    const result = await api('/api/report', { method: 'POST', body: JSON.stringify({ events, context, note: automatic ? 'automático (app desktop)' : '' }) });
    $('reportBar').classList.add('hidden');
    toast(automatic ? `Um relatório de erro foi enviado automaticamente. Código: ${result.id}` : `Relatório enviado. Código: ${result.id}`);
  } catch (e) { if (!automatic) toast(`Não foi possível enviar o relatório: ${e.message}`, true); }
  finally { button.disabled = false; }
}
function setLive(value) {
  $('livePill').classList.toggle('is-live', value);
  $('liveLabel').textContent = value ? 'Ao vivo' : 'Em espera';
  $('stageLiveIndicator').classList.toggle('hidden', !value);
}
function updateRoomStatus(text, caption = text) {
  $('roomStatus').textContent = text;
  $('stageCaption').textContent = caption;
}
function updateControls() {
  const full = activeSharers.size >= (config.maxSharers || 3);
  $('shareBtn').classList.toggle('hidden', isPresenter || full);
  $('stopBtn').classList.toggle('hidden', !isPresenter);
  $('youStatus').textContent = isPresenter
    ? (localStream?.getAudioTracks().length ? 'Compartilhando tela e som' : 'Compartilhando tela sem som')
    : 'Conectado à sala';
  $('shareSetup').classList.toggle('hidden', isPresenter || full);
  $('shareBtn').disabled = isPresenter || full;
  $('sharersCount').textContent = `${activeSharers.size} / ${config.maxSharers || 3} transmitindo`;
}
function updateMembers(info) {
  $('membersCount').textContent = `${info.members} / ${config.maxMembers}`;
  $('othersRow').classList.toggle('hidden', info.members <= 1);
  $('othersCount').textContent = `${info.members - 1} outra(s) pessoa(s)`;
}
function updateAudioStatus() {
  const remoteAudio = [...remoteStreams.values()].some((stream) => stream.getAudioTracks().length);
  $('audioStatus').textContent = isPresenter ? 'Áudio local: ' + (localStream?.getAudioTracks().length ? 'enviando' : 'desligado')
    : remoteAudio ? 'Áudio: recebido' : 'Áudio: aguardando';
  $('enableAudioBtn').classList.toggle('hidden', !remoteAudio);
}
function renderTiles() {
  const container = $('videoGrid');
  const streams = new Map(remoteStreams);
  if (isPresenter && localStream) streams.set('local', localStream);
  for (const [id, tile] of videoTiles) {
    if (!streams.has(id)) { tile.video.srcObject = null; tile.card.remove(); videoTiles.delete(id); }
  }
  for (const [id, stream] of streams) {
    let tile = videoTiles.get(id);
    if (!tile) {
      const card = document.createElement('div'); card.className = 'video-tile';
      const header = document.createElement('div'); header.className = 'video-tile-title';
      const video = document.createElement('video'); video.autoplay = true; video.playsInline = true;
      video.controls = id !== 'local'; video.muted = id === 'local';
      const fullscreen = document.createElement('button'); fullscreen.type = 'button';
      fullscreen.textContent = '⛶ Tela cheia'; fullscreen.className = 'tile-fullscreen';
      fullscreen.onclick = () => video.requestFullscreen?.();
      header.textContent = id === 'local' ? 'Sua tela (prévia sem som)' : `Tela de participante ${[...activeSharers].indexOf(id) + 1}`;
      card.append(header, video, fullscreen); container.append(card);
      tile = { card, header, video }; videoTiles.set(id, tile);
    }
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.video.muted = id === 'local';
    tile.video.play().catch(() => {});
  }
  for (const [id, tile] of videoTiles) tile.header.textContent = id === 'local' ? 'Sua tela (prévia sem som)' : `Tela de participante ${Math.max(1, [...activeSharers].indexOf(id) + 1)}`;
  container.classList.toggle('hidden', streams.size === 0);
  stageEmpty.classList.toggle('hidden', streams.size > 0);
  $('screenStage').classList.toggle('hidden', streams.size > 0);
  $('stageLiveIndicator').classList.add('hidden');
  setLive(streams.size > 0);
  updateAudioStatus();
}
function displayStream(stream, own = false, host = null) {
  if (!own && host) remoteStreams.set(host, stream);
  renderTiles();
}
function hideStream() {
  renderTiles();
  previousStats = null;
  $('qualityStats').textContent = 'Qualidade real: aguardando vídeo';
  diagnosticState.lastVideo = 'sem dados';
}
function inviteUrl(code) {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('sala', code);
  return url.toString();
}
function setUrl(code) {
  const url = code ? inviteUrl(code) : window.location.origin + window.location.pathname;
  history.replaceState(null, '', url);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a solicitação.');
  return result;
}
function emitAck(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Sem conexão com o servidor.'));
    const callback = (error, result) => {
      if (error) return reject(new Error('O servidor não respondeu. Tente novamente.'));
      if (!result?.ok) return reject(new Error(result?.error || 'Operação não permitida.'));
      resolve(result);
    };
    if (payload === undefined) socket.timeout(7000).emit(event, callback);
    else socket.timeout(7000).emit(event, payload, callback);
  });
}
// Evita pedidos de vídeo duplicados: o servidor avisa a mesma transmissão por mais
// de um caminho (share:available, room:members, entrada na sala). Duas ofertas
// seguidas faziam a resposta da primeira ser aplicada à segunda e a conexão
// travava até falhar ("às vezes").
const streamRequests = new Map(); // host -> instante do último pedido
const viewerRetries = new Map();  // host -> tentativas de reconexão
const lastOfferAt = new Map();    // espectador -> instante da última oferta enviada
function requestStream(host, force = false) {
  if (!socket?.connected || !host || host === socket.id) return;
  const now = Date.now();
  if (!force && (viewerPeers.has(host) || now - (streamRequests.get(host) || 0) < 8000)) return;
  streamRequests.set(host, now);
  socket.emit('viewer:ready', { host });
}
function retryViewer(host) {
  if (!currentRoom || !activeSharers.has(host)) return;
  const attempt = (viewerRetries.get(host) || 0) + 1;
  viewerRetries.set(host, attempt);
  if (attempt > 3) {
    toast('Não foi possível receber a transmissão. Verifique VPN ou firewall (o servidor de relay usa a porta 3478) e entre na sala de novo.', true);
    return;
  }
  if (attempt === 1) toast('Conexão de vídeo instável. Reconectando…');
  clearViewerPeer(host);
  setTimeout(() => { if (currentRoom && activeSharers.has(host) && !viewerPeers.has(host)) requestStream(host, true); }, 800 * attempt);
}
function iceKey(id, target) { return `${target}:${id}`; }
function getConnection(id, target = 'viewer') {
  return target === 'presenter' ? peers.get(id) : viewerPeers.get(id);
}
function clearPeer(id) { const pc = peers.get(id); if (pc) { pc.close(); peers.delete(id); rebalanceBitrates(); } iceQueue.delete(iceKey(id, 'presenter')); }
function clearViewerPeer(id) {
  const peer = viewerPeers.get(id); if (peer) peer.close(); viewerPeers.delete(id);
  remoteStreams.delete(id); iceQueue.delete(iceKey(id, 'viewer')); renderTiles();
}
function cleanupPeers() {
  for (const peer of peers.values()) peer.close(); peers.clear();
  for (const peer of viewerPeers.values()) peer.close(); viewerPeers.clear();
  remoteStreams.clear(); iceQueue.clear(); renderTiles();
}
function resetPlayback() {
  setCaptureHealth('aguardando'); setNetworkHealth('aguardando');
  cleanupPeers(); activeSharers.clear(); setLive(false); hideStream();
  updateRoomStatus('Aguardando compartilhamento de tela', 'Sala pronta para compartilhar'); updateControls();
}
function stopTracks(stream) {
  stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
}
function stopLocalShare(notify = true) {
  const wasSharing = isPresenter || Boolean(localStream);
  isPresenter = false;
  const streams = [...sourceStreams, pendingScreenStream, localStream];
  sourceStreams = []; pendingScreenStream = null; pendingMode = null; pendingRoom = null;
  localStream = null;
  if (notify && wasSharing && socket?.connected) socket.emit('share:stop');
  new Set(streams.filter(Boolean)).forEach(stopTracks);
  if (wasSharing) activeSharers.delete(socket?.id);
  for (const id of [...peers.keys()]) clearPeer(id);
  activeQuality = null; activeAudioMode = null;
  renderTiles(); updateControls();
  stopMixer(); stopWindowsAudio();
  if (desktopRoutedAudio) { desktopRoutedAudio = false; desktop.audio.stop().catch(() => {}); }
}

function leaveRoomLocal() {
  stopStatsMonitor();
  stopLocalShare(false);
  currentRoom = null;
  $('roomTitle').textContent = '—';
  setUrl(null);
  showView('dashboard');
}
// ---- banda de upload -------------------------------------------------------
// Cada espectador é uma conexão com estimativa de banda própria; várias delas disputando o mesmo upload
// fazem a resolução subir e descer sem parar. Medimos o upload até o servidor e dividimos o orçamento
// (70% do upload) entre os espectadores, limitando o bitrate de cada um.
let uplinkMbps = null;
let uplinkMeasuredAt = 0;
async function measureUplink() {
  if (uplinkMbps && Date.now() - uplinkMeasuredAt < 5 * 60 * 1000) return uplinkMbps;
  try {
    const size = 2_000_000;
    const body = new Uint8Array(size);
    const t0 = performance.now();
    await api('/api/speedtest', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
    const seconds = (performance.now() - t0) / 1000;
    uplinkMbps = Math.max(1, (size * 8) / seconds / 1e6);
    uplinkMeasuredAt = Date.now();
    logEvent('rede', `upload medido: ${uplinkMbps.toFixed(1)} Mb/s`);
    const info = $('uplinkInfo'); if (info) info.textContent = `Upload estimado: ${uplinkMbps.toFixed(0)} Mb/s`;
  } catch (e) { logEvent('rede', `medição de upload falhou: ${e.message}`); }
  return uplinkMbps;
}
function perViewerBitrate(profile, viewers) {
  const n = Math.max(1, viewers);
  const budget = uplinkMbps ? uplinkMbps * 1e6 * 0.7 : Infinity;
  return Math.round(Math.max(1_500_000, Math.min(profile.bitrate, budget / n)));
}
function rebalanceBitrates() {
  if (!isPresenter) return;
  const profile = activeQuality || selectedQuality();
  const per = perViewerBitrate(profile, peers.size);
  for (const pc of peers.values()) {
    pc.__bitrate = per;
    const sender = pc.getSenders().find((x) => x.track?.kind === 'video');
    if (!sender) continue;
    try { const params = sender.getParameters(); if (params.encodings?.length) { params.encodings[0].maxBitrate = per; sender.setParameters(params).catch(() => {}); } } catch { /* ok */ }
  }
}
// O remetente lê x-google-min/start-bitrate da descrição REMOTA (a resposta): com um piso de bitrate a
// resolução não despenca por causa de uma estimativa de banda temporariamente baixa.
function withBitrateHints(sdp, minKbps, startKbps) {
  const hint = `x-google-min-bitrate=${minKbps};x-google-start-bitrate=${startKbps}`;
  return sdp.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith('m=video')) return section;
    let out = section;
    const codecs = [...section.matchAll(/^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\/90000\r?\n/gim)].map((m) => m[1]);
    for (const pt of codecs) {
      const fmtp = new RegExp(`^(a=fmtp:${pt} [^\\r\\n]*)`, 'm');
      if (fmtp.test(out)) out = out.replace(fmtp, `$1;${hint}`);
      else out = out.replace(new RegExp(`^(a=rtpmap:${pt} [^\\r\\n]*\\r?\\n)`, 'm'), `$1a=fmtp:${pt} ${hint}\r\n`);
    }
    return out;
  }).join('');
}
// Fluidez x nitidez. Capturas de tela são tratadas pelo WebRTC como "conteúdo estático" (prioriza resolução)
// e, se o computador não dá conta, o FPS despenca (medido: ~27 fps, ou ~10 fps com H.264, no lugar de ~60).
// 'motion' faz o WebRTC reduzir a resolução antes de reduzir o FPS. 'detail' serve para texto/slides.
const preferSharp = () => Boolean($('preferSharp')?.checked);
// Codec: "Automático" (padrão do navegador, VP8) é o mais seguro: o H.264 depende do decodificador de vídeo da
// placa de quem assiste, e alguns (Windows/Linux) mostram a imagem lavada/clara. H.264 e VP9 ficam como opção.
function applyCodecPreferences(transceiver) {
  const choice = $('codecSelect')?.value || 'auto';
  if (choice === 'auto' || preferSharp() || !transceiver?.setCodecPreferences || !window.RTCRtpSender?.getCapabilities) return;
  try {
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const wanted = codecs.filter((c) => c.mimeType.toLowerCase() === `video/${choice}`);
    if (!wanted.length) return;
    transceiver.setCodecPreferences([...wanted, ...codecs.filter((c) => !wanted.includes(c))]);
  } catch (e) { console.warn('Preferência de codec não aplicada:', e); }
}
function createPeer(remoteId, ownStream) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  pc.onicecandidate = (event) => {
    if (event.candidate && socket?.connected) socket.emit('signal:ice', { to: remoteId, target: ownStream ? 'viewer' : 'presenter', candidate: event.candidate.toJSON() });
  };
  const role = ownStream ? 'transmissor' : 'espectador';
  pc.oniceconnectionstatechange = () => logEvent('ice', `${role} ${String(remoteId).slice(0, 4)}: ice ${pc.iceConnectionState}`);
  pc.onicecandidateerror = (e) => logEvent('ice-erro', `${e.errorCode} ${e.errorText} ${e.url || ''}`);
  pc.onconnectionstatechange = () => {
    logEvent('rtc', `${role} ${String(remoteId).slice(0, 4)}: ${pc.connectionState}`);
    if (peers.get(remoteId) === pc || viewerPeers.get(remoteId) === pc) {
      setNetworkHealth(`conexão ${pc.connectionState}`);
    }
    if (ownStream || viewerPeers.get(remoteId) !== pc) return; // só o espectador reconecta
    if (pc.connectionState === 'connected') { viewerRetries.delete(remoteId); clearTimeout(pc.__retryTimer); }
    else if (pc.connectionState === 'failed') retryViewer(remoteId);
    else if (pc.connectionState === 'disconnected') {
      clearTimeout(pc.__retryTimer);
      pc.__retryTimer = setTimeout(() => { if (viewerPeers.get(remoteId) === pc && pc.connectionState !== 'connected') retryViewer(remoteId); }, 5000);
    }
  };
  if (ownStream) {
    // Um codificador por espectador (WebRTC P2P). O bitrate é um teto, não um piso.
    const profile = activeQuality || selectedQuality();
    const videoTrack = ownStream.getVideoTracks()[0];
    const settings = videoTrack?.getSettings?.() || {};
    const sourceWidth = settings.width || profile.width;
    const sourceHeight = settings.height || profile.height;
    const scale = Math.max(1, sourceWidth / profile.width, sourceHeight / profile.height);
    const perViewer = perViewerBitrate(profile, peers.size + (peers.has(remoteId) ? 0 : 1));
    pc.__bitrate = perViewer;
    const encoding = { maxBitrate: perViewer, maxFramerate: profile.fps, scaleResolutionDownBy: scale };
    if (videoTrack) {
      try {
        applyCodecPreferences(pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [ownStream], sendEncodings: [encoding] }));
      } catch (error) {
        // Fallback para navegadores que não aceitam sendEncodings em addTransceiver.
        console.warn('Limites de codificação não suportados diretamente:', error);
        const sender = pc.addTrack(videoTrack, ownStream);
        try {
          const params = sender.getParameters();
          if (params.encodings?.length) {
            params.encodings[0].maxBitrate = perViewer;
            params.encodings[0].maxFramerate = profile.fps;
            params.encodings[0].scaleResolutionDownBy = scale;
            sender.setParameters(params).catch((e) => console.warn('Não foi possível configurar o bitrate:', e));
          }
        } catch (e) { console.warn('Parâmetros de envio não disponíveis:', e); }
      }
    }
    for (const track of ownStream.getAudioTracks()) pc.addTrack(track, ownStream);
  }
  return pc;
}
async function flushIce(id, peer, target) {
  const key = iceKey(id, target);
  const queued = iceQueue.get(key) || [];
  iceQueue.delete(key);
  for (const candidate of queued) {
    try { await peer.addIceCandidate(candidate); } catch (e) { console.warn('Candidato ICE rejeitado:', e); }
  }
}
async function makeOffer(id) {
  if (!isPresenter || !localStream || !currentRoom || !socket?.connected || id === socket.id) return;
  const existing = peers.get(id);
  if (existing && Date.now() - (lastOfferAt.get(id) || 0) < 3000 && !['failed', 'closed', 'disconnected'].includes(existing.connectionState)) return; // pedido duplicado
  lastOfferAt.set(id, Date.now());
  clearPeer(id);
  const pc = createPeer(id, localStream);
  peers.set(id, pc);
  rebalanceBitrates();
  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (peers.get(id) === pc) socket.emit('signal:offer', { to: id, sdp: pc.localDescription });
  } catch (e) {
    clearPeer(id);
    console.error(e);
    toast('Não foi possível iniciar a transmissão para um participante.', true);
  }
}
async function receiveOffer({ from, sdp }) {
  if (!currentRoom || !activeSharers.has(from) || from === socket.id) return;
  clearViewerPeer(from);
  const stream = new MediaStream();
  remoteStreams.set(from, stream);
  const pc = createPeer(from, null); viewerPeers.set(from, pc);
  pc.ontrack = (event) => {
    if (viewerPeers.get(from) !== pc) return;
    if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
    if (event.track.kind === 'video') observeVideoTrack(event.track, false);
    displayStream(stream, false, from);
    updateRoomStatus(`${activeSharers.size} transmissão(ões) ativa(s)`, 'Recebendo telas em tempo real');
  };
  setTimeout(() => { if (viewerPeers.get(from) === pc && pc.connectionState !== 'connected' && pc.connectionState !== 'closed') retryViewer(from); }, 15000);
  try {
    await pc.setRemoteDescription(sdp); await flushIce(from, pc, 'viewer');
    await pc.setLocalDescription(await pc.createAnswer());
    if (viewerPeers.get(from) === pc) socket.emit('signal:answer', { to: from, sdp: pc.localDescription });
  } catch (e) { console.error(e); clearViewerPeer(from); toast('Não foi possível reproduzir uma transmissão.', true); }
}
async function receiveAnswer({ from, sdp }) {
  const pc = peers.get(from);
  if (!isPresenter || !pc || pc.signalingState !== 'have-local-offer') return;
  try {
    const maxKbps = Math.round((pc.__bitrate || (activeQuality || selectedQuality()).bitrate) / 1000);
    const hinted = { type: sdp.type, sdp: withBitrateHints(sdp.sdp, Math.round(maxKbps * 0.45), Math.round(maxKbps * 0.75)) };
    await pc.setRemoteDescription(hinted);
    await flushIce(from, pc, 'presenter');
  } catch (e) { console.warn('Resposta de conexão inválida:', e); }
}
async function receiveIce({ from, candidate, target }) {
  if (!currentRoom || !['viewer', 'presenter'].includes(target)) return;
  const pc = getConnection(from, target);
  const key = iceKey(from, target);
  if (!pc || !pc.remoteDescription) {
    const queued = iceQueue.get(key) || [];
    if (queued.length < 50) queued.push(candidate);
    iceQueue.set(key, queued); return;
  }
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ICE rejeitado:', e); }
}
function bindSocket() {
  socket = io({ reconnectionAttempts: 5 });
  socket.on('connect_error', (error) => toast(error.message || 'Erro de conexão.', true));
  socket.on('connect', () => logEvent('socket', 'conectado'));
  socket.on('disconnect', (reason) => {
    logEvent('socket', `desconectado: ${reason}`);
    if (currentRoom) {
      leaveRoomLocal();
      toast('Sua conexão caiu. Entre novamente na sala para continuar.', true);
    }
  });
  socket.on('rooms:list', renderRoomList);
  socket.on('room:members', (info) => {
    if (info.code !== currentRoom) return;
    updateMembers(info);
    const previous = activeSharers;
    activeSharers = new Set(info.sharers || []);
    for (const host of previous) if (!activeSharers.has(host)) clearViewerPeer(host);
    for (const host of activeSharers) {
      if (host !== socket.id) requestStream(host);
    }
    renderTiles(); updateControls();
  });
  socket.on('share:available', ({ host }) => {
    if (!currentRoom || host === socket.id) return;
    activeSharers.add(host); updateControls();
    updateRoomStatus('Conectando à transmissão...', 'Preparando vídeo da tela compartilhada');
    viewerRetries.delete(host); requestStream(host);
  });
  socket.on('share:ended', ({ host }) => {
    if (!currentRoom) return;
    activeSharers.delete(host); clearViewerPeer(host); streamRequests.delete(host); viewerRetries.delete(host); renderTiles(); updateControls();
    toast('Uma transmissão foi encerrada.');
  });
  socket.on('viewer:ready', ({ id }) => { if (isPresenter) makeOffer(id); });
  socket.on('peer:left', ({ id }) => {
    clearPeer(id); clearViewerPeer(id); activeSharers.delete(id);
    renderTiles(); updateControls();
  });
  socket.on('signal:offer', (data) => receiveOffer(data));
  socket.on('signal:answer', (data) => receiveAnswer(data));
  socket.on('signal:ice', (data) => receiveIce(data));
}
async function afterLogin(email) {
  $('accountBadge').textContent = email;
  config = await api('/api/config');
  if (!socket) bindSocket();
  showView('dashboard');
  if (!socket.connected) await new Promise((resolve) => socket.once('connect', resolve));
  refreshRooms();
  if (inviteCode && /^sala-\d$/i.test(inviteCode)) {
    // Socket.IO ainda pode estar no processo de abertura da conexão.
    if (!socket.connected) await new Promise((resolve) => socket.once('connect', resolve));
    await joinRoom(inviteCode).catch((error) => toast(error.message, true));
  }
}
function enterRoom(info) {
  measureUplink().then(() => rebalanceBitrates());
  logEvent('sala', `entrou em ${info.code} (${info.members} pessoa(s), ${(info.sharers || []).length} transmitindo)`);
  stopLocalShare(false); currentRoom = info.code;
  $('roomTitle').textContent = info.name || info.code; $('roomCodeDisplay').textContent = info.name || info.code;
  resetPlayback(); activeSharers = new Set(info.sharers || []);
  updateMembers(info); updateControls(); showView('room'); setUrl(info.code);
  startStatsMonitor();
  streamRequests.clear(); viewerRetries.clear();
  for (const host of activeSharers) if (host !== socket.id) requestStream(host);
}
async function joinRoom(code) {
  const info = await emitAck('room:join', { code: String(code).trim().toLowerCase() });
  enterRoom(info);
}
function renderRoomList(rooms) {
  const list = $('roomList');
  list.replaceChildren();
  for (const room of rooms || []) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'room-card' + (room.sharers ? ' is-live' : '');
    const full = room.members >= (room.maxMembers || config.maxMembers);
    card.disabled = full;
    const name = document.createElement('strong'); name.textContent = room.name;
    const status = document.createElement('span'); status.className = 'room-card-status';
    status.textContent = room.sharers ? `Ao vivo · ${room.sharers} transmitindo` : (room.members ? 'Sem transmissão' : 'Vazia');
    const people = document.createElement('small');
    people.textContent = room.members ? `${room.members} ${room.members === 1 ? 'pessoa' : 'pessoas'} na sala` : 'Ninguém na sala';
    const go = document.createElement('span'); go.className = 'room-card-go'; go.textContent = full ? 'Sala cheia' : 'Entrar →';
    card.append(name, status, people, go);
    card.addEventListener('click', () => joinRoom(room.code).catch((e) => toast(e.message, true)));
    list.appendChild(card);
  }
}
async function refreshRooms() {
  try { renderRoomList((await emitAck('rooms:list')).rooms); } catch { /* chega pelo evento rooms:list */ }
}
// O seletor de qualidade vale para os quatro modos de áudio.
function selectedQuality() { return QUALITY_PROFILES[$('qualitySelect').value] || QUALITY_PROFILES['1080p30']; }
function captureVideoConstraints(profile, surface) {
  return {
    width: { ideal: profile.width },
    height: { ideal: profile.height },
    frameRate: { ideal: profile.fps },
    ...(surface ? { displaySurface: surface } : {})
  };
}
async function tuneVideoTrack(stream, profile) {
  const track = stream.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.fps, max: profile.fps }
    });
  } catch (e) {
    // Captura permanece ativa se o navegador ignorar as preferências de resolução.
    console.warn('Resolução/FPS solicitados não foram aplicados pela fonte:', e);
  }
}
// Preferências da API: o navegador/app decide o que realmente entrega.
function displayOptions(profile, withAudio) {
  return {
    video: captureVideoConstraints(profile),
    audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    selfBrowserSurface: 'exclude',
    systemAudio: withAudio ? 'include' : 'exclude',
    surfaceSwitching: 'exclude'
  };
}
const desktop = window.telavivaDesktop || null; // presente só no app TelaViva Desktop
const desktopRoutes = Boolean(desktop && (desktop.platform === 'linux' || desktop.platform === 'win32')); // áudio roteado pelo app
let winAudioCtx = null; // Windows: contexto de áudio que toca o PCM vindo do app
function soundMode() { return document.querySelector('input[name="soundMode"]:checked')?.value || 'none'; }
function setupSoundOptions() {
  const nd = document.querySelector('input[value="nodiscord"]');
  let canExclude = true;
  if (!desktop) { canExclude = false; $('noDiscordHint').textContent = 'Disponível no app TelaViva Desktop'; }
  else if (!desktopRoutes) { canExclude = false; $('noDiscordHint').textContent = 'Disponível no Linux e no Windows'; }
  nd.disabled = !canExclude;
  if (desktopRoutes) {
    $('systemHint').textContent = 'Tudo que toca no computador, inclusive o Discord';
    nd.checked = true; // padrão no app: sem o Discord
  }
  updateSoundOptions();
}
function updateSoundOptions() {
  document.querySelectorAll('.sound-option').forEach((card) => {
    const input = card.querySelector('input');
    card.classList.toggle('selected', input.checked);
    card.classList.toggle('disabled', input.disabled);
  });
  const notes = {
    none: '',
    system: desktop ? '' : 'Na janela que o navegador abrir, marque “Compartilhar áudio”. Funciona melhor no Chrome/Edge (e ao compartilhar uma aba).',
    nodiscord: 'O som do Discord (a voz dos amigos) não será transmitido.'
  };
  $('soundNote').textContent = notes[soundMode()] || '';
}
// Windows: o app envia o áudio já mixado (sem Discord) em blocos PCM; um AudioWorklet transforma isso numa trilha.
async function captureWindowsAudio() {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule(new URL('pcm-worklet.js', document.baseURI).href);
    const node = new AudioWorkletNode(ctx, 'tv-pcm', { numberOfInputs: 0, outputChannelCount: [2] });
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    desktop.audio.setPcmHandler((buffer) => node.port.postMessage(buffer, [buffer]));
    await ctx.resume();
    winAudioCtx = ctx;
    return dest.stream;
  } catch (e) { ctx.close().catch(() => {}); throw e; }
}
function stopWindowsAudio() {
  if (!winAudioCtx) return;
  try { desktop.audio.setPcmHandler(null); } catch { /* sem app */ }
  winAudioCtx.close().catch(() => {}); winAudioCtx = null;
}
// Procura a entrada virtual criada pelo app desktop (TelaVivaFonte) e abre o áudio dela.
async function captureVirtualAudio() {
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); // só para liberar os nomes
  stopTracks(probe);
  let device;
  for (let i = 0; i < 6 && !device; i++) {
    device = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && /telavivafonte/i.test(d.label));
    if (!device) await new Promise((r) => setTimeout(r, 400));
  }
  if (!device) throw new Error('A fonte de áudio do TelaViva não foi encontrada. Tente novamente.');
  return navigator.mediaDevices.getUserMedia({ video: false, audio: {
    deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false
  } });
}
async function beginBroadcast(stream, originalStreams, expectedRoom) {
  if (!currentRoom || currentRoom !== expectedRoom || !socket?.connected) throw new Error('Você saiu da sala durante a seleção.');
  if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length > 1) throw new Error('Selecione um vídeo e, no máximo, uma fonte de áudio.');
  await emitAck('share:start');
  const videoTrackForHint = stream.getVideoTracks()[0];
  if (videoTrackForHint) videoTrackForHint.contentHint = preferSharp() ? 'detail' : 'motion';
  logEvent('share', `iniciou transmissão: ${stream.getVideoTracks().length} vídeo, ${stream.getAudioTracks().length} áudio, prioridade ${preferSharp() ? 'nitidez' : 'fluidez'}`);
  localStream = stream;
  observeVideoTrack(stream.getVideoTracks()[0], true);
  activeQuality = selectedQuality();
  activeAudioMode = soundMode();
  sourceStreams = originalStreams;
  pendingScreenStream = null;
  pendingMode = null;
  pendingRoom = null;
  isPresenter = true;
  activeSharers.add(socket.id);
  updateControls();
  displayStream(stream, true);
  setLive(true);
  updateRoomStatus(stream.getAudioTracks().length ? 'Sua tela e o áudio estão sendo compartilhados' : 'Sua tela está sendo compartilhada sem som', stream.getAudioTracks().length ? 'Transmitindo vídeo e áudio' : 'Transmitindo apenas vídeo');
  for (const track of stream.getTracks()) track.onended = () => stopLocalShare(true);
  // A captura de áudio independente tem vídeo descartado, mas se o usuário
  // fechar aquela aba, o áudio também deve encerrar a transmissão.
  for (const source of originalStreams) {
    for (const track of source.getTracks()) {
      if (!stream.getTracks().includes(track)) track.onended = () => stopLocalShare(true);
    }
  }
  previousStats = null;
  $('qualityStats').textContent = `Perfil: ${activeQuality.label} · aguardando espectador`;
  toast(stream.getAudioTracks().length ? 'Transmissão iniciada com som.' : 'Transmissão iniciada, sem som.');
}

// ---- mixer de som (app desktop no Linux): volume por programa durante a transmissão ----
let mixerTimer = null;
let mixerKeys = '';
const mixerDebounce = new Map();
function stopMixer() {
  clearInterval(mixerTimer); mixerTimer = null; mixerKeys = '';
  $('mixerPanel').classList.add('hidden'); $('mixerApps').replaceChildren();
}
function startMixer() {
  if (!desktop?.mixer) return;
  stopMixer();
  $('mixerPanel').classList.remove('hidden');
  refreshMixer();
  mixerTimer = setInterval(refreshMixer, 2000);
}
function debounced(key, fn) { clearTimeout(mixerDebounce.get(key)); mixerDebounce.set(key, setTimeout(fn, 80)); }
const MIXER_LINES = [['local', '🎧', 'Meu som'], ['tx', '📡', 'Transmissão']];
function buildMixerApp(app) {
  const box = document.createElement('div'); box.className = 'mixer-app'; box.dataset.key = app.key;
  const title = document.createElement('div'); title.className = 'mixer-app-name'; title.textContent = app.name; title.title = app.name;
  box.appendChild(title);
  for (const [which, icon, label] of MIXER_LINES) {
    const line = document.createElement('div'); line.className = 'mixer-line'; line.dataset.which = which;
    const mute = document.createElement('button'); mute.type = 'button'; mute.className = 'mixer-mute';
    mute.setAttribute('aria-label', `Silenciar ${label.toLowerCase()} de ${app.name}`);
    const text = document.createElement('span'); text.className = 'mixer-label'; text.textContent = `${icon} ${label}`;
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = (which === 'local' && desktop.platform === 'win32') ? '100' : '150';
    slider.setAttribute('aria-label', `${label}: volume de ${app.name}`);
    const out = document.createElement('output');
    const paint = () => { out.textContent = `${slider.value}%`; mute.textContent = line.dataset.muted === '1' ? '🔇' : '🔊'; line.classList.toggle('muted', line.dataset.muted === '1'); };
    slider.addEventListener('pointerdown', () => { line.dataset.busy = '1'; });
    slider.addEventListener('pointerup', () => { delete line.dataset.busy; });
    slider.addEventListener('input', () => { paint(); debounced(`${app.key}:${which}`, () => desktop.mixer.setVolume(app.key, which, Number(slider.value))); });
    mute.addEventListener('click', () => { line.dataset.muted = line.dataset.muted === '1' ? '0' : '1'; paint(); desktop.mixer.setMute(app.key, which, line.dataset.muted === '1'); });
    line.append(mute, text, slider, out);
    line.paint = paint;
    box.appendChild(line);
  }
  return box;
}
async function refreshMixer() {
  if (!desktop?.mixer || !isPresenter) return;
  let result;
  try { result = await desktop.mixer.apps(); } catch { return; }
  if (!result?.ok) return;
  const list = $('mixerApps');
  const keys = result.apps.map((a) => a.key).join('|');
  if (keys !== mixerKeys) { // lista de programas mudou: refaz só os blocos que faltam/sobram
    mixerKeys = keys;
    const existing = new Map([...list.children].map((el) => [el.dataset.key, el]));
    list.replaceChildren(...result.apps.map((a) => existing.get(a.key) || buildMixerApp(a)));
  }
  $('mixerEmpty').classList.toggle('hidden', result.apps.length > 0);
  for (const app of result.apps) { // sincroniza valores, sem mexer no que a pessoa está arrastando
    const box = [...list.children].find((el) => el.dataset.key === app.key);
    if (!box) continue;
    box.classList.toggle('idle', !app.active);
    for (const [which] of MIXER_LINES) {
      const line = box.querySelector(`.mixer-line[data-which="${which}"]`);
      if (!line || line.dataset.busy) continue;
      line.querySelector('input').value = String(app[which].volume);
      line.dataset.muted = app[which].muted ? '1' : '0';
      line.paint();
    }
  }
  const master = $('mixerMaster');
  if (!master.dataset.busy) { master.value = String(result.master); $('mixerMasterVal').textContent = `${result.master}%`; }
}
$('mixerMaster').addEventListener('pointerdown', (e) => { e.target.dataset.busy = '1'; });
$('mixerMaster').addEventListener('pointerup', (e) => { delete e.target.dataset.busy; });
$('mixerMaster').addEventListener('input', (e) => { $('mixerMasterVal').textContent = `${e.target.value}%`; debounced('master', () => desktop.mixer.setMaster(Number(e.target.value))); });

async function startSharing() {
  if (!currentRoom || activeSharers.size >= (config.maxSharers || 3) || isPresenter) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Use HTTPS ou http://localhost em um navegador compatível.', true);
    return;
  }
  const mode = soundMode();
  const room = currentRoom;
  const profile = selectedQuality();
  let stream, audioStream, routed = false;
  $('shareBtn').disabled = true;
  try {
    if (desktopRoutes && mode !== 'none') {
      // App desktop: prepara o roteamento. 'system' inclui o Discord; 'nodiscord' o exclui.
      const r = await desktop.audio.start({ includeDiscord: mode === 'system' });
      if (!r.ok) throw new Error(r.error || 'Não foi possível preparar o áudio.');
      routed = true;
    }
    stream = await navigator.mediaDevices.getDisplayMedia(displayOptions(profile, !routed && mode !== 'none'));
    await tuneVideoTrack(stream, profile);
    let finalStream = stream, sources = [stream];
    if (routed) {
      audioStream = desktop.platform === 'win32' ? await captureWindowsAudio() : await captureVirtualAudio();
      finalStream = new MediaStream([stream.getVideoTracks()[0], audioStream.getAudioTracks()[0]]);
      sources = [stream, audioStream];
    } else if (mode !== 'none' && !stream.getAudioTracks().length) {
      toast('O navegador não enviou som. Na janela de seleção, marque “Compartilhar áudio”. Transmitindo só a imagem.', true);
    }
    desktopRoutedAudio = routed;
    await beginBroadcast(finalStream, sources, room);
    measureUplink().then(() => rebalanceBitrates());
    if (routed) startMixer();
  } catch (e) {
    stopTracks(audioStream);
    if (stream && stream !== localStream) stopTracks(stream);
    if (routed) { stopWindowsAudio(); desktop.audio.stop().catch(() => {}); }
    if (e.name !== 'NotAllowedError') toast(`Não foi possível iniciar: ${e.message}`, true);
  } finally { updateControls(); }
}

// Mostra estatísticas do fluxo efetivamente recebido/enviado (não só a meta escolhida).
function stopStatsMonitor() {
  clearInterval(statsTimer);
  statsTimer = null;
  previousStats = null;
}
function startStatsMonitor() {
  stopStatsMonitor();
  statsTimer = setInterval(() => { refreshStreamStats().catch(() => {}); }, 2000);
}
async function refreshStreamStats() {
  if (!currentRoom) return;
  const peer = isPresenter ? peers.values().next().value : viewerPeers.values().next().value;
  if (!peer || peer.connectionState === 'closed') {
    if (isPresenter) setNetworkHealth('aguardando espectador');
    $('qualityStats').textContent = isPresenter && activeQuality
      ? `Perfil: ${activeQuality.label} · aguardando espectador`
      : 'Qualidade real: aguardando vídeo';
    previousStats = null;
    return;
  }
  const direction = isPresenter ? 'outbound-rtp' : 'inbound-rtp';
  const reports = await peer.getStats();
  let videoReport = null;
  reports.forEach((item) => {
    if (item.type === direction && (item.kind === 'video' || item.mediaType === 'video') && !item.isRemote) videoReport = item;
  });
  if (!videoReport) return;
  const resolution = videoReport.frameWidth && videoReport.frameHeight
    ? `${videoReport.frameWidth} × ${videoReport.frameHeight}` : null;
  const counter = isPresenter ? videoReport.framesEncoded : videoReport.framesDecoded;
  const bytes = isPresenter ? videoReport.bytesSent : videoReport.bytesReceived;
  const key = `${direction}:${videoReport.id}`;
  const prev = previousStats?.key === key ? previousStats : null;
  const freezes = Number(videoReport.freezeCount || 0);
  const dropped = Number(videoReport.framesDropped || 0);
  const lost = Number(videoReport.packetsLost || 0);
  const seconds = prev ? (videoReport.timestamp - prev.timestamp) / 1000 : 0;
  let fps = Number(videoReport.framesPerSecond);
  if (!Number.isFinite(fps) || fps <= 0) {
    fps = prev && seconds > 0 && Number.isFinite(counter) && Number.isFinite(prev.counter)
      ? Math.max(0, (counter - prev.counter) / seconds) : null;
  }
  const mbps = prev && seconds > 0 && Number.isFinite(bytes) && Number.isFinite(prev.bytes)
    ? Math.max(0, ((bytes - prev.bytes) * 8 / seconds / 1_000_000)) : null;
  const newFreezes = prev ? Math.max(0, freezes - prev.freezes) : 0;
  const newDropped = prev ? Math.max(0, dropped - prev.dropped) : 0;
  const newLost = prev ? Math.max(0, lost - prev.lost) : 0;
  previousStats = { key, timestamp: videoReport.timestamp, counter, bytes, freezes, dropped, lost };
  const parts = [isPresenter ? 'Enviando' : 'Recebendo'];
  if (resolution) parts.push(resolution);
  if (fps !== null) parts.push(`${Math.round(fps)} FPS`);
  if (mbps !== null) parts.push(`${mbps.toFixed(1)} Mb/s`);
  $('qualityStats').textContent = parts.length > 1 ? parts.join(' · ') : 'Medindo qualidade real...';
  const measured = [resolution || 'resolução indisponível', fps === null ? 'FPS indisponível' : `${Math.round(fps)} FPS`,
    `${freezes} congelamentos`, `${dropped} quadros descartados`, `${lost} pacotes perdidos`];
  diagnosticState.lastVideo = measured.join(' · ');
  if (newFreezes > 0) setNetworkHealth(`${newFreezes} novo(s) congelamento(s) detectado(s)`);
  else if (newLost > 4) setNetworkHealth(`${newLost} pacotes perdidos desde última medição`);
  else if (newDropped > 8) setNetworkHealth(`${newDropped} quadros descartados desde última medição`);
  else setNetworkHealth(peer.connectionState === 'connected' ? 'conectado, sem anomalia detectada' : `conexão ${peer.connectionState}`);
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').classList.add('hidden');
  const button = $('loginSubmit');
  button.disabled = true;
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({
      email: $('email').value.trim(), password: $('password').value
    }) });
    $('password').value = '';
    await afterLogin(result.email);
  } catch (e) {
    $('loginError').textContent = e.message;
    $('loginError').classList.remove('hidden');
  } finally { button.disabled = false; }
});
$('togglePassword').addEventListener('click', () => {
  const input = $('password');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('togglePassword').textContent = input.type === 'password' ? 'Mostrar' : 'Ocultar';
});

// ---- alterar senha ------------------------------------------------------
function openPasswordModal() {
  $('passwordForm').reset(); $('pwError').classList.add('hidden');
  for (const id of ['pwCurrent', 'pwNew', 'pwConfirm']) $(id).type = 'password';
  $('passwordModal').classList.remove('hidden');
  $('pwCurrent').focus();
}
function closePasswordModal() { $('passwordModal').classList.add('hidden'); $('passwordForm').reset(); }
function pwFail(message) { $('pwError').textContent = message; $('pwError').classList.remove('hidden'); }
$('changePasswordBtn').addEventListener('click', openPasswordModal);
$('pwCancel').addEventListener('click', closePasswordModal);
$('passwordModal').addEventListener('click', (e) => { if (e.target === $('passwordModal')) closePasswordModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('passwordModal').classList.contains('hidden')) closePasswordModal(); });
$('pwShow').addEventListener('change', (e) => { for (const id of ['pwCurrent', 'pwNew', 'pwConfirm']) $(id).type = e.target.checked ? 'text' : 'password'; });
$('passwordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('pwError').classList.add('hidden');
  const currentPassword = $('pwCurrent').value, newPassword = $('pwNew').value;
  if (newPassword.length < 10) return pwFail('A nova senha deve ter pelo menos 10 caracteres.');
  if (newPassword !== $('pwConfirm').value) return pwFail('A confirmação não é igual à nova senha.');
  if (newPassword === currentPassword) return pwFail('A nova senha deve ser diferente da atual.');
  $('pwSubmit').disabled = true;
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    closePasswordModal();
    toast('Senha alterada com sucesso.');
  } catch (e) { pwFail(e.message); }
  finally { $('pwSubmit').disabled = false; }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    if (currentRoom) {
      stopLocalShare(true);
      await emitAck('room:leave').catch(() => {});
      leaveRoomLocal();
    }
    await api('/api/logout', { method: 'POST' });
    socket?.disconnect();
    socket = null;
    $('email').value = '';
    $('password').value = '';
    showView('auth');
    toast('Você saiu da sua conta.');
  } catch (e) { toast(e.message, true); }
});
$('leaveRoomBtn').addEventListener('click', async () => {
  stopLocalShare(true);
  if (socket?.connected) await emitAck('room:leave').catch(() => {});
  leaveRoomLocal();
});
$('shareBtn').addEventListener('click', startSharing);
$('reportSendBtn').addEventListener('click', sendReport);
$('reportDismissBtn').addEventListener('click', () => $('reportBar').classList.add('hidden'));
$('sendReportBtn').addEventListener('click', sendReport);
$('copyDiagnosticBtn').addEventListener('click', async () => {
  // Sem credenciais, e-mail, código da sala, conteúdo da tela ou IP no relatório.
  const track = localStream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  const report = [
    'TelaViva 1.6 — diagnóstico local',
    `Captura: ${diagnosticState.capture}`,
    `WebRTC: ${diagnosticState.network}`,
    `Vídeo: ${diagnosticState.lastVideo}`,
    `Perfil: ${(activeQuality || selectedQuality()).label}`,
    `Fonte: ${settings.displaySurface || 'não informada'}`,
    `Fonte FPS: ${settings.frameRate ?? 'não informado'}`,
    `Fonte resolução: ${settings.width || '?'} x ${settings.height || '?'}`,
    `Sistema/navegador: ${navigator.userAgent}`
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    toast('Diagnóstico copiado. Cole aqui para investigarmos as piscadas.');
  } catch {
    console.info(report);
    toast('Não foi possível copiar. O diagnóstico foi exibido no console (F12).', true);
  }
});
$('enableAudioBtn').addEventListener('click', () => {
  const videos = [...videoTiles.entries()].filter(([id]) => id !== 'local').map(([, tile]) => tile.video);
  Promise.allSettled(videos.map((video) => { video.muted = false; video.volume = 1; return video.play(); }))
    .then(() => toast('Áudio das transmissões ativado.'));
});
document.querySelectorAll('input[name="soundMode"]').forEach((c) => c.addEventListener('change', updateSoundOptions));
setupSoundOptions();
renderDiagnostics();
$('stopBtn').addEventListener('click', () => { stopLocalShare(true); toast('Você parou de compartilhar a tela.'); });
$('copyLinkBtn').addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(inviteUrl(currentRoom));
    toast('Link de convite copiado!');
  } catch { toast(`Copie o endereço: ${inviteUrl(currentRoom)}`); }
});
$('fullscreenBtn').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await ($('videoGrid').classList.contains('hidden') ? $('screenStage') : $('videoGrid')).requestFullscreen();
    else await document.exitFullscreen();
  } catch (e) { toast(`Não foi possível ativar tela cheia: ${e.message}`, true); }
});

(async () => {
  try {
    const response = await api('/api/me');
    if (response.authenticated) await afterLogin(response.email);
    else showView('auth');
  } catch (e) { showView('auth'); toast('Não foi possível conectar ao servidor.', true); }
})();
