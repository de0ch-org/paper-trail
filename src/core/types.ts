// Shared domain types.

/** Scale-independent position inside the document. */
export interface Pos {
  /** 1-based page number. */
  page: number;
  /** Vertical position within the page, 0..1. */
  yRatio: number;
}

export interface HistEntry {
  label: string;
  pos: Pos;
  /**
   * True once the user renamed the entry by hand (a rename that leaves
   * the text unchanged does not count). Re-anchoring keeps hand-written
   * labels but refreshes automatic ones.
   */
  edited?: boolean;
}

export interface HistStack {
  id: number;
  name: string;
  entries: HistEntry[];
  /** Cursor into `entries`. */
  index: number;
}

export interface SerializedStacks {
  v: 3;
  activeId: number;
  nameCounter: number;
  stacks: HistStack[];
}

export interface SerializedState {
  v: 1;
  name: string;
  scale: number;
  fitWidth: boolean;
  hist: SerializedStacks;
  pos: Pos;
  ts: number;
}

export interface ProgressFile {
  type: 'pdf-stack-reader-progress';
  /** The file format version this object was parsed from. Constructed
      objects serialize as the current version regardless; only keepV1
      (set by the parser alone) pins a file to v1 on save. */
  v: 1 | 2;
  /** Set by parseProgress on files LOADED as v1: the file keeps its v1
      header and its recorded time untouched when saved back. */
  keepV1?: true;
  /** Epoch of the v1 `saved` line; v2 records no time, so for v2 files
      this is just the parse moment and never reaches the file. */
  savedAt: number;
  /** v1 only: the `saved` line's value verbatim, so saving a v1 file
      back never edits its recorded time. */
  savedRaw?: string;
  // Deliberately just the name: the session file must be fully
  // transparent to the user — no hidden identifiers, no paths. PDFs are
  // matched by a simple name comparison, with a visible warning banner
  // when the names differ.
  pdf: { name: string };
  state: SerializedState;
}

export interface OutlineNode {
  title: string;
  dest: unknown;
  children: OutlineNode[];
}

export type MenuAction =
  | 'open' | 'save' | 'save-from-close' | 'load-session' | 'replace-pdf' | 'back' | 'forward'
  | 'undo' | 'redo' | 'mark' | 'mark-branch' | 'reanchor'
  | 'trail-prev' | 'trail-next' | 'trail-duplicate'
  | 'zoom-in' | 'zoom-out' | 'fit' | 'find' | 'search-selection'
  | 'toggle-sidebar' | 'toggle-nav' | 'clear-history' | 'help'
  | 'updated';

/** What the renderer right-clicked on; the shell shows a native menu for it. */
export type ContextMenuRequest =
  | { type: 'editable' }
  | { type: 'selection'; text: string }
  | { type: 'link' }
  | { type: 'histEntry'; current: boolean }
  | { type: 'stack'; active: boolean; closable: boolean }
  | { type: 'viewer'; canBack: boolean; canForward: boolean };

// ---- global augmentations (File System Access API bits missing from lib.dom,
// and the Electron shell bridge) ----

declare global {
  interface Window {
    showOpenFilePicker?: (options?: {
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
      excludeAcceptAllOption?: boolean;
      startIn?: FileSystemHandle | string;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description?: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
    ptDesktop?: {
      platform: string; // process.platform of the shell ('darwin', 'win32', ...)
      // On-disk path of a File the renderer holds (drop / picker handle /
      // input), so every open method binds the same silent-write target.
      getPathForFile?: (file: File) => string;
      // Native "Load session…" open dialog: returns the picked .ptl's text
      // and real path so the session binds directly. Null on cancel.
      openSessionDialog?: () => Promise<{ name: string; text: string; path: string } | null>;
      onMenu: (cb: (action: MenuAction, payload?: string) => void) => void;
      onOpenFile: (cb: (file: { name: string; data: ArrayBuffer; path?: string }) => void) => void;
      showContextMenu: (ctx: ContextMenuRequest) => Promise<string | null>;
      setDocumentEdited: (edited: boolean) => void;
      saveSessionFallback: (text: string, suggestedName: string) => Promise<string | null>;
      saveSessionToPath?: (path: string, text: string) => Promise<boolean>;
      // Read a file's bytes by on-disk path — reopening a path-based recent
      // (an OS-opened / input-fallback / shell-saved file with no handle).
      // null if the file is gone or unreadable.
      readFileByPath?: (path: string) => Promise<ArrayBuffer | null>;
      // A file's on-disk content stamp; null when it is gone or unreadable.
      statFile?: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
      // Live session sync: subscribe/unsubscribe the shell's stat-watcher
      // for a path; changes arrive through the single onFileChanged stream.
      watchFile?: (path: string) => void;
      unwatchFile?: (path: string) => void;
      onFileChanged?: (cb: (path: string) => void) => void;
      // The native "save your reading session?" dialog on close, shown by the
      // renderer only when the async close-save couldn't write silently.
      confirmCloseSave?: () => Promise<'save' | 'dont-save' | 'cancel'>;
      // The close flow kept the window open (Cancel / canceled picker /
      // failed save) — lets a pending quit stop waiting for this window.
      closeFlowKeptWindow?: () => void;
      // DORMANT: a SYNCHRONOUS flush kept for the deferred OS-shutdown fast-path
      // (a time-boxed shutdown can't wait for the async close-save). Not used by
      // the normal close flow any more — see Controller.closeAndSave.
      saveSessionOnClose?: (path: string, text: string) => boolean;
      openInNewWindow: (name: string, data: ArrayBuffer) => void;
    };
    __pt?: unknown;
  }

  interface FileSystemHandle {
    queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }

  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

export {};
