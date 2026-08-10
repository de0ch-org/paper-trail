// Desktop live session sync, against a REAL file on disk: an external
// write to the bound .ptl (a script, another program) moves this
// window's reading position within moments; an external write landing
// while the window holds unsaved changes raises the conflict banner and
// the auto-save refuses to clobber the file until the user picks a side
// (Overwrite writes this window's version).
//
// Run: npx electron build-node/test/desktopLiveSync.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-ls-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app, BrowserWindow } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

const pdfB64 = fs
  .readFileSync(path.resolve(__dirname, '..', '..', 'sample', 'WStarCats.pdf'))
  .toString('base64');
const ptlPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ls-file-')), 'live.ptl');

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

// A wedged run must fail loudly, not hang the CI job.
setTimeout(() => { console.error('FAIL  timeout — test wedged'); app.exit(1); }, 150_000);

const exec = <T>(js: string): Promise<T> =>
  BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(js) as Promise<T>;

// Poll INSIDE the page for a condition, from the main test process.
const pageUntil = (cond: string, ms: number): Promise<boolean> =>
  exec<boolean>(`(async () => {
    const t0 = Date.now();
    const pt = window.__pt;
    while (Date.now() - t0 < ${ms}) {
      if (${cond}) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return ${cond};
  })()`);

void app.whenReady().then(() => {
  setTimeout(() => {
    void (async () => {
      // ---- open the PDF, bind a real on-disk session file ----------------
      const t0 = await exec<string>(`(async () => {
        const pt = window.__pt;
        const bytes = Uint8Array.from(atob('${pdfB64}'), (c) => c.charCodeAt(0));
        await pt.controller.openFile(new File([bytes], 'WStarCats.pdf'));
        await new Promise((r) => setTimeout(r, 1500));
        return pt.progressText();
      })()`);
      fs.writeFileSync(ptlPath, t0, 'utf8');

      const bound = await exec<{ bound: boolean; path: string | null }>(`(async () => {
        const pt = window.__pt;
        const text = ${JSON.stringify(t0)};
        await pt.controller.openFile(
          new File([text], 'live.ptl'), null, ${JSON.stringify(ptlPath)});
        await new Promise((r) => setTimeout(r, 800));
        return { bound: pt.controller.getSnapshot().saveBound, path: pt.session.path };
      })()`);
      check('the session bound its on-disk path', bound.bound && bound.path === ptlPath,
        JSON.stringify(bound));

      // ---- A: external write moves the viewport --------------------------
      const t2 = await exec<string>(`(() => {
        const pt = window.__pt;
        pt.viewer.scrollTo({ page: 2, yRatio: 0 });
        const text = pt.progressText();
        pt.viewer.scrollTo({ page: 1, yRatio: 0 });
        return text;
      })()`);
      fs.writeFileSync(ptlPath, t2, 'utf8');
      const moved = await pageUntil(
        'pt.viewer.currentPosition().page === 2 && !pt.session.dirty', 8000);
      const cleanNoBanner = await exec<boolean>(
        '!document.getElementById(\'conflictBanner\')');
      check('an external write moves the reading position (live location)', moved, '');
      check('a clean window reloads silently — no conflict banner', cleanNoBanner, '');

      // ---- B: external write onto unsaved changes ⇒ conflict -------------
      await exec<void>('window.__pt.jumpVia({ page: 3, yRatio: 0 }, \'local edit\')');
      fs.writeFileSync(ptlPath, t0, 'utf8'); // external, before the 1.5s auto-save
      const bannerUp = await pageUntil(
        '!!document.getElementById(\'conflictBanner\') && pt.session.dirty', 8000);
      check('external write while dirty raises the conflict banner', bannerUp, '');
      // Wait past the auto-save debounce: the gate must refuse to clobber.
      await new Promise((r) => setTimeout(r, 2500));
      const diskKept = fs.readFileSync(ptlPath, 'utf8');
      check('auto-save refuses to overwrite the externally changed file',
        diskKept === t0, 'file was clobbered');

      // ---- C: Overwrite writes this window's version ---------------------
      await exec<void>('document.getElementById(\'btnConflictOverwrite\').click()');
      const resolved = await pageUntil(
        '!pt.session.dirty && !document.getElementById(\'conflictBanner\')', 8000);
      const fileNow = fs.readFileSync(ptlPath, 'utf8');
      const wrotePage = await exec<number | null>(`(() => {
        const parsed = window.__pt.parseProgressText(${JSON.stringify(fileNow)});
        return parsed && parsed.state && parsed.state.pos ? parsed.state.pos.page : null;
      })()`);
      check('Overwrite resolves the conflict (clean, banner gone)', resolved, '');
      check('the file now carries this window’s position (page 3)', wrotePage === 3,
        `page=${String(wrotePage)}`);

      await exec<void>('window.__pt.session.dirty = false');
      finish();
    })().catch((e: unknown) => {
      console.error('FAIL  desktop live-sync test errored', e);
      app.exit(1);
    });
  }, 14_000);
});
