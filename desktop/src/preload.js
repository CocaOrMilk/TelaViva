'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');
// API mínima exposta ao site TelaViva quando ele roda dentro do app desktop.
contextBridge.exposeInMainWorld('telavivaDesktop', {
  isDesktop: true,
  platform: process.platform,
  audio: {
    status: () => ipcRenderer.invoke('audio:status'),
    start: (opts) => ipcRenderer.invoke('audio:start', { includeDiscord: !!(opts && opts.includeDiscord) }),
    stop: () => ipcRenderer.invoke('audio:stop'),
    // Windows: o áudio mixado chega em blocos PCM float32 estéreo 48 kHz (ver src/win-audio.js)
    setPcmHandler: (callback) => {
      ipcRenderer.removeAllListeners('winaudio:pcm');
      if (typeof callback === 'function') {
        ipcRenderer.on('winaudio:pcm', (_e, data) => {
          const copy = new Uint8Array(data.byteLength); copy.set(data);
          callback(copy.buffer);
        });
      }
    }
  },
  report: {
    isAuto: () => ipcRenderer.invoke('report:auto'),
    mainEvents: () => ipcRenderer.invoke('report:main-events')
  },
  info: () => ipcRenderer.invoke('app:info'),
  mixer: {
    apps: () => ipcRenderer.invoke('mixer:apps'),
    // which: 'local' (o que você ouve) | 'tx' (o que vai para a transmissão)
    setVolume: (key, which, percent) => ipcRenderer.invoke('mixer:volume', String(key), String(which), Number(percent)),
    setMute: (key, which, muted) => ipcRenderer.invoke('mixer:mute', String(key), String(which), !!muted),
    setMaster: (percent) => ipcRenderer.invoke('mixer:master', Number(percent))
  },
  capture: { setSurface: (surface) => ipcRenderer.send('capture:surface', typeof surface === 'string' ? surface : null) }
});

// O getDisplayMedia do Electron não informa corretamente o tipo da fonte
// (displaySurface), e o site rejeita a captura por causa disso. Aqui o app
// avisa o seletor nativo do que o site pediu (tela/janela) e devolve ao site o
// tipo pedido, já que quem escolheu foi o próprio usuário no seletor do app.
webFrame.executeJavaScript(`(() => {
  const md = navigator.mediaDevices;
  if (!md || !md.getDisplayMedia || md.__tvPatched) return;
  const orig = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async function (opts) {
    const w = opts && opts.video && opts.video.displaySurface;
    const surface = typeof w === 'string' ? w : (w && (w.exact || w.ideal)) || null;
    try { window.telavivaDesktop.capture.setSurface(surface); } catch (e) {}
    const stream = await orig(opts);
    if (surface) for (const t of stream.getVideoTracks()) {
      const g = t.getSettings.bind(t);
      t.getSettings = () => Object.assign({}, g(), { displaySurface: surface });
    }
    return stream;
  };
  md.__tvPatched = true;
})();`);
