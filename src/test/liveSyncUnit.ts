// Unit tests for the live-sync primitives on the bound-file abstraction:
// stamp() (the on-disk content identity) and watch() (the change signal).
// Pure logic with fake handles and a fake window.ptDesktop bridge — no
// browser, no Electron.
// Run: node --test build-node/test/liveSyncUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HandleFile, PathFile, sameStamp, type FileStamp } from '../core/boundFile';

// ---- helpers -------------------------------------------------------------

/** Poll until `cond` holds or `ms` elapsed; returns whether it held. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A controllable fake file handle: `state` drives what getFile() returns,
 * so a test changes the "disk" by assigning state.text / state.mtime.
 * `real: true` adds isSameEntry — the marker watch() requires (test fakes
 * without it mint a fresh lastModified per call and must not be watched).
 */
function fakeHandle(name: string, state: { text: string; mtime: number; gone?: boolean },
  { real = true } = {}): FileSystemFileHandle {
  const h: Record<string, unknown> = {
    name,
    kind: 'file',
    getFile: async () => {
      if (state.gone) throw new Error('gone (fake)');
      return new File([state.text], name, { type: 'text/plain', lastModified: state.mtime });
    },
  };
  if (real) h.isSameEntry = async () => false;
  return h as unknown as FileSystemFileHandle;
}

async function withWindow<T>(
  win: { ptDesktop?: unknown } | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  if (win === undefined) delete g.window; else g.window = win;
  try {
    return await fn();
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
}

// ---- sameStamp -----------------------------------------------------------

test('sameStamp: equal stamps match, any difference or one-sided null does not', () => {
  const a: FileStamp = { mtimeMs: 100, size: 5 };
  assert.equal(sameStamp(a, { mtimeMs: 100, size: 5 }), true);
  assert.equal(sameStamp(a, { mtimeMs: 101, size: 5 }), false);
  assert.equal(sameStamp(a, { mtimeMs: 100, size: 6 }), false);
  assert.equal(sameStamp(a, null), false);
  assert.equal(sameStamp(null, a), false);
  assert.equal(sameStamp(null, null), true);
});

// ---- HandleFile.stamp ----------------------------------------------------

test('HandleFile: stamp() reflects the file’s lastModified and size', async () => {
  const state = { text: 'hello', mtime: 12345 };
  const bf = new HandleFile(fakeHandle('a.ptl', state));
  assert.deepEqual(await bf.stamp(), { mtimeMs: 12345, size: 5 });
  state.text = 'hello world';
  state.mtime = 20000;
  assert.deepEqual(await bf.stamp(), { mtimeMs: 20000, size: 11 });
});

test('HandleFile: stamp() is null when the file cannot be read', async () => {
  const bf = new HandleFile(fakeHandle('a.ptl', { text: '', mtime: 1, gone: true }));
  assert.equal(await bf.stamp(), null);
});

// ---- HandleFile.watch ----------------------------------------------------

test('HandleFile: watch() fires when the stamp moves, and unwatch stops it', async () => {
  const state = { text: 'v1', mtime: 1000 };
  const bf = new HandleFile(fakeHandle('a.ptl', state));
  let fired = 0;
  const unwatch = bf.watch(() => { fired += 1; }, { intervalMs: 15 });
  await sleep(80); // baseline settles; an unchanged file must not fire
  assert.equal(fired, 0);
  state.text = 'v2';
  state.mtime = 2000;
  assert.equal(await until(() => fired >= 1), true, 'change was not signalled');
  await sleep(50); // let any in-flight poll tick land before counting
  const seen = fired;
  unwatch();
  state.text = 'v3';
  state.mtime = 3000;
  await sleep(100);
  assert.equal(fired, seen, 'unwatch did not stop the signals');
});

test('HandleFile: watch() ignores a transient gone-file, signals the next real change', async () => {
  const state: { text: string; mtime: number; gone?: boolean } = { text: 'v1', mtime: 1000 };
  const bf = new HandleFile(fakeHandle('a.ptl', state));
  let fired = 0;
  const unwatch = bf.watch(() => { fired += 1; }, { intervalMs: 15 });
  await sleep(60);
  state.gone = true; // mid-replace: stat fails
  await sleep(80);
  assert.equal(fired, 0, 'a missing file must not signal');
  state.gone = false; // same content back — still nothing to say
  await sleep(80);
  assert.equal(fired, 0, 'an unchanged reappearing file must not signal');
  state.text = 'v2';
  state.mtime = 2000;
  assert.equal(await until(() => fired >= 1), true, 'the real change was not signalled');
  unwatch();
});

test('HandleFile: watch() no-ops for a fake handle (no isSameEntry)', async () => {
  const state = { text: 'v1', mtime: 1000 };
  const bf = new HandleFile(fakeHandle('a.ptl', state, { real: false }));
  let fired = 0;
  const unwatch = bf.watch(() => { fired += 1; }, { intervalMs: 15 });
  state.text = 'v2';
  state.mtime = 2000;
  await sleep(100);
  assert.equal(fired, 0);
  unwatch(); // must exist and be callable even for the no-op case
});

// ---- PathFile ------------------------------------------------------------

test('PathFile: stamp() goes through the shell’s statFile; null when it is missing', async () => {
  const stats: Record<string, { mtimeMs: number; size: number } | null> = {
    '/tmp/a.ptl': { mtimeMs: 777, size: 42 },
  };
  const bridge = {
    platform: 'test',
    statFile: async (p: string) => stats[p] ?? null,
  };
  await withWindow({ ptDesktop: bridge }, async () => {
    const bf = new PathFile('/tmp/a.ptl');
    assert.deepEqual(await bf.stamp(), { mtimeMs: 777, size: 42 });
    assert.equal(await new PathFile('/tmp/other.ptl').stamp(), null);
  });
});

test('PathFile: stamp() is null on an older shell without statFile', async () => {
  await withWindow({ ptDesktop: { platform: 'test' } }, async () => {
    assert.equal(await new PathFile('/tmp/a.ptl').stamp(), null);
  });
});

test('PathFile: watch() subscribes through the shell and dispatches its pushes', async () => {
  const watched: string[] = [];
  const unwatched: string[] = [];
  let push: ((p: string) => void) | null = null;
  const bridge = {
    platform: 'test',
    watchFile: (p: string) => { watched.push(p); },
    unwatchFile: (p: string) => { unwatched.push(p); },
    onFileChanged: (cb: (p: string) => void) => { push = cb; },
  };
  await withWindow({ ptDesktop: bridge }, async () => {
    const bf = new PathFile('/tmp/w.ptl');
    let a = 0;
    let b = 0;
    const unA = bf.watch(() => { a += 1; });
    const unB = bf.watch(() => { b += 1; });
    assert.deepEqual(watched, ['/tmp/w.ptl'], 'the shell watches a path once');
    assert.notEqual(push, null);
    push!('/tmp/w.ptl');
    assert.deepEqual([a, b], [1, 1], 'a push reaches every subscriber');
    push!('/tmp/other.ptl');
    assert.deepEqual([a, b], [1, 1], 'a push for another path reaches nobody');
    unA();
    push!('/tmp/w.ptl');
    assert.deepEqual([a, b], [1, 2], 'an unsubscribed watcher stays quiet');
    assert.deepEqual(unwatched, [], 'the shell keeps watching while a subscriber holds');
    unB();
    assert.deepEqual(unwatched, ['/tmp/w.ptl'], 'the last unsubscribe releases the shell watch');
    push!('/tmp/w.ptl');
    assert.deepEqual([a, b], [1, 2]);
  });
});
