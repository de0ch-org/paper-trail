// Standard PDF navigation keys: PageUp/PageDown (and Space/Shift+Space)
// scroll by a screenful, Home/End jump to the document's start/end, the
// up/down arrows scroll a small step, and the left/right arrows snap to
// the previous/next page. All of them are plain scrolls: they must never
// create history entries or move anchors, and inside a text field they
// must keep their native caret behavior instead of moving the document.
// Run: node build-node/test/keyboardPageNav.js   (server on 8377 first)

import { findBrowser } from './browsers';
import { chromium, type Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8377';

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

interface PtHist { active: { index: number; entries: unknown[] } }
interface PtViewer { numPages: number; currentPosition: () => { page: number; yRatio: number } }
type PtWindow = { __pt: { hist: PtHist; viewer: PtViewer; session: { dirty: boolean } } };

const scrollTop = (page: Page) => page.evaluate(
  () => document.getElementById('viewerContainer')!.scrollTop);
const curPage = (page: Page) => page.evaluate(
  () => (window as never as PtWindow).__pt.viewer.currentPosition().page);
const entryCount = (page: Page) => page.evaluate(
  () => (window as never as PtWindow).__pt.hist.active.entries.length);

async function run(): Promise<void> {
  const executablePath = findBrowser();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('dialog', (d) => void d.accept());
    await page.goto(BASE + '/?file=sample/WStarCats.pdf');
    await page.waitForSelector('#pageInput:not([disabled])', { timeout: 20_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const numPages = await page.evaluate(
      () => (window as never as PtWindow).__pt.viewer.numPages);
    check('setup: the sample has several pages', numPages >= 3, `numPages=${numPages}`);
    check('setup: the document starts at the top', await scrollTop(page) === 0,
      `scrollTop=${await scrollTop(page)}`);

    // A screenful down and back up.
    await page.keyboard.press('PageDown');
    const afterPgDn = await scrollTop(page);
    check('PageDown scrolls down by about a screen', afterPgDn > 400,
      `scrollTop=${afterPgDn}`);
    await page.keyboard.press('PageUp');
    check('PageUp scrolls back to the top', await scrollTop(page) === 0,
      `scrollTop=${await scrollTop(page)}`);

    // Space mirrors PageDown; Shift+Space mirrors PageUp.
    await page.keyboard.press('Space');
    check('Space scrolls down like PageDown', await scrollTop(page) === afterPgDn,
      `scrollTop=${await scrollTop(page)} expected=${afterPgDn}`);
    await page.keyboard.press('Shift+Space');
    check('Shift+Space scrolls back up', await scrollTop(page) === 0,
      `scrollTop=${await scrollTop(page)}`);

    // Small line steps with the arrows.
    await page.keyboard.press('ArrowDown');
    const afterDown = await scrollTop(page);
    check('ArrowDown scrolls a small step', afterDown > 0 && afterDown <= 80,
      `scrollTop=${afterDown}`);
    await page.keyboard.press('ArrowUp');
    check('ArrowUp scrolls back up', await scrollTop(page) === 0,
      `scrollTop=${await scrollTop(page)}`);

    // End lands on the last page's bottom (not the blank padding tail);
    // Home returns to the very start.
    await page.keyboard.press('End');
    const endOk = await page.evaluate(() => {
      const c = document.getElementById('viewerContainer')!;
      const pages = document.querySelectorAll<HTMLElement>('.page');
      const last = pages[pages.length - 1];
      const want = Math.max(0, last.offsetTop + last.offsetHeight - c.clientHeight);
      return Math.abs(c.scrollTop - want) < 2;
    });
    check('End lands at the bottom of the last page', endOk,
      `scrollTop=${await scrollTop(page)}`);
    check('End reports the last page as current', await curPage(page) === numPages,
      `page=${await curPage(page)}`);
    await page.keyboard.press('Home');
    check('Home returns to the start', await scrollTop(page) === 0,
      `scrollTop=${await scrollTop(page)}`);

    // Left/Right arrows snap page by page.
    await page.keyboard.press('ArrowRight');
    check('ArrowRight goes to page 2', await curPage(page) === 2,
      `page=${await curPage(page)}`);
    await page.keyboard.press('ArrowRight');
    check('a second ArrowRight goes to page 3', await curPage(page) === 3,
      `page=${await curPage(page)}`);
    await page.keyboard.press('ArrowLeft');
    check('ArrowLeft returns to page 2', await curPage(page) === 2,
      `page=${await curPage(page)}`);
    // From partway down a page, ArrowLeft first snaps to a page top.
    await page.evaluate(() => {
      document.getElementById('viewerContainer')!.scrollTop += 200;
    });
    await page.keyboard.press('ArrowLeft');
    check('ArrowLeft from partway down page 2 goes to page 1',
      await curPage(page) === 1, `page=${await curPage(page)}`);

    // None of that is trail navigation: still one entry, nothing anchored.
    check('navigation keys created no history entries',
      await entryCount(page) === 1, `entries=${await entryCount(page)}`);

    // Inside a text field the keys keep their native behavior and must
    // not move the document.
    await page.keyboard.press('End');
    const stBefore = await scrollTop(page);
    await page.click('#pageInput');
    for (const key of ['ArrowDown', 'ArrowUp', 'Space', 'PageDown', 'Home', 'End']) {
      await page.keyboard.press(key);
    }
    check('navigation keys in the page input do not move the document',
      await scrollTop(page) === stBefore,
      `before=${stBefore} after=${await scrollTop(page)}`);
    check('the page input kept focus through the keys',
      await page.evaluate(() => document.activeElement?.id === 'pageInput'));

    // Scrolling dirties the session; clear it so the harness sees no prompt.
    await page.evaluate(() => {
      (window as never as PtWindow).__pt.session.dirty = false;
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
