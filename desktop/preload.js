// Everything the website can ask the Windows app to do. app.js checks for window.desktop.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  printers: () => ipcRenderer.invoke('printers'),
  print: (name, bytes) => ipcRenderer.invoke('print', name, bytes),
  retry: () => ipcRenderer.invoke('retry'),
});
