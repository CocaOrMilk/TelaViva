'use strict';
const { app, BrowserWindow, Menu, session, desktopCapturer, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReporter } = require('./reporter');

// Endereço do servidor TelaViva. Troque em TelaViva → "Alterar endereço do servidor…" ou com TELAVIVA_URL.
const DEFAULT_URL = 'http://localhost:3000/';
const isLinux = process.platform === 'linux';
const isWin = process.platform === 'win32';

app.setName('TelaViva');
if (isLinux) {
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // Sem SUID/userns (AppImage, tar.gz, Ubuntu 24+) o sandbox do Chromium não inicia; o app só carrega o seu próprio servidor.
  if (app.isPackaged) app.commandLine.appendSwitch('no-sandbox');
}

// ---- configuração (endereço do servidor) --------------------------------
const configFile = () => path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
function serverUrl() {
  const cfg = loadConfig();
  const raw = process.env.TELAVIVA_URL || cfg.url || DEFAULT_URL;
  try { const u = new URL(raw); return /^https?:$/.test(u.protocol) ? u.href : DEFAULT_URL; } catch { return DEFAULT_URL; }
}

// ---- relatórios de erro automáticos --------------------------------------
const autoReportEnabled = () => loadConfig().autoReport !== false; // ligado por padrão (dá para desligar no menu)
const reporter = createReporter({
  getBaseUrl: () => serverUrl(),
  isEnabled: autoReportEnabled,
  getExtraContext: () => ({ audio: router ? router.status() : null })
});
process.on('uncaughtException', (err) => { console.error(err); reporter.report('erro não tratado no app', err?.stack || err); });
process.on('unhandledRejection', (reason) => { console.error(reason); reporter.report('promessa rejeitada no app', reason?.stack || reason); });
app.on('render-process-gone', (_e, _wc, details) => reporter.report('janela encerrou', `${details.reason} (${details.exitCode})`));
app.on('child-process-gone', (_e, details) => { if (details.reason !== 'clean-exit') reporter.report('processo interno encerrou', `${details.type}: ${details.reason}`); });
ipcMain.handle('report:auto', () => autoReportEnabled());
ipcMain.handle('report:main-events', () => reporter.mainEvents());
ipcMain.handle('app:info', () => ({
  version: app.getVersion(), platform: process.platform, os: `${os.type()} ${os.release()}`, arch: process.arch,
  electron: process.versions.electron, packaged: app.isPackaged
}));

// ---- áudio sem Discord --------------------------------------------------
let router = null;
function getRouter() {
  if (router) return router;
  if (isLinux && !process.env.TV_FORCE_WIN_AUDIO) router = require('./linux-audio').createRouter({ log: (m) => { console.log('[audio]', m); reporter.log('audio', m); } });
  else if (isWin || process.env.TV_FORCE_WIN_AUDIO) {
    router = require('./win-audio').createRouter({
      log: (m) => { console.log('[audio]', m); reporter.log('audio', m); },
      onProblem: (what, detail) => reporter.report(what, detail),
      onPcm: (chunk) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('winaudio:pcm', chunk); }
    });
  } else router = {
    async start() { throw new Error('O áudio sem Discord só existe para Linux e Windows.'); },
    async stop() { return { running: false }; },
    status() { return { running: false, platform: process.platform, unsupported: true }; }
  };
  return router;
}
async function audioCall(fn, opts) {
  try { return { ok: true, ...(await getRouter()[fn](opts)) }; }
  catch (e) { reporter.report(`áudio: ${fn} falhou`, e.message); return { ok: false, error: e.message, running: getRouter().status().running }; }
}
ipcMain.handle('audio:status', () => ({ ok: true, ...getRouter().status() }));
ipcMain.handle('audio:start', async (_e, opts) => { const r = await audioCall('start', { includeDiscord: !!opts?.includeDiscord }); rebuildMenu(); return r; });
const mixerCall = async (fn, ...args) => {
  try { const r = getRouter(); return { ok: true, ...(r[fn] ? await r[fn](...args) : {}) }; }
  catch (e) { return { ok: false, error: e.message }; }
};
ipcMain.handle('mixer:apps', async () => {
  const r = getRouter();
  if (!r.listApps) return { ok: true, apps: [], master: 100 };
  try { return { ok: true, apps: await r.listApps(), master: await r.getMaster() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('mixer:volume', (_e, key, which, percent) => mixerCall('setAppVolume', String(key), String(which), percent));
ipcMain.handle('mixer:mute', (_e, key, which, muted) => mixerCall('setAppMute', String(key), String(which), !!muted));
ipcMain.handle('mixer:master', (_e, percent) => mixerCall('setMaster', percent));
ipcMain.handle('audio:stop', async () => { const r = await audioCall('stop'); rebuildMenu(); return r; });

// ---- seletor de tela/janela ---------------------------------------------
function pickSource(parent, sources) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent, modal: true, width: 760, height: 560, title: 'Escolha o que compartilhar',
      autoHideMenuBar: true, minimizable: false, maximizable: false,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true }
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('picker:choose', onChoose);
      resolve(sources.find((s) => s.id === id) || null);
      if (!win.isDestroyed()) win.destroy();
    };
    const onChoose = (event, id) => { if (event.sender === win.webContents) finish(id); };
    ipcMain.on('picker:choose', onChoose);
    win.on('closed', () => finish(null));
    win.loadFile(path.join(__dirname, 'picker.html'));
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('picker:sources', sources.map((s) => ({
        id: s.id, name: s.name, isScreen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL()
      })));
    });
  });
}

let mainWindow = null;
let requestedSurface = null; // 'monitor' | 'window' | 'browser' | null, informado pelo site
ipcMain.on('capture:surface', (event, surface) => {
  if (mainWindow && event.sender === mainWindow.webContents) requestedSurface = ['monitor', 'window', 'browser'].includes(surface) ? surface : null;
});
function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const types = requestedSurface === 'monitor' ? ['screen'] : requestedSurface === 'window' ? ['window'] : ['screen', 'window'];
      requestedSurface = null;
      let sources = await desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 } });
      if (!sources.length) sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      // No Wayland o portal do sistema já fez a escolha e devolve uma única fonte.
      const chosen = sources.length === 1 ? sources[0] : await pickSource(mainWindow, sources);
      if (!chosen) return callback({});
      callback(process.platform === 'win32' && request.audioRequested ? { video: chosen, audio: 'loopback' } : { video: chosen });
    } catch (e) {
      console.error('captura de tela falhou:', e);
      callback({});
    }
  });
}

// ---- janela principal ---------------------------------------------------
function createWindow() {
  const url = serverUrl();
  const origin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, title: 'TelaViva', backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  const allowed = (wc) => { try { return new URL(wc.getURL()).origin === origin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(allowed(wc) && ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    (wc ? allowed(wc) : false) && ['media', 'display-capture', 'fullscreen'].includes(permission));
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) { event.preventDefault(); if (/^https:\/\//.test(target)) shell.openExternal(target); }
  });
  mainWindow.webContents.on('did-finish-load', () => reporter.flush());
  mainWindow.webContents.on('unresponsive', () => reporter.report('janela não responde', ''));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (isMain && code !== -3) {
      reporter.report('falha ao abrir o servidor', `${desc} (${code}) ${failedUrl}`);
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
        `<body style="font:16px sans-serif;background:#0f1115;color:#eee;padding:3rem"><h2>Não foi possível abrir o TelaViva</h2><p>${desc}</p><p>Endereço: ${failedUrl}</p><p>Use o menu TelaViva → Alterar endereço do servidor, ou Recarregar (Ctrl+R).</p></body>`));
    }
  });
  mainWindow.loadURL(url);
}

function rebuildMenu() {
  const audio = getRouter().status();
  const template = [
    { label: 'TelaViva', submenu: [
      {
        label: (isLinux || isWin) ? 'Áudio sem Discord (programas separados)' : 'Áudio sem Discord (indisponível neste sistema)',
        type: 'checkbox', checked: !!audio.running, enabled: isLinux || isWin,
        click: async (item) => { const r = await audioCall(item.checked ? 'start' : 'stop'); if (!r.ok) dialog.showErrorBox('Áudio sem Discord', r.error); rebuildMenu(); }
      },
      {
        label: 'Enviar relatórios de erro automaticamente', type: 'checkbox', checked: autoReportEnabled(),
        click: (item) => { saveConfig({ ...loadConfig(), autoReport: item.checked }); rebuildMenu(); }
      },
      { type: 'separator' },
      { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
      { label: 'Alterar endereço do servidor…', click: askServerUrl },
      { label: 'Ferramentas de desenvolvedor', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      { type: 'separator' },
      { role: 'quit', label: 'Sair' }
    ] },
    { label: 'Exibir', submenu: [{ role: 'togglefullscreen', label: 'Tela cheia' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function askServerUrl() {
  const win = new BrowserWindow({ parent: mainWindow, modal: true, width: 520, height: 200, autoHideMenuBar: true, title: 'Endereço do servidor',
    webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true } });
  const onSave = (event, value) => {
    if (event.sender !== win.webContents) return;
    try {
      const u = new URL(value);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      saveConfig({ ...loadConfig(), url: u.href });
      app.relaunch(); app.exit(0);
    } catch { dialog.showErrorBox('Endereço inválido', 'Use um endereço http(s) completo.'); }
  };
  ipcMain.on('url:save', onSave);
  win.on('closed', () => ipcMain.removeListener('url:save', onSave));
  win.loadFile(path.join(__dirname, 'url.html'), { query: { current: serverUrl() } });
}

// ---- ciclo de vida ------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.whenReady().then(() => { setupDisplayMedia(); rebuildMenu(); createWindow(); setInterval(() => reporter.flush(), 60000);
  // Quando o login termina (cookie de sessão criado), reenvia os relatórios que ficaram na fila.
  session.defaultSession.cookies.on('changed', (_e, cookie, _cause, removed) => { if (!removed && /sid/i.test(cookie.name)) setTimeout(() => reporter.flush(), 1500); });
});
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !router || !router.status().running) return;
  event.preventDefault(); quitting = true;
  router.stop().finally(() => app.exit(0));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.quit());
