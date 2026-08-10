// One identity for an opened file, however it arrived. A file reaches the
// app two ways — as a FileSystemFileHandle (browser pickers, Chromium
// drag-drop) or as an on-disk path string (OS opens, native shell dialogs,
// desktop drops) — and a BoundFile is EXACTLY ONE of the two, decided once
// at acquisition time by the from* factories below. From then on reading,
// writing, and permission checks go through this one object, so consumers
// never branch on twin handle/path fields.
//
// Error contract:
// - read()/readText() THROW when the file cannot be read (missing file,
//   revoked permission, IPC failure) — callers own their precise messages.
// - write() returns true only when the bytes actually reached the disk;
//   every failure is false, never a throw — so only a successful write can
//   clear a dirty flag.
// - canWriteSilently()/requestWrite()/requestRead() return booleans and
//   never throw. A path binding needs no permission at all (the desktop
//   shell writes straight to disk); a handle follows the File System
//   Access permission model.

import { isHandle, type FileRef } from './recents';
import { ensureReadPermission } from './store';
import type {} from './types'; // the Window.ptDesktop global augmentation

/**
 * A point-in-time identity of the file's on-disk content, for detecting
 * that someone else wrote the file. Equal stamps mean "unchanged"; a
 * differing stamp only means "look again" (the reader compares content),
 * so coarse mtime resolution can't corrupt anything.
 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** Two nullable stamps describe the same on-disk content. */
export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * A file the app can read from and (for session files) write back to,
 * identified by exactly one mechanism — a browser handle or an on-disk
 * path.
 */
export interface BoundFile {
  /** Which mechanism identifies the file ('path' exists only on desktop). */
  readonly kind: 'handle' | 'path';
  /** The file name, for display and for naming saved sessions. */
  readonly name: string;
  /** The identity exactly as the recents store keeps it. */
  readonly ref: FileRef;
  /** The file's bytes (a PDF's content). Throws when unreadable. */
  read(): Promise<ArrayBuffer>;
  /** The file's text (a .ptl session's content). Throws when unreadable. */
  readText(): Promise<string>;
  /** Write `text` back to the file. True only when the write happened. */
  write(text: string): Promise<boolean>;
  /**
   * True when write() will not show a permission prompt. This is the
   * auto-save gate: a timer save must never pop a prompt out of nowhere.
   */
  canWriteSilently(): Promise<boolean>;
  /**
   * User-initiated save: the one right moment to prompt for write
   * permission if it is needed. True when writing may proceed.
   */
  requestWrite(): Promise<boolean>;
  /**
   * Prompt for read permission if it is needed (a handle restored from
   * the recents store comes back unpermitted). True when reading may
   * proceed — a false is a declined prompt, distinct from a missing file.
   */
  requestRead(): Promise<boolean>;
  /**
   * The current on-disk content stamp, or null when the file is missing,
   * unreadable, or the mechanism can't stat it (test fakes). Never throws.
   */
  stamp(): Promise<FileStamp | null>;
  /**
   * Start watching the file for on-disk changes made by OTHER writers
   * (an external script, another window, an editor). `onChange` is a
   * bare "look again" signal — it may fire for this app's own writes
   * too; the subscriber compares stamps/content. Returns the unwatch
   * function. A file that can't be watched (a test-fake handle) returns
   * a no-op unwatcher and never fires.
   */
  watch(onChange: () => void, opts?: { intervalMs?: number }): () => void;
}

/** The desktop shell's preload bridge, or null in a plain browser / node. */
function desktopBridge(): NonNullable<Window['ptDesktop']> | null {
  return typeof window === 'undefined' ? null : window.ptDesktop ?? null;
}

/** Filename portion of an on-disk path (either separator). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? '';
}

/**
 * Fallback watcher: poll the file's stamp and signal when it moves.
 * The first poll only takes the baseline — the subscriber records its
 * own baseline at bind time, so nothing is lost. Overlapping ticks
 * collapse (a slow stat never stacks).
 */
function pollStamp(
  file: Pick<BoundFile, 'stamp'>,
  onChange: () => void,
  intervalMs: number,
): () => void {
  let last: FileStamp | null | undefined; // undefined = no baseline yet
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const s = await file.stamp();
      if (last === undefined) { last = s; return; }
      // Only a PRESENT, different stamp signals: transient nulls (the
      // file mid-replace, a revoked grant) must not fire, and the next
      // present stamp after one compares against the last real content.
      if (s && !sameStamp(s, last)) {
        last = s;
        onChange();
      }
    } finally {
      ticking = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  return () => clearInterval(timer);
}

/** A file identified by a File System Access handle (browser mechanisms). */
export class HandleFile implements BoundFile {
  readonly kind = 'handle' as const;

  constructor(private readonly handle: FileSystemFileHandle) {}

  get name(): string {
    return this.handle.name;
  }

  get ref(): FileRef {
    return this.handle;
  }

  async read(): Promise<ArrayBuffer> {
    return (await this.handle.getFile()).arrayBuffer();
  }

  async readText(): Promise<string> {
    return (await this.handle.getFile()).text();
  }

  async write(text: string): Promise<boolean> {
    try {
      const w = await this.handle.createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch (e) {
      console.warn('BoundFile: handle write failed', e);
      return false;
    }
  }

  /**
   * The permission API is Chromium-only and absent on test fakes — no API
   * means nothing can prompt, so the write counts as silent. The desktop
   * shell has no permission UI at all — requests are granted invisibly
   * (handles restored from the recents store always come back in the
   * 'prompt' state) — so there this simply asks. A throwing query is
   * treated as writable: write() surfaces the real failure.
   */
  async canWriteSilently(): Promise<boolean> {
    const h = this.handle;
    if (!h.queryPermission) return true;
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      if (desktopBridge() && h.requestPermission) {
        return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
      }
      return false;
    } catch {
      return true;
    }
  }

  async requestWrite(): Promise<boolean> {
    const h = this.handle;
    if (!h.queryPermission) return true;
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted';
    } catch {
      return true; // proceed: write() surfaces real failures
    }
  }

  async requestRead(): Promise<boolean> {
    return ensureReadPermission(this.handle);
  }

  async stamp(): Promise<FileStamp | null> {
    try {
      const f = await this.handle.getFile();
      return { mtimeMs: f.lastModified, size: f.size };
    } catch {
      return null;
    }
  }

  /**
   * Handles have no change events — the File System Access API can only
   * poll getFile()'s lastModified. Gated on isSameEntry the same way
   * recordRecent gates: a test-fake handle (no isSameEntry) mints a
   * fresh lastModified on every getFile() and would fire non-stop.
   */
  watch(onChange: () => void, { intervalMs = 1000 }: { intervalMs?: number } = {}): () => void {
    if (typeof this.handle.isSameEntry !== 'function') return () => {};
    return pollStamp(this, onChange, intervalMs);
  }
}

/**
 * A file identified by its on-disk path, reached through the desktop
 * shell's window.ptDesktop bridge — a PathFile cannot exist in a plain
 * browser (the constructor throws there). Paths never involve permission
 * UI: the shell reads and writes straight to disk over IPC.
 */
export class PathFile implements BoundFile {
  readonly kind = 'path' as const;
  readonly name: string;

  constructor(readonly path: string, name?: string) {
    if (!path) {
      // An empty path is treated as unbound by every factory — reaching
      // here is a caller bug, never write to a made-up target.
      throw new Error('PathFile: an empty path is not a file');
    }
    if (!desktopBridge()) {
      throw new Error(
        'PathFile needs the desktop shell (window.ptDesktop): '
        + 'a browser cannot reach a file by on-disk path',
      );
    }
    this.name = name || baseName(path);
  }

  get ref(): FileRef {
    return this.path;
  }

  async read(): Promise<ArrayBuffer> {
    const buf = await desktopBridge()?.readFileByPath?.(this.path);
    if (!buf) throw new Error(`unreadable: ${this.path}`);
    return buf;
  }

  async readText(): Promise<string> {
    return new TextDecoder().decode(await this.read());
  }

  async write(text: string): Promise<boolean> {
    try {
      return (await desktopBridge()?.saveSessionToPath?.(this.path, text)) === true;
    } catch (e) {
      console.warn('BoundFile: path write failed', e);
      return false;
    }
  }

  async canWriteSilently(): Promise<boolean> {
    return true;
  }

  async requestWrite(): Promise<boolean> {
    return true;
  }

  async requestRead(): Promise<boolean> {
    return true;
  }

  async stamp(): Promise<FileStamp | null> {
    try {
      return (await desktopBridge()?.statFile?.(this.path)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The desktop shell pushes change events (it stat-watches the path in
   * the main process — see pt-watch-file in desktop/main.ts), so external
   * writes surface within a few hundred ms. A shell without the watch
   * bridge (older build) falls back to polling the stat IPC.
   */
  watch(onChange: () => void, { intervalMs = 1000 }: { intervalMs?: number } = {}): () => void {
    const unwatch = subscribePathChange(this.path, onChange);
    return unwatch ?? pollStamp(this, onChange, intervalMs);
  }
}

// One renderer-wide dispatch table for pushed path-change events: the
// preload bridge registers a single ipc listener, and each watched path
// keeps its subscriber set here. The shell watches a path while at least
// one subscriber holds it.
let pathChangeTargets: Map<string, Set<() => void>> | null = null;

function subscribePathChange(path: string, onChange: () => void): (() => void) | null {
  const bridge = desktopBridge();
  if (!bridge?.watchFile || !bridge.unwatchFile || !bridge.onFileChanged) return null;
  if (!pathChangeTargets) {
    const targets = new Map<string, Set<() => void>>();
    pathChangeTargets = targets;
    bridge.onFileChanged((p) => {
      for (const fn of [...(targets.get(p) ?? [])]) fn();
    });
  }
  let subs = pathChangeTargets.get(path);
  if (!subs) {
    subs = new Set();
    pathChangeTargets.set(path, subs);
    bridge.watchFile(path);
  }
  subs.add(onChange);
  return () => {
    subs.delete(onChange);
    if (subs.size === 0) {
      pathChangeTargets?.delete(path);
      desktopBridge()?.unwatchFile?.(path);
    }
  };
}

// ---- acquisition factories -------------------------------------------------
// One per entry flow, so each acquisition site makes exactly one call and
// the handle-or-path decision lives here, not at the call sites.

/**
 * A handle from showOpenFilePicker / showSaveFilePicker. In the desktop
 * shell the picked File also resolves to an on-disk path, and the path is
 * the stronger binding (silent writes by construction, IPC reads, survives
 * a restart as a plain string) — so pass the File when one is in hand and
 * the path is preferred; without one (the save picker) the handle binds.
 */
export function fromPickerHandle(handle: FileSystemFileHandle, file?: File): BoundFile {
  const path = file ? desktopBridge()?.getPathForFile?.(file) : undefined;
  return path ? new PathFile(path, file?.name) : new HandleFile(handle);
}

/**
 * A dropped File (also the <input type=file> fallback, which has no
 * DataTransferItem). Desktop: the file's real path binds, exactly like an
 * OS open. Browser: the item's file handle. Neither available → null, an
 * unbound open (the caller reads the File's bytes; there is no save
 * target).
 */
export async function fromDrop(file: File, item?: DataTransferItem): Promise<BoundFile | null> {
  const path = desktopBridge()?.getPathForFile?.(file);
  if (path) return new PathFile(path, file.name);
  try {
    if (item?.getAsFileSystemHandle) {
      const h = await item.getAsFileSystemHandle();
      if (h?.kind === 'file') return new HandleFile(h as FileSystemFileHandle);
    }
  } catch { /* no usable handle — fall through to unbound */ }
  return null;
}

/**
 * An OS-initiated open (Open With…, a Dock drop, the OS recents): the
 * shell already read the bytes and sent the path along. An empty or
 * missing path stays unbound (null) — never write to a made-up target.
 */
export function fromOsOpen(path: string | null | undefined, name: string): PathFile | null {
  return path ? new PathFile(path, name) : null;
}

/**
 * A native shell dialog's result (openSessionDialog, saveSessionFallback):
 * binds the dialog's real path. Cancel or an empty path → null.
 */
export function fromShellDialog(path: string | null | undefined, name?: string): PathFile | null {
  return path ? new PathFile(path, name) : null;
}

/** A recents-store identity coming back: rewrap whichever kind it is. */
export function fromRecentRef(ref: FileRef, name?: string): BoundFile {
  return isHandle(ref) ? new HandleFile(ref) : new PathFile(ref, name);
}
