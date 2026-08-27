// Live session sync (browser / handle binding): an external write to the
// bound .ptl shows up in the window — the reading position follows the
// file — and when the window ALSO holds unsaved changes, a conflict
// banner offers overwrite / reload instead of silently picking a side.
//
// The "disk" is a fake FileSystemFileHandle whose backing state the test
// mutates; it carries isSameEntry (the real-handle marker), so the
// handle poller actually watches it.
//
// Run: node build-node/test/liveSyncWeb.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function run(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(window as any).__pt?.controller?.getSnapshot().docOpen,
      undefined, { timeout: 20_000 });
    // Every page div exists once the document opens; give first renders a beat.
    await page.waitForTimeout(1000);

    // ---- setup: capture session texts for three positions, bind the fake --
    const setup = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      if (c.getSnapshot().numPages < 4) return { ok: false, why: 'sample has <4 pages' };

      // Serialized session text as of a given position (scrollTo suppresses
      // tracking, so none of this marks the session dirty).
      const textAt = (page: number) => {
        pt.viewer.scrollTo({ page, yRatio: 0 });
        return pt.progressText() as string;
      };
      const disk = {
        p2: textAt(2),
        p3: textAt(3),
        p4: textAt(4),
        state: { text: '', mtime: 1_000_000 },
        writes: [] as string[],
      };
      disk.state.text = textAt(1);
      (window as any).__lsDisk = disk;

      // The fake "file on disk": isSameEntry marks it watchable; the
      // readwrite permission starts at 'prompt' so the auto-save timer
      // skips (a browser must never prompt from a timer) and dirty state
      // survives long enough to conflict.
      const perm = { read: 'granted', readwrite: 'prompt' };
      const handle = {
        kind: 'file', name: 'live.ptl',
        isSameEntry: async () => false,
        queryPermission: async (d: any) => (perm as any)[(d && d.mode) || 'read'],
        requestPermission: async (d: any) => {
          (perm as any)[(d && d.mode) || 'read'] = 'granted';
          return 'granted';
        },
        getFile: async () => new File([disk.state.text], 'live.ptl',
          { type: 'text/plain', lastModified: disk.state.mtime }),
        createWritable: async () => ({
          write: async (t: string) => {
            disk.writes.push(t);
            disk.state.text = t;
            disk.state.mtime += 1000;
          },
          close: async () => { /* sink */ },
        }),
      };

      // Fresh document + clean history ⇒ the session applies with no
      // confirm dialog and binds the handle (which arms the watcher).
      await c.openFile(new File([disk.state.text], 'live.ptl'), handle);
      await sleep(300); // the binding's baseline read settles
      const snap = c.getSnapshot();
      return {
        ok: snap.saveBound && !snap.diskConflict,
        why: JSON.stringify({ bound: snap.saveBound, conflict: !!snap.diskConflict }),
        page: pt.viewer.currentPosition().page,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('session bound to the watchable fake handle', setup.ok === true,
      setup.why ?? '');
    check('binding restored the file’s position (page 1)', setup.page === 1,
      `page=${setup.page}`);

    // ---- A: clean window — an external change moves the viewport --------
    const reload = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const disk = (window as any).__lsDisk;
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return cond();
      };
      disk.state.text = disk.p3;
      disk.state.mtime += 5000;
      const moved = await until(() => pt.viewer.currentPosition().page === 3, 6000);
      return {
        moved,
        page: pt.viewer.currentPosition().page,
        dirty: c.session.dirty,
        conflict: !!c.getSnapshot().diskConflict,
        banner: !!document.getElementById('conflictBanner'),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('external change updates the viewport (live location)',
      reload.moved && reload.page === 3, `page=${reload.page}`);
    check('a clean window reloads with no conflict banner',
      !reload.conflict && !reload.banner && !reload.dirty,
      JSON.stringify(reload));

    // ---- B: dirty window + external change ⇒ conflict banner ------------
    const conflict = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const disk = (window as any).__lsDisk;
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return cond();
      };
      pt.jumpVia({ page: 2, yRatio: 0 }, 'local edit'); // dirty (autosave can't write silently)
      disk.state.text = disk.p4;
      disk.state.mtime += 5000;
      const bannerUp = await until(() => !!document.getElementById('conflictBanner'), 6000);
      const stayedPut = pt.viewer.currentPosition().page === 2;
      const dirty = c.session.dirty;
      const diskUntouched = disk.state.text === disk.p4;

      // Dismiss is per-occurrence: the banner goes, but a blocked save
      // brings it back (the write gate refuses to overwrite newer bytes).
      (document.getElementById('btnConflictDismiss') as HTMLElement | null)?.click();
      const bannerGone = await until(() => !document.getElementById('conflictBanner'), 3000);
      const wrote = await c.writeProgress();
      const bannerBack = await until(() => !!document.getElementById('conflictBanner'), 3000);
      return {
        bannerUp, stayedPut, dirty, diskUntouched, bannerGone,
        gateRefused: wrote === false,
        bannerBack,
        stillDirty: c.session.dirty,
        diskStill: disk.state.text === disk.p4,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('external change on a dirty window raises the conflict banner',
      conflict.bannerUp === true, '');
    check('the dirty window keeps its own position and stays dirty',
      conflict.stayedPut && conflict.dirty, JSON.stringify(conflict));
    check('dismiss hides the banner for this occurrence',
      conflict.bannerGone === true, '');
    check('a save against newer disk bytes is refused and re-raises the banner',
      conflict.gateRefused && conflict.bannerBack && conflict.stillDirty && conflict.diskStill,
      JSON.stringify(conflict));

    // ---- C: Reload takes the disk’s version -----------------------------
    const reloaded = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return cond();
      };
      (document.getElementById('btnConflictReload') as HTMLElement | null)?.click();
      const applied = await until(() => pt.viewer.currentPosition().page === 4
        && !c.session.dirty, 5000);
      return {
        applied,
        page: pt.viewer.currentPosition().page,
        banner: !!document.getElementById('conflictBanner'),
        canUndo: pt.hist.canUndo(),
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('Reload adopts the disk version (viewport + clean state)',
      reloaded.applied && !reloaded.banner, JSON.stringify(reloaded));
    check('a reload from disk clears the undo history (fragile-undo policy)',
      reloaded.canUndo === false, `canUndo=${reloaded.canUndo}`);

    // ---- D: Overwrite keeps this window’s version -----------------------
    const overwrote = await page.evaluate(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const pt = (window as any).__pt;
      const c = pt.controller;
      const disk = (window as any).__lsDisk;
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (cond()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return cond();
      };
      pt.jumpVia({ page: 2, yRatio: 0 }, 'mine again'); // dirty
      disk.state.text = disk.p2 + '\n'; // external bytes, different again
      disk.state.mtime += 5000;
      const bannerUp = await until(() => !!document.getElementById('conflictBanner'), 6000);
      const before = disk.writes.length;
      (document.getElementById('btnConflictOverwrite') as HTMLElement | null)?.click();
      const done = await until(() => !c.session.dirty
        && !document.getElementById('conflictBanner'), 5000);
      const written = disk.writes.length > before ? disk.writes[disk.writes.length - 1] : null;
      const parsed = written ? pt.parseProgressText(written) : null;
      // Quiet teardown for the harness.
      c.session.handle = null;
      c.session.dirty = false;
      return {
        bannerUp, done,
        wrotePage: parsed?.state?.pos?.page ?? null,
        diskIsOurs: disk.state.text === written,
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
    check('Overwrite writes this window’s session over the disk copy',
      overwrote.bannerUp && overwrote.done && overwrote.diskIsOurs,
      JSON.stringify(overwrote));
    check('the overwritten file carries this window’s position (page 2)',
      overwrote.wrotePage === 2, `page=${overwrote.wrotePage}`);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
