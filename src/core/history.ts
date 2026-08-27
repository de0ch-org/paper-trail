// Navigation history: a list of stacks.
//
// The active stack behaves like browser history: every deliberate jump
// (link click, outline click, page jump, search jump) pushes an entry and
// moves the cursor to it; pushing while the cursor is not at the top
// overwrites (truncates) the entries above it. Back/forward move the
// cursor without modifying the stack.
//
// Cmd/Ctrl+click (or middle-click) on a link *forks* instead: the active
// stack up to the cursor is copied into a new stack (so unlike a browser
// tab opened with cmd+click, "back" still works there), the jump is pushed
// onto the copy, and the new stack becomes active. The original stack is
// left untouched, preserved in the list of stacks.

import type { HistEntry, HistStack, Pos, SerializedStacks } from './types';

const UNDO_LIMIT = 50;

export class NavStacks {
  onChange: ((nav: NavStacks) => void) | null;
  /** Fires on structural mutations (anything that records an undo step). */
  onMutate: (() => void) | null = null;
  stacks: HistStack[] = [];
  activeId = 0;
  private nextId = 1;
  private nameCounter = 1;
  // Undo/redo of structural mutations (push/overwrite, fork, close, rename,
  // clear). Deliberately fragile, like everywhere else: in-memory only
  // (gone after save/reopen), and any new action clears the redo side.
  private undoStack: SerializedStacks[] = [];
  private redoStack: SerializedStacks[] = [];
  // Runtime-only listeners, fired whenever the structure changes shape
  // (any undoable mutation, undo/redo, load, reset). The UI uses this to
  // cancel in-flight row editors: history rows are addressed by index, so
  // a rename committed across a structural change could land on a
  // different entry than the one it was opened on. Nothing serialized.
  private structureListeners = new Set<() => void>();

  constructor(onChange: ((nav: NavStacks) => void) | null = null) {
    this.onChange = onChange;
    this.reset();
  }

  /**
   * Subscribe to shape changes of the entry/stack structure. Returns the
   * unsubscribe function. Cursor moves (back/forward/jump/switch) do NOT
   * fire — they re-point into the same structure.
   */
  onStructureChange(fn: () => void): () => void {
    this.structureListeners.add(fn);
    return () => { this.structureListeners.delete(fn); };
  }

  private emitStructureChange(): void {
    for (const fn of [...this.structureListeners]) fn();
  }

  /**
   * Fresh state for a newly opened document. Clears undo/redo.
   *
   * Deliberately NOT a structure-change event: reset() runs when a
   * document finishes opening, and a rename opened on the placeholder
   * rows during the load (the no-jank suite does exactly that) must
   * survive it — cancelling here made renameNoShift flaky on slow
   * runners. Every mutation the cancel-on-structure-change guard exists
   * for (mark, clear, remove, rename, re-anchor, undo/redo, session
   * load) flows through recordUndo() or load(), which do fire.
   */
  reset(rootLabel = 'Start'): void {
    this.undoStack = [];
    this.redoStack = [];
    this.init(rootLabel);
    this.emit();
  }

  /** "Clear history" as a user action: undoable. */
  clearAll(rootLabel = 'Start'): void {
    this.recordUndo();
    this.init(rootLabel);
    this.emit();
  }

  private init(rootLabel: string): void {
    this.nextId = 1;
    this.nameCounter = 1;
    this.stacks = [this.mkStack(null, [{ label: rootLabel, pos: { page: 1, yRatio: 0 } }], 0)];
    this.activeId = this.stacks[0].id;
  }

  private recordUndo(): void {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.onMutate?.();
    this.emitStructureChange();
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /**
   * Drop the undo/redo history without touching the structure. For the
   * session content being replaced from OUTSIDE (a live reload from
   * disk): the snapshots describe a structure that no longer exists,
   * and undo is in-memory-fragile by design — same as on reopen.
   */
  clearUndoRedo(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.serialize());
    this.load(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.serialize());
    this.load(next);
    return true;
  }

  private mkStack(name: string | null, entries: HistEntry[], index: number): HistStack {
    const finalName = name ?? `Untitled ${this.nameCounter}`;
    this.nameCounter++;
    return { id: this.nextId++, name: finalName, entries, index };
  }

  renameStack(id: number, name: string): void {
    const s = this.stacks.find((st) => st.id === id);
    if (!s || !name.trim() || s.name === name.trim()) return;
    this.recordUndo();
    s.name = name.trim();
    this.emit();
  }

  renameEntry(i: number, label: string): void {
    const e = this.active.entries[i];
    // Saving the same text is not an edit: the label stays automatic.
    if (!e || !label.trim() || e.label === label.trim()) return;
    this.recordUndo();
    e.label = label.trim();
    e.edited = true;
    this.emit();
  }

  /**
   * Re-anchor an entry of the active stack to a new position (undoable).
   * Automatic labels follow the new position; hand-renamed ones stay.
   */
  setEntryPos(i: number, pos: Pos): void {
    const e = this.active.entries[i];
    if (!e) return;
    this.recordUndo();
    e.pos = pos;
    if (!e.edited) e.label = `p. ${pos.page}`;
    this.emit();
  }

  get active(): HistStack {
    return this.stacks.find((s) => s.id === this.activeId) ?? this.stacks[0];
  }

  get current(): HistEntry {
    const s = this.active;
    return s.entries[s.index];
  }

  /** Keep the current entry's position in sync with where the user actually is. */
  updateCurrentPos(pos: Pos | null | undefined): void {
    if (pos && this.current) this.current.pos = pos;
  }

  /** A jump: overwrite the forward tail of the active stack, push, move cursor. */
  visit(entry: HistEntry): HistEntry {
    this.recordUndo();
    const s = this.active;
    s.entries = s.entries.slice(0, s.index + 1);
    s.entries.push(entry);
    s.index = s.entries.length - 1;
    this.emit();
    return this.current;
  }

  /**
   * A forking jump: copy the active stack up to the cursor into a new stack,
   * push the new entry there, and make it active.
   */
  fork(entry: HistEntry): HistEntry {
    this.recordUndo();
    const s = this.active;
    const copy = s.entries
      .slice(0, s.index + 1)
      .map((e) => ({ label: e.label, pos: { ...e.pos }, ...(e.edited ? { edited: true } : {}) }));
    copy.push(entry);
    const ns = this.mkStack(null, copy, copy.length - 1);
    this.stacks.push(ns);
    this.activeId = ns.id;
    this.emit();
    return this.current;
  }

  back(): HistEntry | null {
    const s = this.active;
    if (s.index === 0) return null;
    s.index--;
    this.emit();
    return this.current;
  }

  forward(): HistEntry | null {
    const s = this.active;
    if (s.index >= s.entries.length - 1) return null;
    s.index++;
    this.emit();
    return this.current;
  }

  /** Move the cursor within the active stack (clicking an entry in the panel). */
  jumpTo(i: number): HistEntry | null {
    const s = this.active;
    if (i < 0 || i >= s.entries.length) return null;
    s.index = i;
    this.emit();
    return this.current;
  }

  switchStack(id: number): HistEntry | null {
    const target = this.stacks.find((s) => s.id === id);
    if (!target) return null;
    this.activeId = id;
    this.emit();
    return this.current;
  }

  /**
   * Remove one entry from the active stack (undoable). A stack always
   * keeps at least one entry; the cursor follows the surviving entries.
   */
  removeEntry(i: number): boolean {
    const s = this.active;
    if (i < 0 || i >= s.entries.length || s.entries.length <= 1) return false;
    this.recordUndo();
    s.entries.splice(i, 1);
    if (s.index >= i) s.index = Math.max(0, s.index - 1);
    this.emit();
    return true;
  }

  /** Start a fresh trail at the given position; it becomes active (undoable). */
  newStack(pos: Pos): HistEntry {
    this.recordUndo();
    const ns = this.mkStack(null, [{ label: 'Start', pos: { ...pos } }], 0);
    this.stacks.push(ns);
    this.activeId = ns.id;
    this.emit();
    return this.current;
  }

  /** Duplicate a trail (entries + cursor); the copy becomes active (undoable). */
  duplicateStack(id: number): boolean {
    const s = this.stacks.find((st) => st.id === id);
    if (!s) return false;
    this.recordUndo();
    const copy = s.entries.map((e) => ({
      label: e.label,
      pos: { ...e.pos },
      ...(e.edited ? { edited: true } : {}),
    }));
    const ns = this.mkStack(`${s.name} copy`, copy, s.index);
    this.stacks.push(ns);
    this.activeId = ns.id;
    this.emit();
    return true;
  }

  /** Returns true when the closed stack was the active one. */
  closeStack(id: number): boolean {
    if (this.stacks.length <= 1) return false;
    const i = this.stacks.findIndex((s) => s.id === id);
    if (i === -1) return false;
    this.recordUndo();
    const wasActive = this.activeId === id;
    this.stacks.splice(i, 1);
    if (wasActive) this.activeId = this.stacks[Math.max(0, i - 1)].id;
    this.emit();
    return wasActive;
  }

  canBack(): boolean {
    return this.active.index > 0;
  }

  canForward(): boolean {
    const s = this.active;
    return s.index < s.entries.length - 1;
  }

  serialize(): SerializedStacks {
    return {
      v: 3,
      activeId: this.activeId,
      nameCounter: this.nameCounter,
      stacks: this.stacks.map((s) => ({
        id: s.id,
        name: s.name,
        index: s.index,
        entries: s.entries.map((e) => ({
          label: e.label,
          pos: e.pos,
          ...(e.edited ? { edited: true } : {}),
        })),
      })),
    };
  }

  load(data: unknown): boolean {
    try {
      const d = data as SerializedStacks;
      if (!d || d.v !== 3 || !Array.isArray(d.stacks) || !d.stacks.length) return false;
      this.stacks = d.stacks.map((s) => ({
        id: s.id,
        name: String(s.name),
        index: Math.min(Math.max(s.index | 0, 0), s.entries.length - 1),
        entries: s.entries.map((e) => ({
          label: String(e.label),
          pos: e.pos,
          ...(e.edited ? { edited: true } : {}),
        })),
      }));
      this.nextId = Math.max(...this.stacks.map((s) => s.id)) + 1;
      this.nameCounter = Math.max(d.nameCounter | 0, this.stacks.length + 1);
      this.activeId = this.stacks.some((s) => s.id === d.activeId)
        ? d.activeId
        : this.stacks[0].id;
      // load() replaces the whole structure — session loads, and undo/redo
      // (which restore through here) included.
      this.emitStructureChange();
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  private emit(): void {
    this.onChange?.(this);
  }
}
