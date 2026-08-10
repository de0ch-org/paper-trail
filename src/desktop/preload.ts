// Minimal bridge: the web app only learns that it runs inside the desktop
// shell, receives menu actions, and receives files the OS asked us to open
// (Open With…, dropping a PDF on the Dock icon, recent documents). No
// filesystem or Node access is exposed.

import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('ptDesktop', {
  platform: process.platform,
  // The on-disk path of a File the renderer already holds (a drop, a
  // showOpenFilePicker handle's getFile(), an <input> pick). Lets every
  // open method bind the same silent-write target as an OS-opened file,
  // so autosave arms and the close-flush writes synchronously — no matter
  // how the .ptl was opened. Empty string when Electron can't resolve one.
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  // "Load session…" via a native open dialog: returns the picked .ptl's
  // text AND its real on-disk path, so the renderer binds a silent-write
  // target directly (no File System Access handle needed). Null on cancel.
  openSessionDialog: (): Promise<{ name: string; text: string; path: string } | null> =>
    ipcRenderer.invoke('pt-open-session-dialog') as Promise<{ name: string; text: string; path: string } | null>,
  onMenu: (cb: (action: string, payload?: string) => void) => {
    ipcRenderer.on('pt-menu', (_event, action: string, payload?: string) => cb(action, payload));
  },
  onOpenFile: (cb: (file: { name: string; data: ArrayBuffer; path?: string }) => void) => {
    ipcRenderer.on('pt-open-file',
      (_event, file: { name: string; data: ArrayBuffer; path?: string }) => cb(file));
    ipcRenderer.send('pt-open-file-ready');
  },
  // Native right-click menus: the renderer describes what was clicked,
  // the main process shows the menu and returns the chosen action id.
  showContextMenu: (ctx: unknown): Promise<string | null> =>
    ipcRenderer.invoke('pt-context-menu', ctx) as Promise<string | null>,
  // Unsaved-changes indicator for the native window chrome (the dot in
  // the macOS close button).
  setDocumentEdited: (edited: boolean) => {
    ipcRenderer.send('pt-document-edited', edited);
  },
  // Menu-triggered saves lack user activation for the renderer's picker;
  // the shell writes the file instead. Resolves to the path or null.
  saveSessionFallback: (text: string, suggestedName: string): Promise<string | null> =>
    ipcRenderer.invoke('pt-save-session', { text, suggestedName }) as Promise<string | null>,
  // Silent write-back to an already-bound session file path (no dialog).
  saveSessionToPath: (filePath: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke('pt-save-session-to-path', { path: filePath, text }) as Promise<boolean>,
  // Read a file's bytes by on-disk path — reopening a path-based recent.
  readFileByPath: (filePath: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('pt-read-file', filePath) as Promise<ArrayBuffer | null>,
  // A file's on-disk content stamp (live session sync); null when gone.
  statFile: (filePath: string): Promise<{ mtimeMs: number; size: number } | null> =>
    ipcRenderer.invoke('pt-stat-file', filePath) as Promise<{ mtimeMs: number; size: number } | null>,
  // Live session sync: the main process stat-watches subscribed paths and
  // pushes their change events through the one pt-file-changed stream.
  watchFile: (filePath: string): void => {
    ipcRenderer.send('pt-watch-file', filePath);
  },
  unwatchFile: (filePath: string): void => {
    ipcRenderer.send('pt-unwatch-file', filePath);
  },
  onFileChanged: (cb: (path: string) => void): void => {
    ipcRenderer.on('pt-file-changed', (_event, p: string) => cb(p));
  },
  // A PDF picked while this window already shows one opens elsewhere.
  openInNewWindow: (name: string, data: ArrayBuffer) => {
    ipcRenderer.send('pt-open-new-window', { name, data });
  },
  // The native "save your reading session?" dialog, shown by the renderer's
  // async close flow only when it couldn't save silently. Returns the choice.
  confirmCloseSave: (): Promise<'save' | 'dont-save' | 'cancel'> =>
    ipcRenderer.invoke('pt-confirm-close-save') as Promise<'save' | 'dont-save' | 'cancel'>,
  // The close flow decided to KEEP the window open (Cancel at the prompt, a
  // canceled picker, or a failed save): tell the shell, so a pending
  // quit/close-all stops waiting for this window instead of timing out.
  closeFlowKeptWindow: () => {
    ipcRenderer.send('pt-close-kept-open');
  },
  // DORMANT — kept for the deferred OS-shutdown fast-path (a time-boxed
  // shutdown can't await the async close-save). No longer used by the normal
  // close flow, which now saves asynchronously; see Controller.closeAndSave.
  saveSessionOnClose: (filePath: string, text: string): boolean =>
    ipcRenderer.sendSync('pt-save-session-on-close', { path: filePath, text }) as boolean,
});
