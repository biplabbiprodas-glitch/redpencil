// Gives the app the same "native" functions it uses on Android (ringing, notifications, saving files).
const { contextBridge, ipcRenderer } = require('electron');
const listeners = {};
ipcRenderer.on('rp-event', (_e, ev, data) => { (listeners[ev] || []).forEach((cb) => { try { cb(data); } catch (e) {} }); });
const call = (m) => (a) => ipcRenderer.invoke('rp', m, a);
const plugin = {
  start: call('start'), status: call('status'), showIncoming: call('showIncoming'), cancelIncoming: call('cancelIncoming'),
  callActive: call('callActive'), notifyMessage: call('notifyMessage'), openSetting: call('openSetting'),
  fileChunk: call('fileChunk'), fileFinish: call('fileFinish'), openFile: call('openFile'),
  addListener: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); return Promise.resolve({ remove: () => {} }); }
};
contextBridge.exposeInMainWorld('Capacitor', {
  isNativePlatform: () => true,
  getPlatform: () => 'desktop',
  registerPlugin: () => plugin
});
