// Redpencil Phone — desktop app (Mac & Windows). Wraps the same app the phones use.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, protocol, net, session, shell, systemPreferences, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, 'www');
let win = null, tray = null, quitting = false, ringing = false;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showWin());

function showWin() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
}
function send(ev, data) { if (win && !win.isDestroyed()) win.webContents.send('rp-event', ev, data); }

function createWindow() {
  win = new BrowserWindow({
    width: 460, height: 860, minWidth: 380, minHeight: 600,
    title: 'Redpencil Phone', backgroundColor: '#FBF7F4',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  win.setMenuBarVisibility(false);
  win.loadURL('app://redpencil/index.html');
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS('#bgCard{display:none!important}'));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('focus', () => { send('appState', { state: 'foreground' }); win.flashFrame(false); });
  win.on('blur', () => send('appState', { state: 'background' }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Redpencil Phone — online');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Redpencil Phone', click: showWin },
    { type: 'separator' },
    { label: 'Start when computer starts', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (it) => app.setLoginItemSettings({ openAtLogin: it.checked, openAsHidden: true }) },
    { type: 'separator' },
    { label: 'Quit (stop receiving calls)', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWin);
}

// ---- bridge used by the app (same functions as the Android app) ----
ipcMain.handle('rp', async (_e, method, a) => {
  a = a || {};
  switch (method) {
    case 'start': case 'status':
      return { notifications: Notification.isSupported(), fullScreen: true, battery: true, native: true, desktop: true };
    case 'showIncoming': {
      ringing = true;
      const visible = win && win.isVisible() && win.isFocused();
      showWin();
      if (win) { win.setAlwaysOnTop(true, 'screen-saver'); win.flashFrame(true); }
      if (!visible && Notification.isSupported()) {
        const n = new Notification({ title: 'Incoming call — ' + (a.name || 'Colleague'), body: a.sub || 'Redpencil Phone', silent: true, urgency: 'critical' });
        n.on('click', showWin); n.show();
      }
      return { native: false }; // the app keeps playing its own ringtone
    }
    case 'cancelIncoming': case 'callActive':
      if (method === 'cancelIncoming' || !a.on) { ringing = false; if (win) { win.setAlwaysOnTop(false); win.flashFrame(false); } }
      return null;
    case 'notifyMessage': {
      if (win && win.isVisible() && win.isFocused()) return null;
      if (Notification.isSupported()) {
        const n = new Notification({ title: a.title || 'New message', body: a.body || '' });
        n.on('click', () => { showWin(); send('callAction', { action: 'chat:' + (a.tag || '') }); });
        n.show();
      }
      if (win) win.flashFrame(true);
      return null;
    }
    case 'openSetting': return null;
    case 'fileChunk': {
      const tmp = path.join(os.tmpdir(), 'rpdl_' + String(a.id || 'x').replace(/[^A-Za-z0-9_-]/g, ''));
      const buf = Buffer.from(a.data || '', 'base64');
      if (a.first) fs.writeFileSync(tmp, buf); else fs.appendFileSync(tmp, buf);
      return null;
    }
    case 'fileFinish': {
      const tmp = path.join(os.tmpdir(), 'rpdl_' + String(a.id || 'x').replace(/[^A-Za-z0-9_-]/g, ''));
      const dir = path.join(app.getPath('downloads'), 'Redpencil');
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(a.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
      const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
      let dst = path.join(dir, safe), k = 1;
      while (fs.existsSync(dst)) dst = path.join(dir, base + ' (' + (k++) + ')' + ext);
      fs.copyFileSync(tmp, dst); try { fs.unlinkSync(tmp); } catch (e) {}
      return { uri: dst, where: 'Downloads/Redpencil' };
    }
    case 'openFile': {
      const err = await shell.openPath(a.uri || '');
      if (err) shell.showItemInFolder(a.uri || '');
      return null;
    }
  }
  return null;
});

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(WWW, p));
    if (!file.startsWith(WWW)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'notifications'].includes(perm));
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); await systemPreferences.askForMediaAccess('camera'); } catch (e) {}
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.redpencil.phone');
  if (!app.getLoginItemSettings().openAtLogin && !fs.existsSync(path.join(app.getPath('userData'), '.loginset'))) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    try { fs.writeFileSync(path.join(app.getPath('userData'), '.loginset'), '1'); } catch (e) {}
  }
  createWindow();
  createTray();
});
app.on('activate', showWin);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in the tray so calls can ring */ });
