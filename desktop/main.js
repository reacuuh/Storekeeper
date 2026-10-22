// Warehouse Manager for Windows: a window onto the live site, plus printing through the
// Windows printer driver, so the receipt printer works without swapping its driver.
// The screens all come from the website, so pushing to main updates this app too.
const { app, BrowserWindow, ipcMain, Menu, session, shell } = require('electron');
const path = require('node:path');
const { printRaw } = require('./rawprint');

// STOREKEEPER_URL points the app at a local copy for testing.
const SITE = new URL(process.env.STOREKEEPER_URL || 'https://ashipastorekeeper.netlify.app/');
const MAX_JOB_BYTES = 4 * 1024 * 1024; // a very long receipt is still under 1 MB

let win = null;

// Opening it again brings the open window forward instead of starting a second copy.
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Printing is only offered to the warehouse site itself, never to a page it links to.
function fromSite(e) {
  try { return new URL(e.senderFrame.url).origin === SITE.origin; } catch { return false; }
}

ipcMain.handle('printers', async e => {
  if (!fromSite(e)) throw new Error('not-allowed');
  return (await e.sender.getPrintersAsync()).map(p => ({ name: p.name }));
});

ipcMain.handle('print', async (e, name, bytes) => {
  if (!fromSite(e)) throw new Error('not-allowed');
  if (typeof name !== 'string' || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_JOB_BYTES) throw new Error('bad-job');
  // Only printers installed on this computer, so a page can't make Windows open anything else.
  if (!(await e.sender.getPrintersAsync()).some(p => p.name === name)) throw new Error('printer-missing');
  printRaw(name, bytes);
});

ipcMain.handle('retry', e => e.sender.loadURL(SITE.href));

function openOutside(url) {
  if (/^https?:/i.test(url)) shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    show: false,
    backgroundColor: '#f2f5f7',
    title: 'Warehouse Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => { win = null; });

  const wc = win.webContents;
  // Only the warehouse site opens inside the app. WhatsApp and other links open in the normal browser.
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => {
    if (new URL(url).origin === SITE.origin) return;
    e.preventDefault();
    openOutside(url);
  });
  // Normally the website's service worker covers being offline. This page is for the very
  // first start, before anything has been saved. -3 is a navigation that was cancelled, not a failure.
  wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'));
  });
  win.loadURL(SITE.href);
}

app.whenReady().then(() => {
  if (!firstCopy) return;
  Menu.setApplicationMenu(null);
  // The site needs no camera, location, notifications or other permissions.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => done(false));
  createWindow();
});

app.on('window-all-closed', () => app.quit());
