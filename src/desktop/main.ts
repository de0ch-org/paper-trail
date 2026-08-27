// Electron desktop shell for Paper Trail.
//
// The built web app (dist-web) is served over a custom `paper-trail://` protocol
// straight from disk. Native application menus send actions over IPC; the
// web app maps them onto its existing functions when it detects the shell
// (window.ptDesktop), and keeps working as a plain web app in any browser
// otherwise.
//
// Desktop niceties: multiple windows (Cmd/Ctrl+N), Open… in a new window,
// OS-level file opens (Open With…, dragging a PDF onto the Dock icon,
// double-clicking a .ptl session), recent documents, remembered window
// bounds, and inset traffic lights on macOS.
//
// Run:   npm run desktop
// Smoke: npx electron build-node/desktop/main.js --smoke   (hidden window)

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, shell } from 'electron';
import contextMenu from 'electron-context-menu';
import { autoUpdater } from 'electron-updater';
import { MIME } from '../node/server';
import { popupWin32, type WinMenuItem } from './winMenu';
import { blockShutdown, unblockShutdown } from './winShutdown';
import { placeWindow } from './windowPlacement';
import { resolveFileArgs } from './openArgs';

// Apps launched by Finder/LaunchServices can get stdio pipes whose
// other end is already closed; a console write (electron-updater logs
// during its startup check) then raises EPIPE, which Electron's default
// handler turns into a crash dialog. Logging must never crash the app.
process.stdout.on('error', () => { /* swallow EPIPE */ });
process.stderr.on('error', () => { /* swallow EPIPE */ });

const SMOKE = process.argv.includes('--smoke');

// build-node/desktop -> project root
const WEB_ROOT = path.resolve(__dirname, '..', '..', 'dist-web');
const SCHEME = 'paper-trail';
const isMac = process.platform === 'darwin';
const dbg = (...a: unknown[]): void => {
  if (process.env.PT_DEBUG) console.log('[pt]', ...a);
};

app.setName('Paper Trail');
// Windows attaches Jump Lists (and groups taskbar buttons) by
// AppUserModelID; it must be the appId the installer stamps on the
// shortcuts, or the Jump List's New Window task never shows.
if (process.platform === 'win32') app.setAppUserModelId('local.paper-trail');

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
  },
}]);

// Dev affordance: run side-by-side with an installed copy (separate
// profile => separate single-instance lock).
if (process.env.PT_USERDATA) {
  app.setPath('userData', process.env.PT_USERDATA);
}
// Smoke tests must not fight the user's running copy over the profile
// directory or the single-instance lock.
if (SMOKE) {
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pt-smoke-')));
} else if (!app.requestSingleInstanceLock()) {
  // OS file opens on Windows arrive as a second process; forward
  // them to the running instance (see 'second-instance').
  app.quit();
}

// ---- remembered window bounds ----

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadBounds(): { width: number; height: number; x?: number; y?: number } {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as {
      width: number; height: number; x?: number; y?: number;
    };
    // The remembered position is only trusted while it still lands on a
    // connected display: after a monitor unplug, verbatim x/y would
    // restore the window fully off-screen. The size survives either way.
    if (s.width > 300 && s.height > 200) {
      return placeWindow(s, screen.getAllDisplays().map((d) => d.workArea));
    }
  } catch { /* first launch */ }
  return { width: 1440, height: 940 };
}

function saveBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()));
  } catch { /* not fatal */ }
}

// ---- windows ----

function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function send(action: string): void {
  const win = focusedWindow();
  if (win && !win.isDestroyed()) win.webContents.send('pt-menu', action);
}

function createWindow({ showWhenLoaded = false } = {}): BrowserWindow {
  const bounds = loadBounds();
  // Additional windows cascade instead of stacking exactly.
  const offset = BrowserWindow.getAllWindows().length * 26;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x !== undefined ? bounds.x + offset : undefined,
    y: bounds.y !== undefined ? bounds.y + offset : undefined,
    show: !SMOKE && !process.env.PT_SHOT && !showWhenLoaded,
    backgroundColor: '#2b2d31',
    // The window chrome integrates with the app's own toolbar row on
    // both platforms. macOS: the traffic lights are at an OS-fixed
    // position (measured: centers 18.75px below the window top), and the
    // 38px toolbar in globals.css centers on them. Windows: the native
    // min/max/close buttons overlay the same 38px row.
    ...(isMac ? {
      titleBarStyle: 'hiddenInset' as const,
    } : {
      titleBarStyle: 'hidden' as const,
      // 48px total follows Fluent's guidance for title bars with
      // interactive content (what Outlook/Teams/Edge use); the bare 32px
      // caption is cramped for a toolbar. The overlay is one pixel short
      // of that so the toolbar's bottom border shows through underneath
      // the window buttons instead of stopping where they start; the
      // renderer sizes the toolbar from the titlebar-area-* CSS env vars
      // plus that pixel, so the two always agree.
      titleBarOverlay: {
        color: '#1e1f22',
        symbolColor: '#9a9aa2',
        height: 47,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // External links (arXiv, DOI, ...) go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Windows has no menu bar, so New Window is handled here.
  if (!isMac) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.control && !input.shift
        && input.key.toLowerCase() === 'n') {
        createWindow();
      }
    });
  }

  // beforeunload now CANCELS a dirty close, and the renderer drives an ASYNC
  // save-then-close (Controller.closeAndSave) while the window is held open \u2014
  // showing its OWN native dialog via pt-confirm-close-save only if the save
  // can't happen silently. So we must NOT pop a dialog here: a no-op honors the
  // cancel (keeps the window open) so the renderer can take over. (Electron's
  // default with no listener does the same; this is explicit about why.)
  win.webContents.on('will-prevent-unload', () => { /* renderer handles it */ });

  // Native right-click menus for text fields and selections. On mac
  // they come from electron-context-menu (spell-check suggestions, Look
  // Up, the full edit menu with proper disabled states \u2014 all native
  // there); on Windows Electron's menus are Chromium-drawn, so the same
  // items are shown through a REAL Win32 menu instead. App-specific
  // targets (links, trail/history rows, the viewer) preventDefault() in
  // the renderer and go through the pt-context-menu IPC.
  if (process.platform === 'win32') {
    win.webContents.on('context-menu', (_event, params) => {
      const wc = win.webContents;
      const selection = params.selectionText.trim();
      const items: WinMenuItem[] = [];
      const acts = new Map<string, () => void>();
      const add = (id: string, label: string, enabled: boolean, act: () => void) => {
        items.push({ id, label, enabled });
        acts.set(id, act);
      };
      for (const [i, s] of params.dictionarySuggestions.entries()) {
        add(`sugg-${i}`, s, true, () => wc.replaceMisspelling(s));
      }
      if (params.misspelledWord) {
        add('learn', 'Add to Dictionary', true,
          () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord));
        items.push({ type: 'separator' });
      }
      if (selection && !params.isEditable) {
        add('search', `Search Document for \u201c${selection.slice(0, 24)}\u201d`, true,
          () => wc.send('pt-menu', 'search-selection', selection));
        items.push({ type: 'separator' });
      }
      if (params.isEditable) {
        add('cut', 'Cut', params.editFlags.canCut, () => wc.cut());
        add('copy', 'Copy', params.editFlags.canCopy, () => wc.copy());
        add('paste', 'Paste', params.editFlags.canPaste, () => wc.paste());
        items.push({ type: 'separator' });
        add('select-all', 'Select All', params.editFlags.canSelectAll, () => wc.selectAll());
      } else if (selection) {
        add('copy', 'Copy', params.editFlags.canCopy, () => wc.copy());
      }
      if (!items.length) return;
      const choice = popupWin32(win, items);
      if (choice) acts.get(choice)?.();
    });
  } else {
    contextMenu({
      window: win,
      showSearchWithGoogle: false,
      showSaveImageAs: false,
      showCopyImage: false,
      showSelectAll: true,
      showLookUpSelection: true,
      showLearnSpelling: true,
      showInspectElement: false,
      prepend: (_defaults, params) => (
        params.selectionText.trim() && !params.isEditable
          ? [{
            label: `Search Document for \u201c${params.selectionText.trim().slice(0, 24)}\u201d`,
            click: () => win.webContents.send('pt-menu', 'search-selection', params.selectionText.trim()),
          }]
          : []
      ),
    });
  }

  // Screenshot tooling: show the window WITHOUT activating it (no focus
  // steal, may stay buried); it is then captured by window id.
  if (process.env.PT_SHOT) win.showInactive();

  // A window created to receive a document stays hidden until that
  // document is showing (the title leaves the bare app name): no flash
  // of an empty window. The timer is the safety net — a window must
  // never stay invisible because a file failed to load.
  if (showWhenLoaded && !SMOKE && !process.env.PT_SHOT) {
    const reveal = () => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    };
    // Only explicitly-set titles count: during navigation Electron also
    // reports titles DERIVED from the URL (explicitSet false), which
    // arrive before the document and would reveal an empty window.
    win.webContents.on('page-title-updated', (_event, title, explicitSet) => {
      if (explicitSet && title !== 'Paper Trail') reveal();
    });
    // Patient enough that a slow cold start (pdf.js on a weak machine)
    // does not fall through to an empty reveal. Opt-out lets the
    // session-reveal test isolate the title-driven reveal, so a slow CI
    // runner's timer can't fire first and hide the real behavior.
    if (!process.env.PT_NO_SAFETY_REVEAL) setTimeout(reveal, 4000);
  }

  // A dispatched file claims this window (see openPath); the claim
  // lifts once a document's title lands, or with the window itself.
  win.webContents.on('page-title-updated', (_event, title, explicitSet) => {
    if (explicitSet && title !== 'Paper Trail') claimed.delete(win.id);
  });
  win.on('closed', () => { claimed.delete(win.id); });

  win.on('close', () => saveBounds(win));

  // Bookkeeping keyed on this window must not outlive it. In particular a
  // dirty window closed via Don't Save (or save-then-close — the close beats
  // the renderer's edited=false notification) would stay in editedWindows
  // forever, making every later quit run the close-all cycle even with
  // nothing unsaved.
  const winId = win.id;
  const wcId = win.webContents.id;
  win.once('closed', () => {
    editedWindows.delete(winId);
    closeFlowBusy.delete(winId);
    keptOpenResolvers.delete(winId);
    readyWindows.delete(wcId);
    queuedFiles.delete(wcId);
  });

  // Windows OS shutdown/logout: the vetoable query-session-end. A window with
  // an unsaved session returns FALSE to WM_QUERYENDSESSION (preventDefault),
  // withholding the shutdown; the reason string was already registered via
  // blockShutdown() when the session went dirty. A clean window allows it —
  // any one dirty window's veto is enough to hold the whole shutdown.
  if (!isMac) {
    win.on('query-session-end', (event) => {
      if (!editedWindows.has(win.id)) return;
      event.preventDefault();
      void promptSaveAfterShutdownVeto();
    });
  }

  void win.loadURL(`${SCHEME}://app/index.html`);
  return win;
}

// ---- opening OS files ----

const pendingPaths: string[] = [];
const readyWindows = new Set<number>();  // renderer listener registered
/** A file to deliver: a path on disk, or bytes handed over from a renderer. */
type QueuedFile = string | { name: string; data: ArrayBuffer };
const queuedFiles = new Map<number, QueuedFile[]>();

// Deliveries in flight per window (by kind), until the document's title
// lands. A dispatched file claims its window IMMEDIATELY: routing by
// title alone let two quick opens hit the same still-empty window, and
// the renderer's racing opens silently lost one of them. A pending .ptl
// still accepts one PDF (and vice versa) — the seamless session+PDF
// pair, either order.
type ClaimKind = 'pdf' | 'ptl';
const claimed = new Map<number, Set<ClaimKind>>();

function claimWindow(win: BrowserWindow, kind: ClaimKind): void {
  const kinds = claimed.get(win.id) ?? new Set<ClaimKind>();
  kinds.add(kind);
  claimed.set(win.id, kinds);
}

function sendFileTo(win: BrowserWindow, item: QueuedFile): void {
  dbg('sendFileTo', typeof item === 'string' ? item : item.name,
    'ready:', readyWindows.has(win.webContents.id));
  if (!readyWindows.has(win.webContents.id)) {
    const q = queuedFiles.get(win.webContents.id) ?? [];
    q.push(item);
    queuedFiles.set(win.webContents.id, q);
    return;
  }
  if (typeof item !== 'string') {
    win.webContents.send('pt-open-file', item);
    return;
  }
  const filePath = item;
  const name = path.basename(filePath);
  fs.promises.readFile(filePath).then((buf) => {
    if (win.isDestroyed()) return;
    dbg('ipc pt-open-file ->', win.webContents.id, name, buf.byteLength);
    win.webContents.send('pt-open-file', {
      name,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      // The real on-disk path: an OS-opened .ptl binds to it so the
      // session auto-saves back silently (there is no
      // FileSystemFileHandle for a file the shell handed us).
      path: filePath,
    });
    // macOS: title-bar proxy for the real file behind this window.
    if (isMac && /\.pdf$/i.test(filePath)) win.setRepresentedFilename(filePath);
  }).catch((e) => {
    console.warn('could not read', filePath, e);
  });
}

/**
 * Open an OS-provided file (Open With…, Dock drops, Open dialog). A
 * window that already shows a document never gets a second one: the
 * file goes into the invoking/focused window only while it is still
 * empty (its title is the bare app name), and into a new window
 * otherwise. At launch the file goes into the first window (`target`).
 */
function openPath(filePath: string, target?: BrowserWindow): BrowserWindow | null {
  if (!app.isReady()) {
    pendingPaths.push(filePath);
    return null;
  }
  const kind: ClaimKind = /\.ptl$/i.test(filePath) ? 'ptl' : 'pdf';
  // Empty AND not already spoken for by a same-kind file in flight.
  const canTake = (w: BrowserWindow | null): w is BrowserWindow => {
    if (!w || w.isDestroyed() || claimed.get(w.id)?.has(kind)) return false;
    const t = w.getTitle();
    return w.webContents.isLoading() || t === 'Paper Trail' || t === '';
  };
  let win = target && !target.isDestroyed() && !claimed.get(target.id)?.has(kind)
    ? target : null;
  // ANY empty window takes the file — focused first, but an idle empty
  // window elsewhere beats spawning an offset new one.
  if (!win) {
    const focused = focusedWindow();
    if (canTake(focused)) win = focused;
    else win = BrowserWindow.getAllWindows().find(canTake) ?? null;
  }
  // A brand-new window stays hidden until the document is showing: no
  // flash of an empty window on OS opens.
  win ??= createWindow({ showWhenLoaded: true });
  claimWindow(win, kind);
  sendFileTo(win, filePath);
  return win;
}

// macOS: Open With…, drag onto the Dock icon, recent documents.
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPath(filePath);
});

// Windows: the file path arrives in a second process's argv, together
// with THAT process's working directory — relative CLI paths must
// resolve against it, not our own cwd (resolveFileArgs). The taskbar
// Jump List's "New Window" task arrives the same way, as a second
// process launched with --new-window.
app.on('second-instance', (_event, argv, workingDirectory) => {
  const files = resolveFileArgs(argv, workingDirectory);
  if (files.length) {
    const targets = new Set<BrowserWindow>();
    for (const f of files) {
      const win = openPath(f);
      if (win) targets.add(win);
    }
    // Bring the receiving window forward: an Explorer double-click while
    // the app is minimized or behind must not load the file invisibly.
    // A brand-new still-hidden window is left alone — it reveals itself
    // once its document is showing (no empty-window flash).
    for (const win of targets) {
      if (win.isDestroyed()) continue;
      if (win.isMinimized()) win.restore();
      else if (!win.isVisible()) continue;
      win.show();
      win.focus();
    }
  } else if (argv.includes('--new-window')) createWindow();
  else {
    const win = focusedWindow();
    if (win) { win.show(); win.focus(); }
  }
});

function openDialog(): void {
  // PDFs only: sessions load through the separate Load Session action.
  void dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'PDF document', extensions: ['pdf'] },
    ],
  }).then(({ canceled, filePaths }) => {
    if (canceled) return;
    filePaths.forEach((f) => openPath(f));
  });
}

/**
 * Menu items carry no user activation, so the renderer's file pickers
 * throw SecurityError there; session loading from the menu therefore
 * uses this main-process dialog and feeds the file into the invoking
 * window's normal (two-step) session flow.
 */
function loadSessionDialog(): void {
  const win = focusedWindow();
  void dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Reading session', extensions: ['ptl'] }],
  }).then(({ canceled, filePaths }) => {
    if (canceled || !filePaths[0]) return;
    openPath(filePaths[0], win ?? undefined);
  });
}

// ---- automatic updates (GitHub Releases feed) ----

/**
 * Downloads updates in the background and installs them on the next
 * quit — a fully silent path with no UI. Dev/test builds never update;
 * the update tests point the updater at a local feed with PT_UPDATE_URL
 * and observe it via PT_UPDATE_TEST.
 */
function setupAutoUpdates(): void {
  autoUpdater.autoDownload = true;
  if (process.env.PT_UPDATE_URL) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env.PT_UPDATE_URL });
  } else if (SMOKE || !app.isPackaged) {
    return;
  }
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    if (process.env.PT_UPDATE_TEST === 'download') {
      console.log(`PT_UPDATE_DOWNLOADED ${info.version}`);
      app.exit(0);
    } else if (process.env.PT_UPDATE_TEST === 'install') {
      autoUpdater.quitAndInstall(true, false);
    }
  });
  autoUpdater.on('error', (e) => {
    if (/cancell?ed/i.test(String(e))) { dbg('download cancelled'); return; }
    dbg('auto-update error', e);
    if (process.env.PT_UPDATE_TEST) {
      console.error('PT_UPDATE_ERROR', String(e));
      app.exit(1);
    }
  });
  const check = () => {
    autoUpdater.checkForUpdates().catch((e) => dbg('update check failed', e));
  };
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}

// Windows whose reading session has unsaved changes (mirrored from the
// renderer via pt-document-edited). Drives the unsaved-first close order and
// tells the OS-shutdown guards whether anything is at risk.
const editedWindows = new Set<number>();

// Close-flow dialogs and writes in flight, per window id (the confirm
// prompt, the save-as picker, a session write). While one is up the user is
// deciding — promptCloseAllWindows' wedge timer must not count that time.
const closeFlowBusy = new Set<number>();
async function busyWhile<T>(win: BrowserWindow | null, work: () => Promise<T>): Promise<T> {
  const id = win && !win.isDestroyed() ? win.id : null;
  if (id != null) closeFlowBusy.add(id);
  try {
    return await work();
  } finally {
    if (id != null) closeFlowBusy.delete(id);
  }
}

// A renderer whose close flow decided to KEEP its window open (Cancel at the
// prompt, a canceled picker, a failed save) reports it here, so a pending
// close-all stops waiting for that window at once instead of timing out.
const keptOpenResolvers = new Map<number, () => void>();
ipcMain.on('pt-close-kept-open', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) keptOpenResolvers.get(win.id)?.();
});

/**
 * Close every document window one by one, unsaved sessions FIRST so each
 * one's save prompt (the renderer's normal close flow) is answered before any
 * clean window goes — without the ordering a Cancel could leave a half-closed
 * workspace. Returns true only if every window actually closed; false the
 * moment one stays open (the user chose Cancel, canceled the picker, or a
 * save failed), leaving the rest untouched. Shared by the OS-shutdown guards.
 *
 * Waiting is gated on the renderer's DECISION, not wall-clock: each window
 * either closes ('closed' → keep going) or its close flow reports that it
 * kept the window open (pt-close-kept-open → stop). The residual timer only
 * catches a wedged window, and it counts nothing while a close-flow dialog
 * or write is up (closeFlowBusy) — the user may sit in the save prompt or
 * the location picker for minutes without the quit being abandoned under
 * them. A renderer-side write with no shell dialog (a handle-bound save)
 * is invisible here, so the idle budget stays generous.
 */
async function promptCloseAllWindows(): Promise<boolean> {
  const all = [...BrowserWindow.getAllWindows()]
    .filter((w) => !w.isDestroyed());
  const ordered = [
    ...all.filter((w) => editedWindows.has(w.id)),
    ...all.filter((w) => !editedWindows.has(w.id)),
  ];
  for (const w of ordered) {
    if (w.isDestroyed()) continue;
    const wId = w.id;
    const closed = new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let idleLeft = 5000;
      const TICK = 250;
      const onClosed = () => settle(true);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        keptOpenResolvers.delete(wId);
        w.removeListener('closed', onClosed);
        resolve(ok);
      };
      w.once('closed', onClosed);
      keptOpenResolvers.set(wId, () => settle(false));
      const tick = () => {
        if (!closeFlowBusy.has(wId)) idleLeft -= TICK;
        if (idleLeft <= 0) { settle(false); return; }
        timer = setTimeout(tick, TICK);
      };
      timer = setTimeout(tick, TICK);
    });
    w.close();
    if (!(await closed)) return false;
  }
  return true;
}

// ---- OS shutdown / logout protection --------------------------------------
// A dirty reading session must survive an OS shutdown/logout, not just a
// window close (the renderer's async close-save can't finish inside a
// time-boxed shutdown). macOS routes shutdown/logout — and Cmd+Q — through
// before-quit, where preventDefault() returns NSTerminateCancel and cancels
// the whole action. Windows fires the vetoable query-session-end per window,
// where preventDefault() returns FALSE to WM_QUERYENDSESSION and withholds the
// shutdown while the OS shows the reason string registered via blockShutdown().
// Both then drive the SAME per-window save dialog as a normal close.

const SHUTDOWN_BLOCK_REASON = 'Paper Trail has an unsaved reading session.';

// Set while our own app.quit() below re-enters before-quit, so the second pass
// is allowed straight through.
let quitApproved = false;
// One query-session-end fires per window; the save flow must run only once.
let handlingShutdownVeto = false;

/**
 * Shutdown was vetoed (Windows). Bring the unsaved window(s) forward so the
 * save prompt is in view, then run the normal per-window close/save flow.
 * Windows that close release their block automatically; any left dirty keep
 * theirs, so a re-attempted shutdown is blocked again.
 */
async function promptSaveAfterShutdownVeto(): Promise<void> {
  if (handlingShutdownVeto) return;
  handlingShutdownVeto = true;
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (editedWindows.has(w.id) && !w.isDestroyed()) { w.show(); w.focus(); }
    }
    await promptCloseAllWindows();
  } finally {
    handlingShutdownVeto = false;
  }
}

// ---- menu ----

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } satisfies Electron.MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => void createWindow() },
        { type: 'separator' },
        // Opens in a new window (unless the current one is still empty).
        { label: 'Open\u2026', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { type: 'separator' },
        { label: 'Save Reading Session', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Load Reading Session\u2026', accelerator: 'CmdOrCtrl+Shift+O', click: () => loadSessionDialog() },
        { type: 'separator' },
        { label: 'Replace PDF (Keep History)\u2026', click: () => send('replace-pdf') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Custom undo/redo: undoes history changes (overwrites, forks,
        // closed stacks, renames); in text fields the web app falls back
        // to normal text-editing undo.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find\u2026', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => send('zoom-in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: () => send('fit') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => send('toggle-sidebar') },
        { label: 'Toggle Outline / Pages Panel', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('toggle-nav') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send('forward') },
        { type: 'separator' },
        { label: 'Previous Trail', accelerator: 'Alt+[', click: () => send('trail-prev') },
        { label: 'Next Trail', accelerator: 'Alt+]', click: () => send('trail-next') },
        { label: 'Duplicate Trail', accelerator: 'Alt+Shift+D', click: () => send('trail-duplicate') },
        { type: 'separator' },
        { label: 'Mark This Spot', accelerator: 'CmdOrCtrl+D', click: () => send('mark') },
        { label: 'Mark in a New Trail', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('mark-branch') },
        { label: 'Set Current Entry to This Position', accelerator: 'CmdOrCtrl+G', click: () => send('reanchor') },
        { type: 'separator' },
        { label: 'Clear History', click: () => send('clear-history') },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Shift+/', click: () => send('help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- app protocol ----

function registerAppProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    // Dev/test builds also serve /sample/* from the project root, like
    // the node server does, so the desktop e2e suite can load its
    // fixtures over the app protocol. Packaged apps have no sample dir.
    const root = (!app.isPackaged && pathname.startsWith('/sample/'))
      ? path.resolve(WEB_ROOT, '..')
      : WEB_ROOT;
    const filePath = path.normalize(path.join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return new Response('bad path', { status: 400 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// ---- lifecycle ----

// App-specific right-click menus (links, trail/history rows, the viewer):
// the renderer says what was clicked; the chosen action id goes back.
ipcMain.handle('pt-context-menu', async (event, ctx: {
  type: string; text?: string; current?: boolean; active?: boolean;
  closable?: boolean; canBack?: boolean; canForward?: boolean;
}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const item = (id: string, label: string, enabled = true): WinMenuItem =>
    ({ id, label, enabled });
  const sep: WinMenuItem = { type: 'separator' };
  let tpl: WinMenuItem[] = [];
  {
    switch (ctx.type) {
      case 'link':
        tpl = [
          item('follow', 'Follow Link'),
          item('branch', 'Follow Link in a New Trail'),
        ];
        break;
      case 'histEntry':
        tpl = [
          item('jump', 'Jump to This Entry', !ctx.current),
          sep,
          item('rename', 'Rename\u2026'),
          item('reanchor', 'Set to Current Position'),
        ];
        break;
      case 'stack':
        tpl = [
          item('switch', 'Switch to This Trail', !ctx.active),
          sep,
          item('rename', 'Rename\u2026'),
          item('duplicate', 'Duplicate'),
          sep,
          item('close', 'Close Trail', !!ctx.closable),
        ];
        break;
      case 'viewer':
        tpl = [
          item('back', 'Back', !!ctx.canBack),
          item('forward', 'Forward', !!ctx.canForward),
          sep,
          item('mark', 'Mark This Spot'),
          sep,
          item('zoom-in', 'Zoom In'),
          item('zoom-out', 'Zoom Out'),
          item('fit', 'Fit Width'),
        ];
        break;
      default:
        return null;
    }
  }
  // Windows gets a REAL OS menu (Electron's is a Chromium-drawn widget
  // there); the mac popup is already native.
  if (process.platform === 'win32') return popupWin32(win, tpl);
  return await new Promise<string | null>((resolve) => {
    let choice: string | null = null;
    const menu = Menu.buildFromTemplate(tpl.map((e) => ('type' in e
      ? { type: 'separator' as const }
      : { label: e.label, enabled: e.enabled, click: () => { choice = e.id; } })));
    menu.popup({
      window: win,
      // give the click handler a beat to run before the close callback
      callback: () => setTimeout(() => resolve(choice), 20),
    });
  });
});

// Menu-triggered saves have no user activation either: the renderer
// delegates here, and the file is written by the main process.
ipcMain.handle('pt-save-session', async (event, req: { text: string; suggestedName: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return busyWhile(win, async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: req.suggestedName,
      filters: [{ name: 'Reading session', extensions: ['ptl'] }],
    });
    if (canceled || !filePath) return null;
    await fs.promises.writeFile(filePath, req.text, 'utf8');
    return filePath;
  });
});

// "Load session…" on the desktop: a NATIVE open dialog (not the Chromium
// showOpenFilePicker) so we get the file's real on-disk path back with the
// bytes. The renderer binds that path as the silent-write target directly,
// so auto-save arms and the window closes with no "save?" prompt — the same
// as an OS-opened .ptl, and without depending on resolving a File System
// Access handle's path. Returns null when the user cancels or the read fails.
ipcMain.handle('pt-open-session-dialog', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Reading session', extensions: ['ptl'] }],
  });
  const filePath = filePaths[0];
  if (canceled || !filePath) return null;
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return { name: path.basename(filePath), text, path: filePath };
  } catch (e) {
    console.warn('could not read session', filePath, e);
    return null;
  }
});

// Silent write-back for a session bound to an on-disk path (an
// OS-opened .ptl, or one just saved through the shell dialog): auto-save
// and in-app Save target it directly, no dialog. Returns whether it wrote.
ipcMain.handle('pt-save-session-to-path', async (
  event, req: { path: string; text: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return busyWhile(win, async () => {
    try {
      await fs.promises.writeFile(req.path, req.text, 'utf8');
      return true;
    } catch (e) {
      console.warn('could not write session to', req.path, e);
      return false;
    }
  });
});

// Read a file's bytes by on-disk path, so the renderer can reopen a
// path-based recent (a PDF/.ptl bound without a FileSystemFileHandle).
ipcMain.handle('pt-read-file', async (_event, filePath: string): Promise<ArrayBuffer | null> => {
  try {
    const buf = await fs.promises.readFile(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e) {
    console.warn('could not read file', filePath, e);
    return null;
  }
});

// ---- live session sync ------------------------------------------------
// The renderer keeps its bound session file in step with the disk (an
// external script editing the .ptl shows up in the window immediately).
// fs.watchFile ON PURPOSE, not fs.watch: it watches the PATH by stat
// polling, so an editor's atomic rename-replace save and a
// delete-then-recreate both keep reporting — fs.watch follows the inode
// on some platforms and silently goes dead after a replace.

// A file's on-disk content stamp; null when it is gone or unreadable.
ipcMain.handle('pt-stat-file', async (
  _event, filePath: string): Promise<{ mtimeMs: number; size: number } | null> => {
  try {
    const st = await fs.promises.stat(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
});

// Watched paths per webContents, torn down with the webContents, so a
// closed window never leaks its stat watchers.
const fileWatchers = new Map<number, Map<string, () => void>>();

ipcMain.on('pt-watch-file', (event, filePath: string) => {
  const wc = event.sender;
  const wcId = wc.id;
  let watched = fileWatchers.get(wcId);
  if (!watched) {
    const fresh = new Map<string, () => void>();
    watched = fresh;
    fileWatchers.set(wcId, fresh);
    wc.once('destroyed', () => {
      for (const [p, listener] of fresh) fs.unwatchFile(p, listener);
      fileWatchers.delete(wcId);
    });
  }
  if (watched.has(filePath)) return;
  const listener = (): void => {
    if (!wc.isDestroyed()) wc.send('pt-file-changed', filePath);
  };
  watched.set(filePath, listener);
  // 300ms: fast enough to read as "immediately", far above stat cost.
  fs.watchFile(filePath, { interval: 300 }, listener);
});

ipcMain.on('pt-unwatch-file', (event, filePath: string) => {
  const watched = fileWatchers.get(event.sender.id);
  const listener = watched?.get(filePath);
  if (!watched || !listener) return;
  watched.delete(filePath);
  fs.unwatchFile(filePath, listener);
});

// The close-save dialog, requested by the renderer's async close flow ONLY
// when it couldn't write silently (never-saved session, denied permission, or
// a failed write). Native, so it looks like the platform's. Returns the choice.
// ASYNC (showMessageBox, never …Sync) — load-bearing: the synchronous variant
// runs a nested modal loop that freezes this process's JS queue while the
// renderer's cancelled close is still settling. The queued unload-prevented
// ack then rots past Chromium's beforeunload patience, and the moment the
// dialog closes the window is torn down — before the save-as picker can
// appear. The user clicked "Save…" and the never-saved session was lost
// (observed on both platforms). The async dialog keeps the queue turning, so
// the close settles while the user reads the prompt and the window survives
// to be saved.
ipcMain.handle('pt-confirm-close-save', async (event): Promise<'save' | 'dont-save' | 'cancel'> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return 'cancel';
  return busyWhile(win, async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Save…', 'Don’t Save', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save your reading session?',
      detail: 'Your changes will be lost if you don’t save them.',
    });
    return response === 0 ? 'save' : response === 1 ? 'dont-save' : 'cancel';
  });
});

// DORMANT — kept for the deferred OS-shutdown fast-path. A time-boxed OS
// shutdown (Windows session-end / mac before-quit) can't wait for the renderer's
// async close-save, so it will still need this SYNCHRONOUS write. NOT used by
// the normal close flow any more (the renderer now saves async via closeAndSave).
ipcMain.on('pt-save-session-on-close', (event, req: { path: string; text: string }) => {
  try {
    fs.writeFileSync(req.path, req.text, 'utf8');
    event.returnValue = true;
  } catch (e) {
    console.warn('could not flush session on close to', req.path, e);
    event.returnValue = false;
  }
});

// The dot in the macOS close button mirrors unsaved session changes.
ipcMain.on('pt-document-edited', (event, edited: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setDocumentEdited(!!edited);
  // The OS-shutdown guards ask windows with unsaved sessions first.
  if (edited) {
    editedWindows.add(win.id);
    // Windows: register the reason NOW (no-op elsewhere) so it is already in
    // place when the OS composes its shutdown screen; the query-session-end
    // veto is what actually withholds the shutdown.
    blockShutdown(win, SHUTDOWN_BLOCK_REASON);
  } else {
    editedWindows.delete(win.id);
    unblockShutdown(win);
  }
});

// A PDF picked in an occupied window opens in a window of its own.
ipcMain.on('pt-open-new-window', (_event, file: { name: string; data: ArrayBuffer }) => {
  const win = createWindow();
  // The handed-over PDF is in flight: a racing OS open must not treat
  // this window as empty and pile a second document into it.
  claimWindow(win, 'pdf');
  sendFileTo(win, file);
});

ipcMain.on('pt-open-file-ready', (event) => {
  dbg('renderer ready', event.sender.id);
  readyWindows.add(event.sender.id);
  const win = BrowserWindow.fromWebContents(event.sender);
  const queued = queuedFiles.get(event.sender.id);
  queuedFiles.delete(event.sender.id);
  if (win) queued?.forEach((f) => sendFileTo(win, f));
  // Background updates install silently on quit; the first window of
  // the next start carries the only announcement the user gets.
  if (announceVersion) {
    event.sender.send('pt-menu', 'updated', announceVersion);
    announceVersion = null;
  }
});

/**
 * A quit-installed update is announced once on the next start. The
 * previous version lives in a userData marker; the very first run just
 * writes it and stays quiet.
 */
let announceVersion: string | null = null;
function detectQuitInstalledUpdate(): string | null {
  const marker = path.join(app.getPath('userData'), 'last-version.txt');
  let prev = '';
  try { prev = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first run */ }
  const cur = app.getVersion();
  if (prev === cur) return null;
  try { fs.writeFileSync(marker, `${cur}\n`); } catch (e) { dbg('version marker write failed', e); }
  return prev ? cur : null;
}

void app.whenReady().then(() => {
  registerAppProtocol();
  announceVersion = detectQuitInstalledUpdate();
  setupAutoUpdates();
  // macOS gets the full native menu bar; Windows has none (its window
  // chrome integrates with the toolbar, and shortcuts live in the app).
  if (isMac) buildMenu();
  else Menu.setApplicationMenu(null);

  // A double-clicked document launches the app with the file already
  // known: the first window then waits for the document before it
  // shows, instead of flashing empty.
  const startsWithFile = pendingPaths.length > 0
    || process.argv.slice(1).some((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a));
  const win = createWindow({ showWhenLoaded: startsWithFile });

  // Standard app-level niceties.
  app.setAboutPanelOptions({
    applicationName: 'Paper Trail',
    applicationVersion: app.getVersion(),
    copyright: 'MIT licensed \u2014 github.com/DE0CH/paper-trail',
  });
  if (isMac) {
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: 'New Window', click: () => void createWindow() },
    ]));
  } else {
    // Windows taskbar Jump List: a New Window task (the counterpart of
    // the macOS Dock menu) plus recent documents (uses the installer's
    // file associations). The task launches a second process whose
    // --new-window flag reaches the running instance via
    // 'second-instance'.
    app.setJumpList([
      {
        type: 'tasks',
        items: [{
          type: 'task',
          title: 'New Window',
          description: 'Open a new Paper Trail window',
          program: process.execPath,
          args: '--new-window',
          iconPath: process.execPath,
          iconIndex: 0,
        }],
      },
      { type: 'recent' },
    ]);
  }

  // Files double-clicked before the app finished launching, and (on
  // Windows / dev runs) file arguments on the command line.
  pendingPaths.splice(0).forEach((f) => openPath(f, win));
  process.argv.slice(1)
    .filter((a) => /\.(pdf|ptl)$/i.test(a) && fs.existsSync(a))
    .forEach((f) => openPath(f, win));

  if (SMOKE) {
    // With a file argument the smoke test also proves the OS-open path
    // (the same pipeline Open With…, Dock drops, File > Open, and the
    // menu's Load Reading Session dialog go through). A .pdf must end up
    // in the window title; a .ptl must land in the pending-session
    // prompt (sessions never auto-open their PDF).
    const fileArg = process.argv.slice(1).find((a) => /\.(pdf|ptl)$/i.test(a));
    const wantSession = !!fileArg && /\.ptl$/i.test(fileArg);
    const deadline = Date.now() + (fileArg ? 20_000 : 0);
    win.webContents.on('did-finish-load', () => {
      const probe = (): void => {
        win.webContents
          .executeJavaScript(
            'JSON.stringify({ title: document.title, shell: !!window.ptDesktop, fsAccess: !!window.showSaveFilePicker, secure: window.isSecureContext, pendingSession: !!document.getElementById(\'sessionPrompt\') })',
          )
          .then((json: string) => {
            const ok = JSON.parse(json) as { title: string; shell: boolean; pendingSession: boolean };
            const docLoaded = !fileArg
              || (wantSession ? ok.pendingSession : ok.title.includes(path.basename(fileArg)));
            if (ok.title.includes('Paper Trail') && ok.shell && docLoaded) {
              console.log('SMOKE', json);
              app.exit(0);
            } else if (Date.now() < deadline) {
              setTimeout(probe, 300);
            } else {
              console.error('SMOKE FAIL', json);
              app.exit(1);
            }
          })
          .catch((e: unknown) => {
            console.error('SMOKE FAIL', e);
            app.exit(1);
          });
      };
      probe();
    });
  }
});

// macOS: OS shutdown/logout AND Cmd+Q both arrive here. Hold the quit while
// any session is unsaved and drive the normal save dialog; only quit once
// every window has agreed. (Windows uses per-window query-session-end.)
app.on('before-quit', (event) => {
  if (!isMac || quitApproved) return;
  if (editedWindows.size === 0) return; // nothing unsaved → quit normally
  event.preventDefault();               // NSTerminateCancel until the user decides
  void (async () => {
    if (await promptCloseAllWindows()) { quitApproved = true; app.quit(); }
    // else a window stayed open (Save…/Cancel) → quit abandoned
  })();
});

app.on('activate', () => {
  // macOS: clicking the Dock icon with no windows open makes a new one.
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (!isMac || SMOKE) app.quit();
});
