// Application controller: owns the viewer, history stacks, search, hover
// preview, persistence, and reading-progress sessions. Framework-agnostic;
// the React UI subscribes to an immutable snapshot and calls methods.

import { MOD } from './platform';
import { Viewer, type LinkInfo } from './viewer';
import { NavStacks } from './history';
import { SearchController } from './search';
import { Preview } from './preview';
import {
  getRecents, recordRecentMerged, removeRecentMerged,
} from './store';
import {
  buildDisplayList, isHandle, type RecentEntry, type RecentDisplay, type FileRef,
} from './recents';
import {
  parseProgress, serializeProgress, progressVersion, PROGRESS_EXT, PROGRESS_VERSION,
} from './progressFormat';
import {
  HandleFile, PathFile, fromPickerHandle, fromShellDialog, fromRecentRef, sameStamp,
  type BoundFile, type FileStamp,
} from './boundFile';
import type {
  HistStack, OutlineNode, Pos, ProgressFile, SerializedState,
} from './types';

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved';

export interface Snapshot {
  docOpen: boolean;
  docTitle: string;
  /** Monotonic per-document generation (viewer epoch): changes on every
   * document swap, even to a same-named file with the same page count. */
  docGeneration: number;
  numPages: number;
  currentPage: number;
  zoomPercent: number;
  canBack: boolean;
  canForward: boolean;
  canUndo: boolean;
  canRedo: boolean;
  stacks: HistStack[];
  activeStackId: number;
  activeIndex: number;
  outline: OutlineNode[];
  recents: RecentDisplay[];
  searchCount: string;
  save: SaveState;
  saveBound: boolean;
  toast: { id: number; msg: string } | null;
  /** A session file was opened first; waiting for the user to open its PDF. */
  pendingPdfName: string | null;
  /** A session load needs confirmation (it replaces current reading state). */
  confirmPdfName: string | null;
  /** The open PDF doesn't match the one the session was saved with. */
  mismatch: { savedName: string; openName: string } | null;
  /** The session file changed on disk while this window holds unsaved
   * changes — the user picks a side (overwrite / reload). */
  diskConflict: { fileName: string } | null;
}

/**
 * The bound session file and save state. The binding is ONE BoundFile —
 * a browser handle or a desktop path, decided at acquisition — so the
 * write paths never branch on twin nullable fields. `handle` and `path`
 * are compatibility VIEWS over the binding for the stable window.__pt
 * hook surface (tests read them and inject fakes): reading yields the
 * underlying ref when the binding is of that kind, else null; writing
 * rebinds, and assigning null clears only a binding of the same kind,
 * so the two views can be assigned in either order.
 */
class Session {
  file: BoundFile | null = null;
  dirty = false;
  saving = false;

  get handle(): FileSystemFileHandle | null {
    return this.file?.kind === 'handle' ? this.file.ref as FileSystemFileHandle : null;
  }

  set handle(h: FileSystemFileHandle | null) {
    if (h) this.file = new HandleFile(h);
    else if (this.file?.kind === 'handle') this.file = null;
  }

  get path(): string | null {
    return this.file?.kind === 'path' ? this.file.ref as string : null;
  }

  set path(p: string | null) {
    if (p) this.file = new PathFile(p);
    else if (this.file?.kind === 'path') this.file = null;
  }
}

type PdfSource = File | FileSystemFileHandle | string;

interface ReplaceSlot {
  source: PdfSource;
  state: SerializedState;
}

export class Controller {
  viewer!: Viewer;
  hist = new NavStacks(null);
  search!: SearchController;
  preview!: Preview;
  session = new Session();

  // Set true just before we programmatically re-close a window after an async
  // save, so the beforeunload handler lets that close through (see closeAndSave).
  private forceClose = false;

  private docOpen = false;
  private currentName = '';
  private searchEntry: ReturnType<NavStacks['visit']> | null = null;
  private outline: OutlineNode[] = [];
  private recents: RecentEntry[] = [];
  // The open PDF's identity as the recents list keys it — a handle for
  // browser / drag-drop opens, an on-disk path for desktop OS-open /
  // input-fallback opens. Only ever a recents KEY (plus a display name):
  // the PDF is re-read through openRecent, never through this ref.
  private currentPdfRef: FileRef | null = null;
  // A fresh (never-saved) session: set when a PDF opens without a bound
  // session, cleared on the first save or when an existing session loads.
  private freshSession = false;
  private toast_: { id: number; msg: string } | null = null;
  private toastSeq = 0;
  private currentPage = 1;
  private restoring = false;
  private pendingProgress: { json: ProgressFile } | null = null;
  /** The waiting session's own .ptl binding (bound once its PDF opens). */
  private pendingProgressFile: BoundFile | null = null;
  private confirmSession: {
    json: ProgressFile;
    file: BoundFile | null;
  } | null = null;
  private mismatch_: { savedName: string; openName: string } | null = null;

  // ---- live sync with the on-disk session file ----
  // The stamp and text of the disk content this window last read or
  // wrote. A differing stamp with DIFFERING text is an external change;
  // a differing stamp with the same text (a same-bytes rewrite, or a
  // test fake minting fresh timestamps) is absorbed silently.
  private diskStamp: FileStamp | null = null;
  private diskText: string | null = null;
  private unwatchSession: (() => void) | null = null;
  private diskConflict_: { fileName: string } | null = null;
  // Change signals arriving mid-reconcile coalesce into one trailing pass.
  private reconcilingDisk = false;
  private reconcileAgain = false;

  private fileSaveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private toastTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pinchStartScale: number | null = null;
  private pinchFactor = 1;
  private pinchAnchor: { x: number; y: number } | null = null;

  // Undoable PDF replacement: single-slot document-level undo/redo. The
  // source is a File / handle / URL (a cheap disk reference, not bytes).
  private currentSource: PdfSource | null = null;
  private replaceUndoSlot: ReplaceSlot | null = null;
  private replaceRedoSlot: ReplaceSlot | null = null;
  private lastReplaceAction: 'none' | 'undoable' | 'redoable' = 'none';

  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private fileInput: HTMLInputElement | null = null;

  // ---------- lifecycle ----------

  attach(container: HTMLElement, viewerEl: HTMLElement, previewEl: HTMLElement): void {
    this.viewer = new Viewer(container, viewerEl, {
      onLinkClick: (info) => void this.handleLinkClick(info),
      onLinkHover: (info, entering) => {
        if (entering) this.preview.scheduleShow(info.dest, info.linkEl);
        else this.preview.scheduleHide(); // entering the popup cancels this
      },
      onPageChange: (n) => {
        this.currentPage = n;
        this.notify();
      },
      onScroll: () => this.onViewerScroll(),
      onPageRendered: (p, n) => {
        if (this.search.query) void this.search.highlightPage(p, n);
      },
      onScaleChange: () => {
        this.markDirty();
        this.notify();
      },
    });
    this.search = new SearchController(this.viewer);
    // Streamed search results: keep the match count live in the UI while
    // the worker is still indexing (highlights refresh inside the search
    // controller itself).
    this.search.onUpdate = () => this.notify();
    this.preview = new Preview(this.viewer, previewEl);
    this.hist.onChange = () => {
      this.markDirty();
      this.notify();
    };
    // Any history mutation supersedes a pending replace-undo/redo.
    this.hist.onMutate = () => {
      this.lastReplaceAction = 'none';
    };

    // Trackpad pinch (and ctrl+wheel) zooms the document smoothly: every
    // event updates a cheap CSS transform on the already-rendered pages
    // (instant feedback, anchored at the cursor); when the gesture pauses,
    // the target scale is re-rendered crisply — with the old canvases kept
    // as stretched placeholders, so nothing ever flashes blank.
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (!this.docOpen) return;
      this.pinchAnchor = { x: e.clientX, y: e.clientY };
      if (this.pinchStartScale == null) {
        this.pinchStartScale = this.viewer.scale;
        this.pinchFactor = 1;
        this.viewer.beginVisualZoom();
      }
      const start = this.pinchStartScale;
      this.pinchFactor = Math.min(
        Math.max(this.pinchFactor * Math.exp(-e.deltaY * 0.01), 0.25 / start),
        5 / start,
      );
      this.viewer.applyVisualZoom(this.pinchFactor, this.pinchAnchor);
      clearTimeout(this.pinchTimer);
      this.pinchTimer = setTimeout(() => {
        this.pinchTimer = 0;
        if (this.pinchStartScale == null || !this.pinchAnchor) return;
        const target = this.pinchStartScale * this.pinchFactor;
        this.pinchStartScale = null;
        this.viewer.commitVisualZoom(target, this.pinchAnchor);
      }, 180);
    }, { passive: false });

    window.addEventListener('beforeunload', (e) => {
      if (this.forceClose) return; // the programmatic re-close after a save
      if (!this.docOpen || !this.session.dirty) return;
      // Cancel THIS close. beforeunload can't await, so we never try to save
      // synchronously here. In the browser this simply triggers the browser's
      // own (generic, unavoidable) unsaved-changes prompt. On the desktop we
      // hand off to an ASYNC save while the window is held open — which can use
      // the handle write, not just a path, so handle-bound sessions (Open
      // Recent) close cleanly too — then close on success or ask on failure.
      e.preventDefault();
      // A close while a close flow is already running (the user clicking X
      // again with the save prompt up) must not stack a second prompt: the
      // close is still cancelled, the running flow finishes the job.
      if (window.ptDesktop && !this.closeInProgress) void this.closeAndSave();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.docOpen) {
        if (this.session.file && this.session.dirty) {
          this.writeProgressAuto().catch(() => { /* dirty flag stays honest */ });
        }
      }
    });

    void this.refreshRecents();
    void this.bootFromQuery();
    this.initTabHandoff();

    // Test / debugging hooks.
    window.__pt = {
      controller: this,
      viewer: this.viewer,
      hist: this.hist,
      search: this.search,
      session: this.session,
      jumpVia: (pos: Pos, label: string, fork?: boolean) => this.jumpVia(pos, label, fork),
      goBack: () => this.goBack(),
      goForward: () => this.goForward(),
      writeProgress: () => this.writeProgress(),
      progressFileObject: () => this.progressFileObject(),
      // format-level hooks for tests
      progressText: () => serializeProgress(this.progressFileObject()),
      parseProgressText: (t: string) => parseProgress(t),
      // in-memory search-commit state: true = uncommitted (the next
      // find-next overwrites this entry); false = committed/none.
      searchUncommitted: () => this.searchEntry !== null,
    };
  }

  // ---------- snapshot for the UI ----------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshot) {
      this.snapshot = {
        docOpen: this.docOpen,
        docTitle: this.currentName,
        docGeneration: this.viewer ? this.viewer.docEpoch : 0,
        numPages: this.viewer ? this.viewer.numPages : 0,
        currentPage: this.currentPage,
        zoomPercent: this.viewer ? Math.round(this.viewer.scale * 100) : 100,
        canBack: this.hist.canBack(),
        canForward: this.hist.canForward(),
        canUndo: this.hist.canUndo() || this.lastReplaceAction === 'undoable',
        canRedo: this.hist.canRedo() || this.lastReplaceAction === 'redoable',
        stacks: this.hist.stacks.map((s) => ({
          ...s,
          entries: s.entries.map((e) => ({ label: e.label, pos: { ...e.pos } })),
        })),
        activeStackId: this.hist.activeId,
        activeIndex: this.hist.active.index,
        outline: this.outline,
        recents: buildDisplayList(this.recents),
        searchCount: this.search ? this.search.countLabel() : '',
        save: this.session.saving
          ? 'saving'
          : this.session.dirty
            ? 'dirty'
            : this.session.file
              ? 'saved'
              : 'idle',
        saveBound: !!this.session.file,
        toast: this.toast_,
        pendingPdfName: this.pendingProgress?.json.pdf.name ?? null,
        confirmPdfName: this.confirmSession?.json.pdf.name ?? null,
        mismatch: this.mismatch_,
        diskConflict: this.diskConflict_,
      };
    }
    return this.snapshot;
  };

  private notify(): void {
    this.snapshot = null;
    for (const fn of this.listeners) fn();
  }

  showToast(msg: string, ms = 2600): void {
    this.toast_ = { id: ++this.toastSeq, msg };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast_ = null;
      this.notify();
    }, ms);
    this.notify();
  }

  // ---------- persistence ----------

  private serializeState(): SerializedState {
    return {
      v: 1,
      name: this.currentName,
      scale: this.viewer.scale,
      fitWidth: this.viewer.fitWidth,
      hist: this.hist.serialize(),
      pos: this.viewer.currentPosition(),
      ts: Date.now(),
    };
  }


  // Bumped on every edit; a finished write may only clear `dirty` when no
  // edit arrived after its text was serialized (see writeProgress).
  private dirtyGen = 0;

  private markDirty(): void {
    if (this.restoring || !this.docOpen) return;
    this.dirtyGen += 1;
    if (!this.session.dirty) {
      this.session.dirty = true;
      this.notify();
    }
    if (this.session.file) {
      // Bound to a progress file (handle in the browser, path in the
      // desktop shell): auto-save continuously (debounced).
      clearTimeout(this.fileSaveTimer);
      this.fileSaveTimer = setTimeout(() => {
        this.writeProgressAuto().catch((e) => console.warn('auto-save failed', e));
      }, 1500);
    }
  }

  /**
   * True when writing won't trigger a browser permission prompt. Timer
   * saves must never pop a prompt out of nowhere; if permission needs
   * asking, it waits for the next user-initiated save. The desktop
   * shell has no permission UI at all — requests are granted invisibly
   * — so there it simply asks (handles restored from the Recents store
   * always come back in the 'prompt' state).
   */
  private async canWriteSilently(): Promise<boolean> {
    // A path binding is always silent (straight to disk, no permission
    // UI); a handle follows the File System Access permission model —
    // both live in the binding itself (see boundFile.ts).
    return this.session.file ? this.session.file.canWriteSilently() : false;
  }

  /** Auto-save path: write only when it can happen without a prompt. */
  private async writeProgressAuto(): Promise<void> {
    if (!(await this.canWriteSilently())) return; // stays dirty; saved on next explicit save
    await this.writeProgress();
  }

  /**
   * Desktop close flow. beforeunload has already cancelled the close, so the
   * window is held open and the event loop is free — now we can save
   * ASYNCHRONOUSLY (a handle via createWritable, or a path via IPC) and only
   * then close, or ask. Because it's async, a handle-bound session with no
   * on-disk path (opened via Open Recent) also closes silently — the write the
   * old synchronous close-flush couldn't do now runs normally.
   *
   * A time-boxed OS shutdown/logout can't wait for this async round-trip, so
   * that case is guarded in the main process instead (before-quit on macOS,
   * the vetoable query-session-end on Windows): it withholds the shutdown and
   * drives this same close flow per window. See src/desktop/main.ts.
   */
  /** A close flow is already running — a second close must not stack a
   * second confirm prompt (see the beforeunload handler). */
  private closeInProgress = false;

  private async closeAndSave(): Promise<void> {
    if (this.closeInProgress) return;
    this.closeInProgress = true;
    try {
      // Try to save with no prompt (a path is always silent; a desktop handle
      // auto-grants readwrite). writeProgress clears dirty only on a real write.
      await this.writeProgressAuto().catch(() => { /* write failed → still dirty → ask below */ });
      if (!this.session.dirty) { this.forceClose = true; window.close(); return; }
      // Couldn't save silently — a never-saved session, denied permission, or a
      // failed write. Ask with a native dialog (same wording as before).
      const choice = await window.ptDesktop?.confirmCloseSave?.();
      if (choice === 'save') {
        // The save can fail for the very reason the prompt appeared (e.g. the
        // bound handle's write throwing). closeAndSave runs un-awaited from
        // beforeunload, so an uncaught throw would vanish as an unhandled
        // rejection and the user's "Save…" would do nothing visible — catch
        // it and say so instead.
        try {
          await this.saveProgress({ viaShellDialog: true }); // save-as; binds a path
        } catch (e) {
          this.showToast('Save failed: ' + ((e as Error)?.message ?? String(e)));
        }
        if (!this.session.dirty) { this.forceClose = true; window.close(); return; }
        // still dirty (canceled picker or failed save) → keep the window
      } else if (choice === 'dont-save') {
        this.forceClose = true; window.close(); return;
      }
      // The window stays open with the change intact ('cancel', no shell, a
      // canceled picker, or a failed save). Tell the shell, so a pending
      // quit/close-all stops waiting for this window instead of timing out.
      window.ptDesktop?.closeFlowKeptWindow?.();
    } finally {
      this.closeInProgress = false;
    }
  }

  private restoreStateFrom(d: SerializedState | null): boolean {
    if (!d || d.v !== 1) return false;
    if (typeof d.scale === 'number') {
      this.viewer.setScale(d.scale, { fitWidth: !!d.fitWidth });
    }
    if (d.hist) this.hist.load(d.hist);
    // The saved view position is where the user actually was (entries keep
    // their own anchored positions and don't follow scrolling).
    const pos = d.pos ?? this.hist.current?.pos;
    if (pos) this.viewer.scrollTo(pos);
    return true;
  }

  // ---------- live sync with the on-disk session file ----------

  /**
   * THE binding point for the session file: aims the on-disk watcher at
   * it and captures the baseline stamp/text the external-change checks
   * compare against. (The Session.handle/path compatibility setters
   * bypass this — test fakes injected there get no watcher, and with no
   * recorded baseline the conflict gate stays out of their way.)
   */
  private bindSessionFile(file: BoundFile | null): void {
    this.unwatchSession?.();
    this.unwatchSession = null;
    this.session.file = file;
    this.diskStamp = null;
    this.diskText = null;
    this.diskConflict_ = null;
    if (!file) return;
    void (async () => {
      try {
        const stamp = await file.stamp();
        const text = await file.readText();
        // A write may have finished while this baseline read was in
        // flight — its (newer) record wins over this one.
        if (this.session.file === file && this.diskText === null) {
          this.diskStamp ??= stamp;
          this.diskText = text;
        }
      } catch { /* unreadable right now — the first change signal re-reads */ }
    })();
    this.unwatchSession = file.watch(() => { void this.onDiskChangeSignal(); });
  }

  /**
   * The watcher says the bound session file moved on disk. Reconcile
   * passes are serialized: signals landing mid-pass coalesce into one
   * trailing re-check, and an in-flight save settles first so this
   * window's own write is recorded before the comparison.
   */
  private async onDiskChangeSignal(): Promise<void> {
    if (this.reconcilingDisk) {
      this.reconcileAgain = true;
      return;
    }
    this.reconcilingDisk = true;
    try {
      do {
        this.reconcileAgain = false;
        await this.reconcileDiskChange();
      } while (this.reconcileAgain);
    } finally {
      this.reconcilingDisk = false;
    }
  }

  private async reconcileDiskChange(): Promise<void> {
    await this.saveChain; // let a running write record its own stamp first
    const file = this.session.file;
    if (!file || !this.docOpen) return;
    const stamp = await file.stamp();
    // Missing/unreadable is NOT a change to adopt: keep the state (and
    // any unsaved edits) intact — recreating the file is what the next
    // save is for, and a reappearing file signals the watcher again.
    if (!stamp || sameStamp(stamp, this.diskStamp)) return;
    let text: string;
    try {
      text = await file.readText();
    } catch {
      return; // gone between stat and read — same policy as a null stamp
    }
    if (text === this.diskText) {
      // Same bytes under a newer stamp (a touch, a same-content rewrite):
      // nothing to reload and nothing to warn about.
      this.diskStamp = stamp;
      return;
    }
    if (this.session.dirty) {
      // Unsaved changes here AND different bytes on disk: never silently
      // pick a side. The banner offers both; auto-save meanwhile refuses
      // to overwrite (see writeProgressNow), so the disk copy survives
      // until the user decides.
      if (!this.diskConflict_) {
        this.diskConflict_ = { fileName: file.name };
        this.notify();
      }
      return;
    }
    this.applyDiskSession(text, stamp);
  }

  /**
   * Adopt on-disk session content into this window — the disk is the
   * source of truth whenever nothing is unsaved here. Restores zoom,
   * trails, and the reading position, so the viewport follows the file.
   */
  private applyDiskSession(text: string, stamp: FileStamp | null): boolean {
    if (!this.docOpen) return false;
    const json = parseProgress(text);
    if (!json) {
      // Garbage is most likely a writer caught mid-write: change nothing
      // — its completing write signals the watcher again with full bytes.
      return false;
    }
    this.diskStamp = stamp;
    this.diskText = text;
    this.sessionOrigin = json.keepV1
      ? { keepV1: true, ...(json.savedRaw !== undefined ? { savedRaw: json.savedRaw } : {}) }
      : {};
    this.restoring = true;
    try {
      this.searchEntry = null;
      this.restoreStateFrom(json.state);
      // Same policy as reopening the file: undo history does not survive
      // the session content being replaced underneath it.
      this.hist.clearUndoRedo();
    } finally {
      this.restoring = false;
    }
    this.session.dirty = false;
    clearTimeout(this.fileSaveTimer);
    this.diskConflict_ = null;
    this.mismatch_ = (json.pdf.name && json.pdf.name !== this.currentName)
      ? { savedName: json.pdf.name, openName: this.currentName }
      : null;
    this.notify();
    return true;
  }

  /** Banner: keep this window's version — write it over the disk copy. */
  overwriteDiskSession(): void {
    this.diskConflict_ = null;
    this.notify();
    void this.writeProgress({ force: true }).then((ok) => {
      if (!ok) this.showToast('Save failed — the session file could not be written');
    });
  }

  /** Banner: take the disk's version — this window's unsaved changes go. */
  async reloadDiskSession(): Promise<void> {
    this.diskConflict_ = null;
    const file = this.session.file;
    let ok = false;
    if (file && this.docOpen) {
      try {
        const stamp = await file.stamp();
        const text = await file.readText();
        ok = this.applyDiskSession(text, stamp);
      } catch { /* unreadable — reported below */ }
    }
    if (!ok) this.showToast('Couldn’t reload the session from its file');
    this.notify();
  }

  /** Banner: dismissed for this occurrence — the next external change
   * (or a blocked save) surfaces it again. */
  dismissDiskConflict(): void {
    this.diskConflict_ = null;
    this.notify();
  }

  private async refreshRecents(): Promise<void> {
    this.recents = await getRecents();
    this.notify();
  }

  /** Remove one entry from the welcome screen's Recent list. */
  async removeRecent(entry: RecentEntry): Promise<void> {
    // Read-merge-write against the CURRENT store (see store.ts): another
    // window may have saved since this one last read the list.
    this.recents = await removeRecentMerged(entry);
    this.notify();
  }

  // Record (or refresh) a recent for the open PDF and its session, keyed on
  // their FileRefs (a handle or an on-disk path — so desktop path-only opens
  // list too). Defensive: a handle without isSameEntry (e2e fakes) no-ops.
  private async recordRecent(
    pdf: FileRef | null,
    session: FileRef | null,
    pdfName: string,
    sessionName: string,
  ): Promise<void> {
    if (!pdf) return;
    try {
      // Read-merge-write against the CURRENT store (see store.ts): merging
      // into this window's snapshot and saving that back blind erased the
      // entries other windows recorded since this one attached.
      this.recents = await recordRecentMerged({
        pdf,
        session,
        pdfName,
        sessionFileName: session ? sessionName : null,
        timestamp: Date.now(),
      });
      this.notify();
    } catch (e) {
      console.warn('recordRecent failed', e);
    }
  }

  // ---------- reading-progress session files ----------

  /**
   * The format the current session saves back as: new sessions write the
   * current version; a session loaded from a v1 file stays v1, with its
   * recorded time frozen (v2 records no time — see progressFormat.ts).
   */
  private sessionOrigin: { keepV1?: true; savedRaw?: string } = {};

  progressFileObject(): ProgressFile {
    return {
      type: 'pdf-stack-reader-progress',
      v: this.sessionOrigin.keepV1 ? 1 : PROGRESS_VERSION,
      ...(this.sessionOrigin.keepV1 ? { keepV1: true as const } : {}),
      savedAt: Date.now(),
      ...(this.sessionOrigin.savedRaw !== undefined
        ? { savedRaw: this.sessionOrigin.savedRaw } : {}),
      // Only the name: session files are fully transparent (no hidden
      // identifiers); PDFs are matched by name with a visible warning.
      pdf: { name: this.currentName },
      state: this.serializeState(),
    };
  }

  // Tail of the write queue (see writeProgress). Failures are swallowed
  // HERE only so the chain survives; each caller still sees its own result.
  private saveChain: Promise<unknown> = Promise.resolve();

  /**
   * Write the session to its bound target. Concurrent calls QUEUE behind
   * the in-flight write instead of being dropped (an explicit Save during
   * an auto-save was silently skipped, and the desktop path branch even
   * ran two whole-file writes at once) — each queued write serializes the
   * state as of ITS turn. Returns true only when this call's write ran
   * and succeeded; a failed write of either kind (an IPC false, a throwing
   * handle write) is a false, never a throw.
   */
  async writeProgress({ force = false } = {}): Promise<boolean> {
    const task = this.saveChain.then(() => this.writeProgressNow({ force }));
    this.saveChain = task.then(() => undefined, () => undefined);
    return task;
  }

  private async writeProgressNow({ force = false } = {}): Promise<boolean> {
    // Never serialize a viewer that holds no document: after a failed
    // open/replace `docOpen` still describes the torn-down document (and
    // during a slow open the old document is already gone), so
    // currentPosition() would fabricate {page:1, yRatio:0} — writing that
    // overwrites the real reading position on disk. Refusing keeps the
    // session dirty and honest; the next save with a real document writes.
    if (!this.docOpen || this.viewer.numPages === 0) return false;
    const file = this.session.file;
    if (!file) return false;
    this.session.saving = true;
    this.notify();
    try {
      // Snapshot the edit generation WITH the serialized text: an edit that
      // lands while the (async) write is in flight is NOT in these bytes, so
      // it must stay dirty — clearing unconditionally treated it as saved,
      // and a close could then silently discard it.
      const gen = this.dirtyGen;
      // Line-oriented plain-text format: small, clear git diffs.
      const text = serializeProgress(this.progressFileObject());
      // The disk copy moved on since this window last read or wrote it
      // (an external writer — see the live-sync watcher): overwriting
      // those bytes blind would destroy them. Refuse, keep the session
      // dirty, and surface the choice; the banner's Overwrite comes back
      // through here with force. Only a KNOWN baseline gates — a binding
      // that never stamped (test fakes) writes as before.
      if (!force && this.diskStamp) {
        const cur = await file.stamp();
        if (cur && !sameStamp(cur, this.diskStamp)) {
          let onDisk: string | null = null;
          try {
            onDisk = await file.readText();
          } catch { /* unreadable counts as different */ }
          if (onDisk !== this.diskText) {
            if (!this.diskConflict_) this.diskConflict_ = { fileName: file.name };
            return false; // stays dirty; the finally-notify shows the banner
          }
          this.diskStamp = cur; // same bytes, newer stamp — absorb it
        }
      }
      // ONE write path for both binding kinds (see boundFile.ts).
      const ok = await file.write(text);
      if (ok) {
        // Record what the disk now holds, so this write is never mistaken
        // for an external change (and a real one right after it is caught).
        this.diskText = text;
        this.diskStamp = (await file.stamp()) ?? this.diskStamp;
      }
      // Only a SUCCESSFUL write of the NEWEST state clears dirty. A failed
      // write leaves the change dirty so it's never silently lost; the next
      // auto-save / manual save / close-flush retries it. Likewise an edit
      // that arrived mid-write (generation moved on).
      if (ok && this.dirtyGen === gen) this.session.dirty = false;
      return ok;
    } finally {
      this.session.saving = false;
      this.notify();
    }
  }

  async saveProgress({ viaShellDialog = false } = {}): Promise<void> {
    if (!this.docOpen) return;
    this.commitSearch(); // explicit Save commits; auto-save (writeProgress) must NOT
    // ---- Acquisition: each branch only DECIDES the write target (`bound`)
    // and whether it already wrote the bytes, then converges on the one
    // block below — so no branch can silently skip the recent-record.
    let bound = this.session.file;
    let alreadyWritten = false;
    let savedViaQueue = false; // the queued writer manages `dirty` itself

    if (bound?.kind === 'path') {
      // Desktop: a session already bound to a path writes straight back, no
      // dialog — through the QUEUED writer, so it can never overlap an
      // in-flight auto-save (two concurrent whole-file IPC writes), and a
      // failed write says so instead of silently leaving the change unsaved.
      const ok = await this.writeProgress();
      if (!ok) {
        // A conflict-refused write already shows the banner (the user
        // picks overwrite/reload there) — a toast on top would just
        // repeat it with less to act on.
        if (!this.diskConflict_) this.showToast(`Couldn’t write to ${String(bound.ref)}`);
        return; // write failed — leave the session dirty
      }
      alreadyWritten = true;
      savedViaQueue = true;
    }
    if (bound?.kind === 'handle') {
      // User-initiated save: the right moment for a permission prompt if
      // one is needed (auto-save never prompts).
      if (!(await bound.requestWrite())) {
        this.showToast('Write permission denied \u2014 session not saved');
        return;
      }
    }
    if (!bound) {
      const suggestedName = this.currentName.replace(/\.pdf$/i, '') + PROGRESS_EXT;
      // The unsaved-close prompt's Save must not touch the file picker:
      // right after a canceled unload, showSaveFilePicker never settles
      // (it neither resolves nor rejects), so the save would silently
      // vanish. The shell dialog is the only picker that works there.
      if (viaShellDialog && window.ptDesktop?.saveSessionFallback) {
        const saved = await window.ptDesktop.saveSessionFallback(
          serializeProgress(this.progressFileObject()), suggestedName);
        if (!saved) return; // user canceled — no-op
        bound = fromShellDialog(saved); // the shell dialog binds a path, not a handle
        alreadyWritten = true;
      } else if (!window.showSaveFilePicker) {
        this.showToast('Saving progress files requires a Chromium-based browser');
        return;
      } else {
        let picked: FileSystemFileHandle | null = null;
        try {
          picked = await window.showSaveFilePicker({
            suggestedName,
            types: [{
              description: 'Reading progress',
              accept: { 'text/plain': [PROGRESS_EXT] },
            }],
          });
        } catch (e) {
          const err = e as Error;
          if (err?.name === 'AbortError') return; // user canceled the picker
          // Menu items carry no user activation, so the picker throws in the
          // desktop shell; fall back to the shell save (which binds a path).
          if (err?.name !== 'SecurityError' || !window.ptDesktop?.saveSessionFallback) throw e;
          const saved = await window.ptDesktop.saveSessionFallback(
            serializeProgress(this.progressFileObject()), suggestedName);
          if (!saved) return; // user canceled the shell dialog — no-op
          bound = fromShellDialog(saved);
          alreadyWritten = true;
        }
        if (picked) bound = fromPickerHandle(picked);
      }
    }

    // ---- Single convergence point: bind, write if not already, and record
    // the recent for EVERY first-save path (handle OR path). No acquisition
    // branch above may skip this — that was the missed-case bug.
    if (bound !== this.session.file) this.bindSessionFile(bound);
    else this.session.file = bound;
    if (!alreadyWritten) {
      // The queued writer clears dirty itself (generation-aware: an edit
      // arriving mid-write must stay dirty), so no blanket clear here.
      const ok = await this.writeProgress();
      if (!ok) {
        // A conflict-refused write already shows the banner — no toast,
        // no throw; the user resolves it there.
        if (this.diskConflict_) return;
        // A failed path write says which file couldn't be written; a failed
        // handle write THROWS so saveProgressSafe and the close flow surface
        // it as "Save failed: …" (the wording the close tests pin).
        if (bound?.kind === 'path') {
          this.showToast(`Couldn’t write to ${String(bound.ref)}`);
          return;
        }
        throw new Error('the session file write failed');
      }
    } else if (!savedViaQueue) {
      // The shell save dialog wrote the bytes itself (outside the queued
      // writer, which otherwise manages dirty).
      this.session.dirty = false;
    }
    if (this.freshSession) {
      this.freshSession = false;
      void this.recordRecent(
        this.currentPdfRef, bound?.ref ?? null,
        this.currentName, bound?.name ?? '');
    }
    this.showToast('Session saved');
    this.notify();
  }

  saveProgressSafe(opts?: { viaShellDialog?: boolean }): void {
    this.saveProgress(opts).catch((e) =>
      this.showToast('Save failed: ' + ((e as Error)?.message ?? String(e))));
  }

  // ---------- navigation ----------

  /**
   * A deliberate jump: record where we were, go to `pos`, push a history
   * entry — or, when forking (cmd/ctrl/middle-click), copy the whole
   * history into a new stack first.
   */
  jumpVia(pos: Pos, label: string, fork = false, { captureLeave = true } = {}): void {
    this.commitSearch(); // followed a link/outline/page-jump/mark: found it, moved on
    // Real jumps pin the position you left onto the entry you were on,
    // so Back returns exactly there. Marking is not a jump — you're
    // already at `pos` — and must not rewrite the previous anchor.
    if (captureLeave) this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.viewer.scrollTo(pos);
    if (fork) {
      this.hist.fork({ label, pos });
      this.showToast('Continued in a new trail');
    } else {
      this.hist.visit({ label, pos });
    }
  }

  /**
   * Forget a mid-flight pinch gesture. Called when a document swaps in
   * under it: the armed commit timer would otherwise fire after the swap
   * and commit the OLD gesture's scale onto the NEW document (dropping
   * its fit-width); the viewer clears the visual transform in close().
   */
  private resetPinch(): void {
    clearTimeout(this.pinchTimer);
    this.pinchTimer = 0;
    this.pinchStartScale = null;
    this.pinchFactor = 1;
    this.pinchAnchor = null;
  }

  private async handleLinkClick(info: LinkInfo): Promise<void> {
    const pos = await this.viewer.resolveDest(info.dest);
    if (!pos) {
      this.showToast('Could not resolve link destination');
      return;
    }
    const label = (await this.viewer.getLinkLabel(info.pageRec, info.linkEl)) ?? `p.${pos.page}`;
    this.jumpVia(pos, label, !!info.fork);
  }

  goBack(): void {
    if (!this.docOpen || !this.hist.canBack()) return;
    this.commitSearch();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.back();
    if (n) this.viewer.scrollTo(n.pos);
  }

  goForward(): void {
    if (!this.docOpen || !this.hist.canForward()) return;
    this.commitSearch();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.forward();
    if (n) this.viewer.scrollTo(n.pos);
  }

  histEntryClick(i: number): void {
    if (!this.docOpen) return; // read-only preview while a session waits for its PDF
    this.commitSearch();
    if (i === this.hist.active.index) {
      this.viewer.scrollTo(this.hist.current.pos);
      return;
    }
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.jumpTo(i);
    if (n) this.viewer.scrollTo(n.pos);
  }

  /** Switch to the previous/next trail in the list (keyboard: [ and ]). */
  stackCycle(delta: number): void {
    const ids = this.hist.stacks.map((s) => s.id);
    if (ids.length < 2) return;
    const i = ids.indexOf(this.hist.activeId);
    this.stackSwitch(ids[(i + delta + ids.length) % ids.length]);
  }

  stackSwitch(id: number): void {
    if (id === this.hist.activeId) return;
    this.commitSearch();
    if (!this.docOpen) {
      // preview mode: allow browsing trails, but never touch positions
      this.hist.switchStack(id);
      return;
    }
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    const n = this.hist.switchStack(id);
    if (n) this.viewer.scrollTo(n.pos);
  }

  stackClose(id: number): void {
    if (!this.docOpen) return;
    this.commitSearch();
    const wasActive = this.hist.closeStack(id);
    if (wasActive && this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  stackRename(id: number, name: string): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.renameStack(id, name);
    this.notify(); // restore the row even if the name was rejected
  }

  entryRename(i: number, label: string): void {
    if (!this.docOpen) return;
    this.commitSearch(); // naming an entry = deciding to keep it, i.e. moved on
    this.hist.renameEntry(i, label);
    this.notify();
  }

  /** Trails-panel +: start a fresh trail at the current position. */
  stackNew(): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.newStack(this.viewer.currentPosition());
    this.notify();
  }

  /** Duplicate a trail; the copy becomes the active one. */
  stackDuplicate(id: number): void {
    if (!this.docOpen) return;
    this.commitSearch();
    this.hist.duplicateStack(id);
    this.notify();
  }

  /** Keyboard entry point: duplicate the active trail (Alt+Shift+D). */
  stackDuplicateActive(): void {
    this.stackDuplicate(this.hist.activeId);
  }

  clearHistory(): void {
    if (!this.docOpen) return;
    this.commitSearch(); // history is being replaced — drop the dangling pointer
    this.hist.clearAll();
    this.hist.updateCurrentPos(this.viewer.currentPosition());
    this.notify();
  }


  /**
   * Undo the last history mutation (overwrite, fork, close, rename, clear)
   * — or, when the most recent action was a PDF replacement, undo that.
   */
  undoHist(): void {
    if (!this.docOpen) return;
    this.commitSearch(); // undo replaces the history snapshot the entry lives in
    if (this.lastReplaceAction === 'undoable' && this.replaceUndoSlot) {
      // Re-capture the LIVE state into the redo slot first: the one taken
      // at replace time is stale — restoring it would silently discard the
      // reading done since (back/forward, scrolling, zoom).
      if (this.currentSource) {
        this.replaceRedoSlot = { source: this.currentSource, state: this.serializeState() };
      }
      void this.applyReplaceSlot(this.replaceUndoSlot, 'redoable');
      return;
    }
    if (!this.hist.undo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  redoHist(): void {
    if (!this.docOpen) return;
    this.commitSearch();
    if (this.lastReplaceAction === 'redoable' && this.replaceRedoSlot) {
      // Mirror of undoHist: keep what the user did since the undo.
      if (this.currentSource) {
        this.replaceUndoSlot = { source: this.currentSource, state: this.serializeState() };
      }
      void this.applyReplaceSlot(this.replaceRedoSlot, 'undoable');
      return;
    }
    if (!this.hist.redo()) return;
    if (this.hist.current) this.viewer.scrollTo(this.hist.current.pos);
  }

  private async readSource(
    src: PdfSource,
  ): Promise<{ bytes: Uint8Array; name: string; handle: FileSystemFileHandle | null } | null> {
    try {
      if (typeof src === 'string') {
        const r = await fetch(src);
        if (!r.ok) return null;
        return {
          bytes: new Uint8Array(await r.arrayBuffer()),
          name: decodeURIComponent(src.split('/').pop() ?? 'document.pdf'),
          handle: null,
        };
      }
      if (src instanceof File) {
        return { bytes: new Uint8Array(await src.arrayBuffer()), name: src.name, handle: null };
      }
      const f = await src.getFile();
      return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, handle: src };
    } catch (e) {
      console.warn('readSource failed', e);
      return null;
    }
  }

  private async applyReplaceSlot(
    slot: ReplaceSlot,
    next: 'undoable' | 'redoable',
  ): Promise<void> {
    const got = await this.readSource(slot.source);
    if (!got) {
      this.showToast('Could not reopen the other PDF');
      this.lastReplaceAction = 'none';
      this.notify();
      return;
    }
    const progress: ProgressFile = { ...this.progressFileObject(), state: slot.state };
    const ok = await this.openData(got.bytes, got.name, {
      pdfRef: got.handle,
      source: slot.source,
      progress,
      sessionFile: this.session.file, // keep the session binding across the swap
    });
    if (!ok) {
      // openData already toasted the failure; without this gate the slot
      // bookkeeping below adopted a PDF that never opened and wrote the
      // session over a blank window.
      this.lastReplaceAction = 'none';
      this.notify();
      return;
    }
    this.adoptCurrentPdf();
    this.lastReplaceAction = next;
    this.showToast(next === 'redoable'
      ? `Replacement undone \u2014 back to ${got.name}`
      : `Replaced with ${got.name} again`);
    this.notify();
  }

  gotoPage(n: number): void {
    if (!Number.isFinite(n) || n < 1 || n > this.viewer.numPages) return;
    this.jumpVia({ page: n, yRatio: 0 }, `p. ${n}`);
  }

  zoomIn(): void { this.viewer.setScale(this.viewer.scale * 1.15); }
  zoomOut(): void { this.viewer.setScale(this.viewer.scale / 1.15); }
  fitWidth(): void { this.viewer.setScale(this.viewer.computeFitScale(), { fitWidth: true }); }

  // ---------- keyboard view scrolling ----------
  // The standard PDF-viewer navigation keys. All of these are plain
  // scrolls, exactly like the mouse wheel: no history entries, no anchor
  // changes — only the session's view position updates (via the normal
  // scroll tracking, hence suppressTracking: false on the page snaps).

  /** PageUp/PageDown/Space: one viewport, keeping a little overlap. */
  scrollByViewport(dir: 1 | -1): void {
    if (!this.docOpen) return;
    const c = this.viewer.container;
    c.scrollBy({ top: dir * Math.max(c.clientHeight - 48, 40) });
  }

  /** Arrow up/down: a small line step (mirrors native key scrolling). */
  scrollByLine(dir: 1 | -1): void {
    if (!this.docOpen) return;
    this.viewer.container.scrollBy({ top: dir * 40 });
  }

  /** Home/End: the start of the document, or its last page's bottom. */
  scrollToEdge(dir: -1 | 1): void {
    if (!this.docOpen || this.viewer.numPages === 0) return;
    const c = this.viewer.container;
    if (dir === -1) {
      c.scrollTop = 0;
      return;
    }
    // Not scrollHeight: the viewer keeps deliberate padding below the last
    // page, and End should end on content, not on the blank tail.
    const last = this.viewer.pages[this.viewer.numPages - 1].el;
    c.scrollTop = Math.max(0, last.offsetTop + last.offsetHeight - c.clientHeight);
  }

  /** Left/Right arrows: snap to the top of the previous/next page. */
  pageStep(dir: 1 | -1): void {
    if (!this.docOpen || this.viewer.numPages === 0) return;
    const cur = this.viewer.currentPosition();
    let target = cur.page + dir;
    if (target < 1) {
      // Stepping back from partway down the first page still does
      // something useful: back to its top.
      if (cur.yRatio <= 0) return;
      target = 1;
    }
    if (target > this.viewer.numPages) return;
    this.viewer.scrollTo({ page: target, yRatio: 0 }, { suppressTracking: false });
  }

  refitIfNeeded(): void {
    if (this.docOpen && this.viewer.fitWidth) this.fitWidth();
  }

  private onViewerScroll(): void {
    this.preview.hide(); // don't leave a stale popup while scrolling
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      // A scroll with no pages is teardown noise — viewer.open/close
      // emptying the container clamps scrollTop to 0 — never a reading-
      // position change. After a FAILED open `docOpen` still describes the
      // torn-down document, and marking dirty here armed the auto-save
      // that overwrote the session file with a fabricated page-1 position.
      if (!this.docOpen || this.viewer.numPages === 0
        || this.viewer.isTrackingSuppressed()) return;
      // Note: scrolling never moves history entries — their positions only
      // change through explicit actions (following a link, back/forward,
      // or the re-anchor button). Only the session's view position updates.
      this.markDirty();
      this.notify();
    }, 500);
  }

  // ---------- search ----------

  async runSearch(q: string, { jump = true } = {}): Promise<void> {
    await this.search.setQuery(q);
    if (this.search.query !== q) return; // superseded by a newer search
    this.notify();
    await this.search.refreshHighlights();
    if (jump && q && this.search.matches.length) await this.gotoMatch(1);
  }

  /**
   * Commit the current (uncommitted) search entry: freeze it in history
   * and drop the pointer, so the NEXT search adds a fresh entry instead of
   * moving this one. Called from an explicit, enumerated list of committing
   * actions (see the call sites) \u2014 deliberately NOT from find-next, the
   * search itself, scrolling, zooming, or AUTO-SAVE, which all leave the
   * entry uncommitted so repeated find-next keeps overwriting it.
   */
  commitSearch(): void {
    this.searchEntry = null;
  }

  async gotoMatch(dir: 1 | -1): Promise<void> {
    const m = this.search.step(dir);
    this.notify();
    if (!m) return;
    const yr = await this.search.matchYRatio(m);
    const pos: Pos = { page: m.page, yRatio: Math.max(0, yr - 0.05) };
    const label = `\u201c${this.search.query}\u201d`;
    // Uncommitted \u21d2 move the existing entry to this match; committed
    // (searchEntry null, after a committing action) \u21d2 push a fresh one.
    // The identity check is belt-and-suspenders: should some future
    // cursor-moving action ever forget its commitSearch() hook, this
    // falls to the else branch (a clean fresh entry) instead of writing
    // the label onto searchEntry while the position lands on a different
    // current entry.
    if (this.searchEntry && this.hist.current === this.searchEntry) {
      // Iterating matches: move the existing search entry along instead of
      // pushing one entry per match.
      this.searchEntry.label = label;
      this.hist.updateCurrentPos(pos);
      this.viewer.scrollTo(pos);
      this.notify();
    } else {
      this.hist.updateCurrentPos(this.viewer.currentPosition());
      this.viewer.scrollTo(pos);
      this.searchEntry = this.hist.visit({ label, pos });
    }
    await this.search.refreshHighlights();
  }

  // ---------- outline ----------

  private async buildOutline(): Promise<void> {
    this.outline = [];
    try {
      const raw = await this.viewer.doc?.getOutline();
      const map = (items: Array<{ title?: string; dest?: unknown; items?: unknown[] }>): OutlineNode[] =>
        (items ?? []).map((it) => ({
          title: it.title ?? '\u2014',
          dest: it.dest,
          children: map((it.items ?? []) as Array<{ title?: string; dest?: unknown; items?: unknown[] }>),
        }));
      this.outline = map((raw ?? []) as Array<{ title?: string; dest?: unknown; items?: unknown[] }>);
    } catch { /* no outline */ }
    this.notify();
  }

  async outlineJump(node: OutlineNode, fork = false): Promise<void> {
    if (!node.dest) return;
    const pos = await this.viewer.resolveDest(node.dest as string | unknown[]);
    if (pos) this.jumpVia(pos, node.title || `p.${pos.page}`, fork);
  }

  // ---------- opening documents ----------

  /**
   * Open PDF bytes into the viewer and (re)bind session state. Returns
   * true only when the document actually opened; false when the open was
   * superseded by a newer one or the bytes failed to parse (the failure
   * is toasted here, but callers with follow-up bookkeeping — adopting
   * the PDF, writing the session, arming undo slots — must gate on it:
   * the old document is already torn down by then, and pressing on once
   * overwrote the on-disk reading position with page 1).
   */
  async openData(
    data: Uint8Array,
    name: string,
    opts: {
      /** The PDF's recents-list identity (a handle or an on-disk path). */
      pdfRef?: FileRef | null;
      progress?: ProgressFile | null;
      /** The .ptl the session is bound to — the (auto-)save target. */
      sessionFile?: BoundFile | null;
      /** Re-readable reference to where the bytes came from (for undoable replace). */
      source?: PdfSource | null;
    } = {},
  ): Promise<boolean> {
    const {
      pdfRef = null, progress = null, sessionFile = null, source = null,
    } = opts;
    this.showToast(`Loading \u201c${name}\u201d\u2026`, 1500);
    // Kill any mid-flight pinch SYNCHRONOUSLY, before the first await: the
    // armed 180ms commit timer keeps counting through the open below, and
    // on a slow machine the parse outlasts it \u2014 the timer then commits the
    // OLD gesture's scale onto the half-open NEW document, dropping its
    // fit-width. (The old document is already gone either way: viewer.open
    // tears it down before parsing.)
    this.resetPinch();
    try {
      const doc = await this.viewer.open({ data });
      if (!doc) return false; // superseded by a newer open
      this.resetPinch(); // again: a wheel arriving DURING the parse must not leak either
      this.docOpen = true;
      this.currentName = name;
      this.currentSource = source ?? (pdfRef && isHandle(pdfRef) ? pdfRef : null);
      this.searchEntry = null;
      this.currentPage = 1;
      document.title = `${name} \u2014 Paper Trail`;

      this.preview.clear();
      this.sessionOrigin = progress?.keepV1
        ? { keepV1: true, ...(progress.savedRaw !== undefined ? { savedRaw: progress.savedRaw } : {}) }
        : {};
      this.restoring = true;
      try {
        this.search.reset();
        this.hist.reset();
        void this.buildOutline();
        if (progress?.state) {
          this.restoreStateFrom(progress.state);
        }
        // No automatic restore for a plain PDF: opening a PDF starts
        // fresh; state only comes from an explicit session file.
      } finally {
        this.restoring = false;
      }

      this.bindSessionFile(sessionFile);
      this.session.dirty = false;
      this.session.saving = false;
      clearTimeout(this.fileSaveTimer);
      this.mismatch_ = (progress && progress.pdf.name && progress.pdf.name !== name)
        ? { savedName: progress.pdf.name, openName: name }
        : null;
      this.currentPdfRef = pdfRef;
      this.freshSession = !sessionFile;
      void this.recordRecent(pdfRef, sessionFile?.ref ?? null, name, sessionFile?.name ?? '');
      this.currentPage = this.viewer.currentPosition().page;
      this.notify();
      return true;
    } catch (e) {
      console.error(e);
      this.showToast('Failed to open PDF: ' + ((e as Error)?.message ?? String(e)));
      return false;
    }
  }

  private isProgressName(name: string): boolean {
    return /\.ptl$/i.test(name || '');
  }

  async openFile(
    file: File,
    handle: FileSystemFileHandle | null = null,
    path: string | null = null,
  ): Promise<void> {
    if (!file) return;
    // THE acquisition funnel. The (handle, path) parameter pair is this
    // method's pinned public shape (App.tsx and the __pt test surface call
    // it positionally); a .ptl's pair becomes ONE binding right here — the
    // path preferred on the desktop, being the silent-write target — and
    // twin fields never travel further. A PDF's pair becomes its recents
    // ref (handle preferred, the historical recents key).
    if (this.isProgressName(file.name)) {
      await this.openProgressFile(file,
        path ? new PathFile(path, file.name) : handle ? new HandleFile(handle) : null);
      return;
    }
    const pdfRef: FileRef | null = handle ?? path;
    const buf = new Uint8Array(await file.arrayBuffer());
    const source: PdfSource = handle ?? file;
    if (this.pendingProgress) {
      // A session file was opened first; the user is now supplying its
      // PDF — restore that session (and bind its file for auto-save).
      const pp = this.pendingProgress;
      const pf = this.pendingProgressFile;
      const ok = await this.openData(buf, file.name, {
        pdfRef,
        source,
        progress: pp.json,
        sessionFile: pf,
      });
      // Consume the waiting session only once its PDF actually opened.
      // Consuming it up front meant a corrupt pick silently discarded the
      // session: the prompt vanished, and re-picking the right PDF opened
      // it fresh. On failure everything stays in place for another pick.
      if (ok) {
        this.pendingProgress = null;
        this.pendingProgressFile = null;
        this.notify();
      }
      return;
    }
    if (this.docOpen) {
      // A document is already open here: another PDF belongs in its own
      // window (desktop) or tab (web), never on top of this one.
      this.openPdfElsewhere(file);
      return;
    }
    await this.openData(buf, file.name, { pdfRef, source });
  }

  /** Open a PDF in a fresh window/tab because this one is occupied. */
  private openPdfElsewhere(file: File): void {
    const openInNewWindow = window.ptDesktop?.openInNewWindow;
    if (openInNewWindow) {
      void file.arrayBuffer().then((data) => {
        openInNewWindow(file.name, data);
      });
      return;
    }
    // Web: hand the picked File to a fresh tab of the app over a
    // same-origin handshake (Files are structured-cloneable).
    const child = window.open(location.origin + location.pathname);
    if (!child) {
      this.showToast('Popup blocked \u2014 allow popups to open PDFs in a new tab');
      return;
    }
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin === location.origin && ev.source === child && ev.data === 'pt-child-ready') {
        child.postMessage({ type: 'pt-open-file', file }, location.origin);
        window.removeEventListener('message', onMsg);
      }
    };
    window.addEventListener('message', onMsg);
  }

  /** Child-tab side of openPdfElsewhere: announce readiness, accept the file. */
  initTabHandoff(): void {
    if (!window.opener || window.ptDesktop) return;
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.origin !== location.origin) return;
      const d = ev.data as { type?: string; file?: File };
      if (d?.type === 'pt-open-file' && d.file instanceof File) {
        void this.openFile(d.file);
      }
    });
    (window.opener as Window).postMessage('pt-child-ready', location.origin);
  }

  /** Discard a session that is waiting for its PDF. */
  discardPendingSession(): void {
    this.pendingProgress = null;
    this.pendingProgressFile = null;
    this.hist.reset(); // clear the sidebar preview
    this.notify();
  }

  /**
   * Open a reading-session file. If a PDF is already open, the session is
   * applied to it (after confirmation, since it replaces the current
   * reading history). Otherwise the app shows a prompt asking for the
   * PDF: opening a session is deliberately two explicit steps — the app
   * never fetches a PDF on its own behind the user's back.
   */
  private async openProgressFile(
    file: File,
    sessionFile: BoundFile | null = null,
  ): Promise<void> {
    const text = await file.text();
    const json = parseProgress(text);
    if (!json) {
      const v = progressVersion(text);
      this.showToast(v !== null && v > PROGRESS_VERSION
        ? 'This session file was saved by a newer version of Paper Trail \u2014 update the app to open it'
        : 'Not a reading-session file');
      return;
    }

    if (this.docOpen) {
      // Loading a session into the currently open PDF.
      const trivial = this.hist.stacks.length === 1
        && this.hist.stacks[0].entries.length <= 1
        && !this.session.dirty;
      this.confirmSession = { json, file: sessionFile };
      if (trivial) {
        this.applyConfirmedSession();
      } else {
        this.notify(); // the UI shows a replace-confirmation dialog
      }
      return;
    }

    // Session first: show the preview and ask the user for the PDF.
    this.enterPendingState(json, sessionFile);
  }

  /**
   * Session-first waiting state: show the session's trails and history in
   * the sidebar right away (read-only preview — no document to navigate),
   * so the user sees the file has loaded.
   */
  private enterPendingState(
    json: ProgressFile,
    sessionFile: BoundFile | null,
  ): void {
    this.pendingProgress = { json };
    this.pendingProgressFile = sessionFile;
    this.hist.load(json.state.hist);
    // Set an explicit, non-bare title so the desktop shell reveals this
    // window right away. A document-opening window stays hidden until its
    // title leaves the app name (createWindow's showWhenLoaded reveal);
    // an OS-opened .ptl has no PDF to load and so never set a title,
    // leaving the window hidden until the 4s safety timer fired.
    document.title = `${json.pdf.name || 'Reading session'} — Paper Trail`;
    this.notify();
  }

  /** Apply a session to the currently open PDF (confirmed by the user). */
  applyConfirmedSession(): void {
    const cs = this.confirmSession;
    if (!cs || !this.docOpen) return;
    this.confirmSession = null;
    this.sessionOrigin = cs.json.keepV1
      ? { keepV1: true, ...(cs.json.savedRaw !== undefined ? { savedRaw: cs.json.savedRaw } : {}) }
      : {};
    this.restoring = true;
    try {
      this.searchEntry = null;
      this.restoreStateFrom(cs.json.state);
    } finally {
      this.restoring = false;
    }
    this.bindSessionFile(cs.file);
    this.session.dirty = false;
    this.session.saving = false;
    clearTimeout(this.fileSaveTimer);
    this.mismatch_ = (cs.json.pdf.name && cs.json.pdf.name !== this.currentName)
      ? { savedName: cs.json.pdf.name, openName: this.currentName }
      : null;
    this.freshSession = false;
    // ONE record point: the loaded session lists in Recent whether it bound a
    // handle OR a path. (The old `if (cs.progressHandle)` skipped every
    // path-only .ptl — an OS-open / <input> fallback onto an already-open PDF.)
    void this.recordRecent(
      this.currentPdfRef, this.session.file?.ref ?? null,
      this.currentName, this.session.file?.name ?? '');
    this.notify();
  }

  cancelSessionLoad(): void {
    this.confirmSession = null;
    this.notify();
  }

  /** Banner: hide the mismatch warning (until the next mismatching load). */
  dismissMismatch(): void {
    this.mismatch_ = null;
    this.notify();
  }

  /**
   * Banner: make the currently open PDF the session's PDF — its name is
   * written to the session file on the next (auto-)save.
   */
  adoptCurrentPdf(): void {
    this.mismatch_ = null;
    // progressFileObject() always serializes the currently open PDF's
    // identity, so marking the session dirty is enough to persist it.
    this.markDirty();
    if (this.session.file?.kind === 'handle') {
      this.writeProgress().catch((e) => console.warn('adopt save failed', e));
    }
    this.notify();
  }

  /**
   * Manually push the current reading position onto the trail, exactly as
   * if a link had been followed here ("mark this spot"). Cmd/Ctrl branches
   * into a new trail, like cmd+clicking a link.
   */
  markPosition(fork = false): void {
    if (!this.docOpen) return;
    const pos = this.viewer.currentPosition();
    this.jumpVia(pos, `Marked p.${pos.page}`, fork, { captureLeave: false });
  }

  /** Re-anchor a history entry to the current reading position. */
  entrySetPos(i: number): void {
    if (!this.docOpen) return;
    this.commitSearch(); // re-anchoring mutates the history the entry lives in
    this.hist.setEntryPos(i, this.viewer.currentPosition());
  }

  /** Remove one entry from the active trail (its × button). */
  entryRemove(i: number): void {
    if (!this.docOpen) return;
    // The × renders even on a single-entry history (visual consistency);
    // a trail always keeps at least one entry, so clicking it there is a
    // designed no-op — bail before any side effect (search commit, rerender).
    if (this.hist.active.entries.length <= 1) return;
    this.commitSearch(); // mutating the history the entry lives in
    this.hist.removeEntry(i);
    this.notify();
  }

  /** Re-anchor the CURRENT entry to the reading position (keyboard: r). */
  reanchorCurrent(): void {
    if (!this.docOpen) return;
    this.entrySetPos(this.hist.active.index);
  }

  /**
   * Replace the open PDF with another file while keeping the whole reading
   * state (all trails, cursor, zoom, session binding). Used e.g. when a
   * paper gets a revised version. The new PDF's identity is adopted into
   * the session, since the swap is deliberate.
   */
  async requestReplacePdf(): Promise<void> {
    if (!this.docOpen) {
      await this.pickFile();
      return;
    }
    if (!window.showOpenFilePicker) {
      this.replaceNext = true;
      this.pickViaInput();
      return;
    }
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'PDF documents', accept: { 'application/pdf': ['.pdf'] } }],
      });
      await this.replaceWithFile(await h.getFile(), h);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.warn(e);
    }
  }

  private replaceNext = false;

  async replaceWithFile(file: File, handle: FileSystemFileHandle | null = null): Promise<void> {
    if (!this.docOpen) {
      await this.openFile(file, handle);
      return;
    }
    this.commitSearch(); // replacing the document: the search is done
    const prevSlot: ReplaceSlot | null = this.currentSource
      ? { source: this.currentSource, state: this.serializeState() }
      : null;
    const progress = this.progressFileObject(); // carries the current state
    const sessionFile = this.session.file; // keep the session binding
    const buf = new Uint8Array(await file.arrayBuffer());
    const source: PdfSource = handle ?? file;
    const ok = await this.openData(buf, file.name, { pdfRef: handle, source, progress, sessionFile });
    if (!ok) {
      // The failed open already tore the old document down (viewer.open
      // closes it before parsing). Leave the on-disk session untouched —
      // no adopt, no dirty, no "replaced" toast — and arm undo so the
      // previous PDF is one step away.
      if (prevSlot) {
        this.replaceUndoSlot = prevSlot;
        this.replaceRedoSlot = null;
        this.lastReplaceAction = 'undoable';
        this.notify();
      }
      return;
    }
    // Deliberate swap: adopt the new PDF into the session, no banner.
    this.adoptCurrentPdf();
    if (prevSlot) {
      this.replaceUndoSlot = prevSlot;
      this.replaceRedoSlot = { source, state: this.serializeState() };
      this.lastReplaceAction = 'undoable';
      this.showToast(`PDF replaced \u2014 ${MOD}+Z to undo`);
      this.notify();
    }
  }

  /** Toolbar / menu entry point: pick a reading-session file. */
  async requestLoadSession(): Promise<void> {
    // Desktop: a NATIVE open dialog returns the file's real path, so the
    // session binds a silent-write target directly (auto-save arms, the
    // window closes with no prompt) — no dependency on resolving a File
    // System Access handle's path. The browser (no shell) keeps the
    // Chromium picker below and binds via the handle.
    if (window.ptDesktop?.openSessionDialog) {
      const picked = await window.ptDesktop.openSessionDialog();
      if (picked) {
        const file = new File([picked.text], picked.name, { type: 'text/plain' });
        // An empty path is treated as unbound — never write to a bad target.
        await this.openProgressFile(file, fromShellDialog(picked.path, picked.name));
      }
      return;
    }
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'Reading session',
            accept: { 'text/plain': [PROGRESS_EXT] },
          }],
        });
        if (handle) await this.openProgressFile(await handle.getFile(), fromPickerHandle(handle));
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        console.warn('showOpenFilePicker failed, falling back', e);
      }
    }
    this.pickViaInput();
  }

  /**
   * Pick a PDF. Sessions are loaded through the separate Load Session
   * action — deliberately two distinct pickers. (A .ptl chosen through
   * the "all files" escape hatch still routes correctly via openFile.)
   */
  async pickFile(): Promise<void> {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'PDF document',
            accept: { 'application/pdf': ['.pdf'] },
          }],
          excludeAcceptAllOption: false,
        });
        if (handle) {
          const file = await handle.getFile();
          await this.openFile(file, handle, this.desktopPathFor(file));
        }
        return;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return; // user cancelled
        console.warn('showOpenFilePicker failed, falling back', e);
      }
    }
    this.pickViaInput();
  }

  private pickViaInput(): void {
    if (!this.fileInput) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.pdf';
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (!f) return;
        if (this.replaceNext) {
          this.replaceNext = false;
          void this.replaceWithFile(f);
          return;
        }
        // Bind the desktop path just like pickFile/openDropped, so a .ptl
        // opened through the <input type=file> fallback auto-saves + closes
        // without a prompt (a PDF has no path and stays unbound, as before).
        void this.openFile(f, null, this.desktopPathFor(f));
      });
      this.fileInput = input;
    }
    this.fileInput.value = '';
    this.fileInput.click();
  }

  /**
   * Desktop only: the on-disk path for a File the renderer already holds
   * (a drop, a picker handle's getFile()). Binding it as session.path makes
   * auto-save arm and the close-flush write synchronously — the very same
   * silent target an OS-opened .ptl gets — no matter HOW the file was
   * opened. Null off the desktop shell, or when Electron can't resolve one.
   */
  private desktopPathFor(file: File): string | null {
    return window.ptDesktop?.getPathForFile?.(file) || null;
  }

  async openDropped(dt: DataTransfer): Promise<void> {
    const files = [...(dt.files ?? [])];
    if (!files.length) return;
    // With a document already open, dropping a PDF is a deliberate no-op
    // (open another window for another paper) — only a dropped session file
    // loads; with nothing open, the first dropped file opens.
    const f = this.docOpen ? files.find((x) => /\.ptl$/i.test(x.name)) : files[0];
    if (!f) return;
    // The handle must come from the DataTransfer item AT THE SAME INDEX as
    // the chosen file (the spec keeps kind==='file' items in dt.files order).
    // Taking items[0] blindly bound the WRONG file's handle when a PDF+.ptl
    // pair was dropped with the PDF first — a later save then wrote session
    // text over the PDF itself.
    let handle: FileSystemFileHandle | null = null;
    try {
      const fileItems = [...(dt.items ?? [])].filter((it) => it.kind === 'file');
      const item = fileItems[files.indexOf(f)];
      if (item?.getAsFileSystemHandle) {
        handle = (await item.getAsFileSystemHandle()) as FileSystemFileHandle | null;
      }
    } catch { /* handle stays null */ }
    // A dropped file carries its real path in the desktop shell, so a dropped
    // .ptl binds exactly like an OS-opened one (auto-save + silent close) —
    // whether or not a document is already open.
    void this.openFile(f, handle, this.desktopPathFor(f));
  }

  /**
   * A Recent row remembers a PDF and (when one was saved) its session
   * file, and reopens them as a pair — all or nothing. If either file is
   * gone or unreadable, NEITHER loads: no partial state, no picker, just
   * a clear message with everything left as it was.
   */
  async openRecent(entry: RecentEntry): Promise<void> {
    // Accept the union {pdf, session} shape plus the legacy shapes older
    // stored entries and the e2e harness use ({handle, progressHandle, name}
    // and the pre-union 4-field pdfHandle/pdfPath/...).
    const e = entry as unknown as {
      pdf?: FileRef; session?: FileRef | null;
      pdfHandle?: FileSystemFileHandle | null; pdfPath?: string | null;
      sessionFileHandle?: FileSystemFileHandle | null; sessionPath?: string | null;
      handle?: FileSystemFileHandle | null; progressHandle?: FileSystemFileHandle | null;
      pdfName?: string; name?: string;
    };
    const pdf: FileRef | null = e.pdf ?? e.pdfHandle ?? e.handle ?? e.pdfPath ?? null;
    const session: FileRef | null =
      e.session ?? e.sessionFileHandle ?? e.progressHandle ?? e.sessionPath ?? null;
    const pdfName = e.pdfName ?? e.name ?? 'the PDF';
    const fail = (what: string) =>
      this.showToast(`Couldn\u2019t reopen \u201c${pdfName}\u201d \u2014 ${what}.`, 6000);

    if (!pdf) { fail('the PDF is missing'); return; }

    // Rewrap the stored identities. A path ref can't be materialized
    // outside the desktop shell (no bridge to read it through) \u2014 the same
    // "missing" failure as an unreadable file, never a crash.
    let pdfFile: BoundFile;
    try {
      pdfFile = fromRecentRef(pdf);
    } catch {
      fail('the PDF is missing');
      return;
    }

    // Read BOTH files completely before touching any state.
    if (!(await pdfFile.requestRead())) {
      // Distinct from "missing": the browser reset the grant and the
      // re-request was declined \u2014 say so instead of blaming the file.
      fail('Paper Trail wasn\u2019t given permission to open it \u2014 try again');
      return;
    }
    let pdfBytes: Uint8Array;
    try {
      pdfBytes = new Uint8Array(await pdfFile.read());
    } catch (err) {
      console.warn('openRecent: PDF unreadable', err);
      fail('the PDF is missing');
      return;
    }
    let progress: ProgressFile | null = null;
    let sessionFile: BoundFile | null = null;
    if (session != null) {
      let sf: BoundFile;
      try {
        sf = fromRecentRef(session);
      } catch {
        fail('its saved session file is missing');
        return;
      }
      sessionFile = sf;
      if (!(await sf.requestRead())) {
        fail('Paper Trail wasn\u2019t given permission to open its session \u2014 try again');
        return;
      }
      let sessionText: string;
      try {
        sessionText = await sf.readText();
      } catch (err) {
        console.warn('openRecent: session unreadable', err);
        fail('its saved session file is missing');
        return;
      }
      progress = parseProgress(sessionText);
      if (!progress) {
        fail('its saved session file is unreadable');
        return;
      }
    }
    await this.openData(pdfBytes, pdfFile.name || pdfName, {
      pdfRef: pdf,
      source: isHandle(pdf) ? pdf : null,
      progress,
      sessionFile,
    });
  }

  private async bootFromQuery(): Promise<void> {
    const fileParam = new URLSearchParams(location.search).get('file');
    if (!fileParam) return;
    try {
      const r = await fetch(fileParam);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (this.isProgressName(fileParam)) {
        // Sessions never fetch their PDF automatically — the same two-step
        // flow as local files: preview the session, ask for the PDF.
        const json = parseProgress(await r.text());
        if (!json) throw new Error('not a progress file');
        this.enterPendingState(json, null);
        this.showToast(
          `Reading session loaded \u2014 open the PDF manually (${json.pdf.name}) to continue`,
          7000,
        );
      } else {
        const buf = new Uint8Array(await r.arrayBuffer());
        await this.openData(buf, decodeURIComponent(fileParam.split('/').pop()!), {
          source: fileParam,
        });
      }
    } catch (e) {
      this.showToast(`Could not load ${fileParam} (${(e as Error).message})`);
    }
  }
}

export const controller = new Controller();
