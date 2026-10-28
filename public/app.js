'use strict';

const $ = (id) => document.getElementById(id);
const views = { auth: $('authView'), dashboard: $('dashboardView'), room: $('roomView') };
const stageVideo = $('stageVideo');
const stageEmpty = $('stageEmpty');
let socket = null;
let currentRoom = null;
let currentHost = null;
let localStream = null;
let sourceStreams = []; // Streams originais são encerrados com a transmissão.
let pendingScreenStream = null;
let pendingMode = null;
let pendingRoom = null;
let activeAudioMode = null;
let availableAudioDevices = new Map();
let remoteReceivedStream = null;
let isPresenter = false;
let viewerPeer = null;
let viewerPeerId = null;
let peers = new Map();
let iceQueue = new Map();
let config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], maxMembers: 8 };
let toastTimer;
// Perfis de transmissão: limites desejados, não garantias de rede/codificador.
const QUALITY_PROFILES = Object.freeze({
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 3_000_000, label: 'HD 720p · 30 FPS' },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, label: 'Full HD 1080p · 30 FPS' },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000, label: 'Full HD 1080p · 60 FPS' }
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
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 4500);
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
  const busy = Boolean(pendingScreenStream);
  $('shareBtn').classList.toggle('hidden', busy || isPresenter || Boolean(currentHost));
  $('stopBtn').classList.toggle('hidden', !isPresenter);
  $('youStatus').textContent = isPresenter
    ? (localStream?.getAudioTracks().length ? 'Compartilhando tela e som' : 'Compartilhando tela sem som')
    : 'Conectado à sala';
  $('audioSettings').classList.toggle('hidden', busy || isPresenter || Boolean(currentHost));
  $('audioFallbackPanel').classList.toggle('hidden', !busy);
  $('fallbackChoices').classList.toggle('hidden', pendingMode !== 'pick');
  $('virtualDevicePanel').classList.toggle('hidden', pendingMode !== 'virtual');
  const needsAudioStep = pendingMode === 'virtual' || pendingMode === 'screen-tab';
  $('completeAudioBtn').classList.toggle('hidden', !needsAudioStep);
  $('completeAudioBtn').textContent = pendingMode === 'screen-tab' ? 'Selecionar a aba com som' : 'Adicionar som à transmissão';
  $('cancelPendingBtn').classList.toggle('hidden', !busy);
  $('shareBtn').disabled = busy || isPresenter || Boolean(currentHost);
  $('qualitySettings').classList.toggle('hidden', Boolean(currentHost) && !isPresenter);
  $('qualitySelect').disabled = busy || isPresenter || Boolean(currentHost);
  if (busy) updateFallbackMessage();
}
function updateMembers(info) {
  $('membersCount').textContent = `${info.members} / ${config.maxMembers}`;
  $('othersRow').classList.toggle('hidden', info.members <= 1);
  $('othersCount').textContent = `${info.members - 1} outra(s) pessoa(s)`;
}
function updateAudioStatus(stream, own = false) {
  const hasAudio = Boolean(stream?.getAudioTracks().length);
  $('audioStatus').textContent = hasAudio ? (own ? 'Áudio: enviando' : 'Áudio: recebido') : 'Áudio: ausente';
  $('enableAudioBtn').classList.toggle('hidden', own || !hasAudio);
}
function displayStream(stream, own = false) {
  // O evento ontrack pode chegar separadamente para vídeo e áudio.
  // Não redefinir srcObject nem reiniciar play() a cada trilha evita flashes
  // desnecessários e preserva a reprodução já iniciada.
  const changed = stageVideo.srcObject !== stream;
  if (changed) stageVideo.srcObject = stream;
  stageVideo.muted = own;
  updateAudioStatus(stream, own);
  stageVideo.controls = !own;
  stageVideo.classList.remove('hidden');
  stageEmpty.classList.add('hidden');
  if (changed || stageVideo.paused) {
    stageVideo.play().catch(() => { if (!own) toast('Use o botão Ativar som ou clique no vídeo para reproduzir.'); });
  }
}
function hideStream() {
  stageVideo.pause();
  stageVideo.srcObject = null;
  $('audioStatus').textContent = 'Áudio: aguardando';
  $('enableAudioBtn').classList.add('hidden');
  stageVideo.classList.add('hidden');
  stageEmpty.classList.remove('hidden');
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
function getConnection(id) {
  return isPresenter ? peers.get(id) : viewerPeerId === id ? viewerPeer : null;
}
function clearPeer(id) {
  const peer = peers.get(id);
  if (peer) { peer.close(); peers.delete(id); }
  iceQueue.delete(id);
}
function clearViewerPeer() {
  if (viewerPeer) viewerPeer.close();
  viewerPeer = null;
  viewerPeerId = null;
  remoteReceivedStream = null;
}

function cleanupPeers() {
  peers.forEach((peer) => peer.close());
  peers.clear();
  clearViewerPeer();
  iceQueue.clear();
}
function resetPlayback() {
  setCaptureHealth('aguardando');
  setNetworkHealth('aguardando');
  cleanupPeers();
  currentHost = null;
  setLive(false);
  hideStream();
  updateRoomStatus('Aguardando compartilhamento de tela', 'Sala pronta para compartilhar');
  updateControls();
}
function stopTracks(stream) {
  stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
}
function stopLocalShare(notify = true) {
  const wasSharing = isPresenter || Boolean(localStream);
  isPresenter = false;
  const streams = [...sourceStreams, pendingScreenStream, localStream];
  sourceStreams = [];
  pendingScreenStream = null;
  pendingMode = null;
  pendingRoom = null;
  localStream = null;
  if (notify && wasSharing && socket?.connected) socket.emit('share:stop');
  new Set(streams.filter(Boolean)).forEach(stopTracks);
  activeQuality = null;
  activeAudioMode = null;
  resetPlayback();
  updateAudioModeInfo();
}
function discardPendingShare() {
  stopTracks(pendingScreenStream);
  pendingScreenStream = null;
  pendingMode = null;
  pendingRoom = null;
  hideStream();
  updateRoomStatus('Aguardando compartilhamento de tela', 'Sala pronta para compartilhar');
  updateControls();
  updateAudioModeInfo();
}

function leaveRoomLocal() {
  stopStatsMonitor();
  stopLocalShare(false);
  currentRoom = null;
  $('roomTitle').textContent = '—';
  setUrl(null);
  showView('dashboard');
}
function createPeer(remoteId, ownStream) {
  const pc = new RTCPeerConnection({ iceServers: config.iceServers });
  pc.onicecandidate = (event) => {
    if (event.candidate && socket?.connected) socket.emit('signal:ice', { to: remoteId, candidate: event.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if ((isPresenter && peers.get(remoteId) === pc) || (!isPresenter && viewerPeer === pc)) {
      setNetworkHealth(`conexão ${pc.connectionState}`);
    }
    if (pc.connectionState === 'failed') {
      toast('A conexão de vídeo falhou. Algumas redes exigem um servidor TURN.', true);
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
    const encoding = { maxBitrate: profile.bitrate, maxFramerate: profile.fps, scaleResolutionDownBy: scale };
    if (videoTrack) {
      try {
        pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [ownStream], sendEncodings: [encoding] });
      } catch (error) {
        // Fallback para navegadores que não aceitam sendEncodings em addTransceiver.
        console.warn('Limites de codificação não suportados diretamente:', error);
        const sender = pc.addTrack(videoTrack, ownStream);
        try {
          const params = sender.getParameters();
          if (params.encodings?.length) {
            params.encodings[0].maxBitrate = profile.bitrate;
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
async function flushIce(id, peer) {
  const queued = iceQueue.get(id) || [];
  iceQueue.delete(id);
  for (const candidate of queued) {
    try { await peer.addIceCandidate(candidate); } catch (e) { console.warn('Candidato ICE rejeitado:', e); }
  }
}
async function makeOffer(id) {
  if (!isPresenter || !localStream || !currentRoom || !socket?.connected || id === socket.id) return;
  clearPeer(id);
  const pc = createPeer(id, localStream);
  peers.set(id, pc);
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
  if (!currentRoom || isPresenter || !currentHost || from !== currentHost) return;
  clearViewerPeer();
  remoteReceivedStream = new MediaStream();
  const pc = createPeer(from, null);
  viewerPeer = pc;
  viewerPeerId = from;
  pc.ontrack = (event) => {
    if (viewerPeer !== pc) return;
    if (!remoteReceivedStream.getTracks().some((track) => track.id === event.track.id)) {
      remoteReceivedStream.addTrack(event.track);
    }
    if (event.track.kind === 'video') observeVideoTrack(event.track, false);
    displayStream(remoteReceivedStream);
    setLive(true);
    updateRoomStatus('Você está assistindo ao compartilhamento', 'Recebendo tela em tempo real');
  };
  try {
    await pc.setRemoteDescription(sdp);
    await flushIce(from, pc);
    await pc.setLocalDescription(await pc.createAnswer());
    if (viewerPeer === pc) socket.emit('signal:answer', { to: from, sdp: pc.localDescription });
  } catch (e) { console.error(e); clearViewerPeer(); toast('Não foi possível reproduzir a transmissão.', true); }
}
async function receiveAnswer({ from, sdp }) {
  const pc = peers.get(from);
  if (!isPresenter || !pc) return;
  try {
    await pc.setRemoteDescription(sdp);
    await flushIce(from, pc);
  } catch (e) { console.warn('Resposta de conexão inválida:', e); }
}
async function receiveIce({ from, candidate }) {
  if (!currentRoom) return;
  const pc = getConnection(from);
  if (!pc || !pc.remoteDescription) {
    const queued = iceQueue.get(from) || [];
    if (queued.length < 50) queued.push(candidate);
    iceQueue.set(from, queued);
    return;
  }
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ICE rejeitado:', e); }
}
function bindSocket() {
  socket = io({ reconnectionAttempts: 5 });
  socket.on('connect_error', (error) => toast(error.message || 'Erro de conexão.', true));
  socket.on('disconnect', () => {
    if (currentRoom) {
      leaveRoomLocal();
      toast('Sua conexão caiu. Entre novamente na sala para continuar.', true);
    }
  });
  socket.on('room:members', (info) => {
    if (info.code !== currentRoom) return;
    updateMembers(info);
    if (!info.hasHost && !isPresenter && currentHost) resetPlayback();
  });
  socket.on('share:available', ({ host }) => {
    if (!currentRoom || host === socket.id) return;
    currentHost = host;
    updateControls();
    updateRoomStatus('Conectando à transmissão...', 'Preparando vídeo da tela compartilhada');
    socket.emit('viewer:ready');
  });
  socket.on('share:ended', () => {
    if (!currentRoom) return;
    if (isPresenter) stopLocalShare(false);
    else resetPlayback();
    toast('O compartilhamento foi encerrado.');
  });
  socket.on('viewer:ready', ({ id }) => { if (isPresenter) makeOffer(id); });
  socket.on('peer:left', ({ id }) => {
    clearPeer(id);
    if (viewerPeerId === id) resetPlayback();
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
  if (inviteCode && /^[A-F\d]{4}-[A-F\d]{4}-[A-F\d]{4}$/i.test(inviteCode)) {
    // Socket.IO ainda pode estar no processo de abertura da conexão.
    if (!socket.connected) await new Promise((resolve) => socket.once('connect', resolve));
    await joinRoom(inviteCode).catch((error) => toast(error.message, true));
  }
}
function enterRoom(info) {
  stopLocalShare(false);
  currentRoom = info.code;
  $('roomTitle').textContent = info.code;
  $('roomCodeDisplay').textContent = info.code;
  updateMembers(info);
  resetPlayback();
  currentHost = info.hostId || null;
  updateControls();
  showView('room');
  setUrl(info.code);
  startStatsMonitor();
  if (info.hasHost && !isPresenter) {
    updateRoomStatus('Conectando à transmissão...', 'Aguardando imagens do apresentador');
    socket.emit('viewer:ready');
  }
}
async function createRoom() {
  try {
    const info = await emitAck('room:create');
    enterRoom(info);
    toast('Sala criada. Compartilhe o link com quem deseja convidar.');
  } catch (e) { toast(e.message, true); }
}
async function joinRoom(code) {
  const normalized = String(code).trim().toUpperCase();
  if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(normalized)) throw new Error('Informe um código no formato XXXX-XXXX-XXXX.');
  const info = await emitAck('room:join', { code: normalized });
  enterRoom(info);
  toast('Você entrou na sala.');
}
// O seletor de qualidade vale para os quatro modos de áudio.
function selectedQuality() { return QUALITY_PROFILES[$('qualitySelect').value] || QUALITY_PROFILES['1080p30']; }
function updateQualityInfo() {
  const profile = selectedQuality();
  $('qualityInfo').textContent = `${profile.width} × ${profile.height} · até ${profile.fps} FPS · limite de vídeo ${(profile.bitrate / 1_000_000).toFixed(0)} Mb/s por espectador. A qualidade efetiva depende da captura e da conexão.`;
}
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
// O modo nativo solicita áudio da janela/tela ao navegador, enquanto os modos
// de aba/virtual continuam permitindo evitar o som de outros programas.
function nativeCaptureOptions(profile, withAudio = true) { return {
  video: captureVideoConstraints(profile),
  audio: withAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  // Estes parâmetros apenas pedem que o navegador ofereça áudio.
  // Nem o sistema operacional nem o seletor podem ser controlados pelo site.
  selfBrowserSurface: 'exclude',
  systemAudio: withAudio ? 'include' : 'exclude',
  windowAudio: withAudio ? 'system' : 'exclude',
  surfaceSwitching: 'exclude'
}; }
function tabCaptureOptions(profile) { return {
  video: captureVideoConstraints(profile, 'browser'),
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  monitorTypeSurfaces: 'exclude',
  selfBrowserSurface: 'exclude',
  systemAudio: 'exclude',
  windowAudio: 'exclude',
  surfaceSwitching: 'exclude'
}; }
function assertTabAudio(stream) {
  const surface = stream.getVideoTracks()[0]?.getSettings()?.displaySurface;
  if (surface !== 'browser') {
    throw new Error('Selecione uma ABA do navegador, não a tela ou uma janela. O áudio geral pode conter o Discord.');
  }
  if (stream.getAudioTracks().length < 1) {
    throw new Error('Nenhum áudio recebido. Selecione uma aba e marque "Compartilhar áudio da aba" no navegador.');
  }
}
function shareSurface() { return document.querySelector('input[name="shareSurface"]:checked')?.value || 'screen'; }
function wantsSound() { return $('shareSound').checked; }
function audioMode() {
  if (!wantsSound()) return 'silent';
  if (shareSurface() === 'tab') return 'tab';
  return $('isolateAudio').checked ? 'virtual' : 'native';
}
function updateAudioModeInfo() {
  document.querySelectorAll('.share-choice').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input')?.checked);
  });
  const mode = audioMode();
  $('isolateAudio').disabled = !wantsSound() || shareSurface() === 'tab';
  const hints = {
    native: 'Escolha a tela ou janela. Na janela do navegador, marque “Compartilhar áudio”, se aparecer. Caso não apareça, você poderá escolher outra fonte de som. O áudio geral pode incluir o Discord.',
    tab: 'Escolha uma guia no seletor do navegador e marque “Compartilhar áudio da guia”. O som do Discord desktop não entra nessa captura.',
    virtual: 'Primeiro escolha a tela ou janela. Depois selecione a fonte virtual TelaVivaFonte para transmitir somente os programas configurados nela.',
    silent: 'O compartilhamento terá apenas imagem, sem áudio.'
  };
  $('audioModeInfo').textContent = hints[mode];
}
function updateFallbackMessage() {
  if (!pendingScreenStream) return;
  const messages = {
    pick: ['O navegador não ofereceu som para essa tela ou janela', 'A captura de vídeo está pronta. No Ubuntu/Chromium isso é comum. Você pode adicionar o som de uma aba, usar uma fonte virtual já configurada ou continuar sem som.'],
    'screen-tab': ['Adicione o som de uma aba', 'Clique no botão e selecione a aba que está reproduzindo o som. A imagem continuará mostrando a tela ou janela que você escolheu antes.'],
    virtual: ['Escolha a fonte de áudio do computador', 'Selecione a entrada virtual TelaVivaFonte. Ela precisa ter sido configurada no sistema operacional para não incluir o Discord.']
  };
  const [title, detail] = messages[pendingMode] || ['Seleção de som', 'Conclua a seleção para transmitir.'];
  $('audioFallbackTitle').textContent = title;
  $('audioFallbackText').textContent = detail;
}
async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) throw new Error('O navegador não oferece seleção de dispositivos.');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications');
  availableAudioDevices = new Map(devices.map((device) => [device.deviceId, device.label]));
  const select = $('virtualAudioInput');
  select.replaceChildren(new Option('Escolha uma entrada virtual...', ''));
  for (const device of devices) {
    const label = device.label || 'Entrada sem identificação (autorize a lista para ver o nome)';
    const option = new Option(label, device.deviceId);
    select.add(option);
  }
  $('virtualAudioHelp').textContent = devices.length
    ? 'Escolha TelaVivaFonte (ou outra fonte virtual configurada). Nunca selecione seu microfone pessoal.'
    : 'Nenhum dispositivo visível. Crie uma fonte virtual no Ubuntu e atualize a lista.';
}
async function unlockInputLabels() {
  // Permissão local e temporária apenas para descobrir os nomes dos dispositivos.
  // Não há transmissão nem armazenamento do áudio desta leitura.
  let probe;
  try {
    probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    await listAudioInputs();
    toast('Lista atualizada. A captura temporária usada para identificar dispositivos foi encerrada.');
  } catch (e) { toast(`Não foi possível identificar as entradas: ${e.message}`, true); }
  finally { stopTracks(probe); }
}
async function beginBroadcast(stream, originalStreams, expectedRoom) {
  if (!currentRoom || currentRoom !== expectedRoom || !socket?.connected) throw new Error('Você saiu da sala durante a seleção.');
  if (stream.getVideoTracks().length !== 1 || stream.getAudioTracks().length > 1) throw new Error('Selecione um vídeo e, no máximo, uma fonte de áudio.');
  await emitAck('share:start');
  localStream = stream;
  observeVideoTrack(stream.getVideoTracks()[0], true);
  activeQuality = selectedQuality();
  activeAudioMode = pendingMode === 'screen-tab' ? 'screen-tab' : pendingMode === 'virtual' ? 'virtual' : audioMode();
  sourceStreams = originalStreams;
  pendingScreenStream = null;
  pendingMode = null;
  pendingRoom = null;
  isPresenter = true;
  currentHost = socket.id;
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
  toast(`Transmissão iniciada (${activeQuality.label}). ${!stream.getAudioTracks().length ? 'Sem áudio.' : activeAudioMode === 'native' ? 'A captura do áudio geral pode incluir Discord.' : 'Confirme que apenas o áudio desejado está sendo transmitido.'}`);
}
async function startSharing() {
  if (!currentRoom || currentHost || isPresenter || pendingScreenStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Use HTTPS ou http://localhost em um navegador compatível.', true);
    return;
  }
  const mode = audioMode();
  const room = currentRoom;
  const profile = selectedQuality();
  let stream;
  $('shareBtn').disabled = true;
  try {
    if (mode === 'tab') {
      stream = await navigator.mediaDevices.getDisplayMedia(tabCaptureOptions(profile));
      assertTabAudio(stream);
      await tuneVideoTrack(stream, profile);
      await beginBroadcast(stream, [stream], room);
    } else if (mode === 'silent') {
      const onlyTab = shareSurface() === 'tab';
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: captureVideoConstraints(profile, onlyTab ? 'browser' : undefined), audio: false,
        ...(onlyTab ? { monitorTypeSurfaces: 'exclude' } : {}),
        selfBrowserSurface: 'exclude', systemAudio: 'exclude', windowAudio: 'exclude'
      });
      if (onlyTab && stream.getVideoTracks()[0]?.getSettings?.().displaySurface !== 'browser') {
        throw new Error('Escolha uma aba, ou mude a opção para Tela ou janela.');
      }
      await tuneVideoTrack(stream, profile);
      await beginBroadcast(stream, [stream], room);
    } else if (mode === 'native') {
      stream = await navigator.mediaDevices.getDisplayMedia(nativeCaptureOptions(profile, true));
      await tuneVideoTrack(stream, profile);
      if (stream.getAudioTracks().length) {
        await beginBroadcast(stream, [stream], room);
      } else {
        // A escolha de áudio é exclusiva do navegador; o site não pode obrigá-lo.
        if (currentRoom !== room) throw new Error('A sala mudou durante a seleção.');
        pendingScreenStream = stream;
        pendingMode = 'pick';
        pendingRoom = room;
        stream.getVideoTracks()[0].onended = discardPendingShare;
        displayStream(stream, true);
        updateControls();
        updateRoomStatus('Imagem selecionada, aguardando uma fonte de áudio', 'Escolha uma das opções abaixo.');
        toast('O navegador retornou vídeo, mas não ofereceu som. Escolha como continuar.', true);
      }
    } else if (mode === 'virtual') {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: captureVideoConstraints(profile), audio: false,
        selfBrowserSurface: 'exclude', systemAudio: 'exclude', windowAudio: 'exclude'
      });
      await tuneVideoTrack(stream, profile);
      if (currentRoom !== room) throw new Error('A sala mudou durante a seleção.');
      pendingScreenStream = stream;
      pendingMode = 'virtual';
      pendingRoom = room;
      stream.getVideoTracks()[0].onended = discardPendingShare;
      displayStream(stream, true);
      updateControls();
      updateRoomStatus('Imagem selecionada. Agora escolha a fonte virtual de áudio.', 'Selecione TelaVivaFonte abaixo.');
      listAudioInputs().catch(() => {});
    }
  } catch (e) {
    if (stream && stream !== localStream && stream !== pendingScreenStream) stopTracks(stream);
    if (e.name !== 'NotAllowedError') toast(`Não foi possível iniciar: ${e.message}`, true);
  } finally { $('shareBtn').disabled = false; }
}

function chooseFallback(mode) {
  if (pendingMode !== 'pick' || !pendingScreenStream) return;
  pendingMode = mode;
  updateControls();
  if (mode === 'virtual') listAudioInputs().catch(() => {});
}
async function continueWithoutSound() {
  if (pendingMode !== 'pick' || !pendingScreenStream) return;
  try {
    await beginBroadcast(pendingScreenStream, [pendingScreenStream], pendingRoom);
  } catch (e) { toast(e.message, true); }
}

async function finishSharing() {
  if (!pendingScreenStream || isPresenter) return;
  const videoStream = pendingScreenStream;
  const mode = pendingMode;
  const room = pendingRoom;
  let audioStream;
  $('completeAudioBtn').disabled = true;
  try {
    if (mode === 'screen-tab') {
      audioStream = await navigator.mediaDevices.getDisplayMedia(tabCaptureOptions(selectedQuality()));
      assertTabAudio(audioStream);
    } else if (mode === 'virtual') {
      const deviceId = $('virtualAudioInput').value;
      const label = availableAudioDevices.get(deviceId) || '';
      if (!deviceId || !/telavivafonte/i.test(label)) {
        throw new Error('Escolha uma fonte virtual identificada, como TelaVivaFonte. Microfones comuns não são aceitos.');
      }
      audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false
      } });
    } else throw new Error('Modo de áudio inválido.');
    if (!pendingScreenStream || videoStream !== pendingScreenStream) throw new Error('A seleção de tela foi cancelada.');
    const audioTrack = audioStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('A fonte escolhida não forneceu áudio.');
    const merged = new MediaStream([videoStream.getVideoTracks()[0], audioTrack]);
    await beginBroadcast(merged, [videoStream, audioStream], room);
  } catch (e) {
    stopTracks(audioStream);
    if (e.name !== 'NotAllowedError') toast(`Áudio não selecionado: ${e.message}`, true);
  } finally { $('completeAudioBtn').disabled = false; }
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
  const peer = isPresenter ? peers.values().next().value : viewerPeer;
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
$('createRoomBtn').addEventListener('click', createRoom);
$('joinRoomForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await joinRoom($('roomCodeInput').value); } catch (e) { toast(e.message, true); }
});
$('roomCodeInput').addEventListener('input', (event) => {
  const raw = event.target.value.replace(/[^a-f\d]/gi, '').toUpperCase().slice(0, 12);
  event.target.value = raw.match(/.{1,4}/g)?.join('-') || '';
});
$('leaveRoomBtn').addEventListener('click', async () => {
  stopLocalShare(true);
  if (socket?.connected) await emitAck('room:leave').catch(() => {});
  leaveRoomLocal();
});
$('shareBtn').addEventListener('click', startSharing);
$('completeAudioBtn').addEventListener('click', finishSharing);
$('cancelPendingBtn').addEventListener('click', () => { discardPendingShare(); toast('Seleção cancelada.'); });
document.querySelectorAll('input[name="shareSurface"]').forEach((control) => control.addEventListener('change', updateAudioModeInfo));
$('shareSound').addEventListener('change', updateAudioModeInfo);
$('isolateAudio').addEventListener('change', updateAudioModeInfo);
$('fallbackTabBtn').addEventListener('click', () => chooseFallback('screen-tab'));
$('fallbackVirtualBtn').addEventListener('click', () => chooseFallback('virtual'));
$('continueSilentBtn').addEventListener('click', continueWithoutSound);
$('qualitySelect').addEventListener('change', updateQualityInfo);
$('copyDiagnosticBtn').addEventListener('click', async () => {
  // Sem credenciais, e-mail, código da sala, conteúdo da tela ou IP no relatório.
  const track = localStream?.getVideoTracks()[0] || pendingScreenStream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  const report = [
    'TelaViva 1.4 — diagnóstico local',
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
updateQualityInfo();
$('refreshAudioInputsBtn').addEventListener('click', () => listAudioInputs().catch((e) => toast(e.message, true)));
$('identifyAudioInputsBtn').addEventListener('click', unlockInputLabels);
$('enableAudioBtn').addEventListener('click', () => {
  stageVideo.muted = false;
  stageVideo.volume = 1;
  stageVideo.play().then(() => toast('Reprodução do áudio ativada.')).catch((e) => toast(`Clique no vídeo para ouvir: ${e.message}`, true));
});
updateAudioModeInfo();
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
    if (!document.fullscreenElement) await $('screenStage').requestFullscreen();
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
