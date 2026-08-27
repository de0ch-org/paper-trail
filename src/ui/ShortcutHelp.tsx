// The keyboard cheat-sheet overlay, opened with ? (Shift+/) or from the
// Help menu in the desktop app.

import { IS_MAC, MOD } from '../core/platform';
import { IconClose } from './icons';

const ALT = IS_MAC ? '\u2325' : 'Alt';
const DESKTOP = typeof window !== 'undefined' && !!window.ptDesktop;

function Key({ k }: { k: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-md border border-borderapp bg-toolbar text-fgapp text-[11px] leading-none font-[inherit]">
      {k}
    </kbd>
  );
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-1.5 py-1">
      <span className="flex items-center gap-1">
        {keys.map((k, i) => <Key key={i} k={k} />)}
      </span>
      <span className="text-dim text-[12px] ml-2">{label}</span>
    </div>
  );
}

const GROUPS: Array<{ title: string; rows: Array<{ keys: string[]; label: string }> }> = [
  {
    title: 'Trail',
    rows: [
      { keys: [`${ALT}+←`, `${MOD}+[`], label: 'Back' },
      { keys: [`${ALT}+→`, `${MOD}+]`], label: 'Forward' },
      { keys: [`${MOD}+click`], label: 'Follow a link in a new trail' },
      { keys: [`${ALT}+[`, `${ALT}+]`], label: 'Previous / next trail' },
      { keys: [`${ALT}+⇧+D`], label: 'Duplicate the current trail' },
      { keys: [`${MOD}+D`], label: 'Mark the current position' },
      { keys: [`${MOD}+⇧+D`], label: 'Mark in a new trail' },
      { keys: [`${MOD}+G`], label: 'Re-anchor the current entry' },
      { keys: [`${MOD}+Z`], label: 'Undo history change' },
      { keys: [`${MOD}+⇧+Z`], label: 'Redo' },
    ],
  },
  {
    title: 'Pages',
    rows: [
      { keys: ['←', '→'], label: 'Previous / next page' },
      { keys: ['PgUp', 'PgDn'], label: 'Scroll a screen up / down' },
      { keys: ['Space', '⇧+Space'], label: 'Scroll a screen down / up' },
      { keys: ['↑', '↓'], label: 'Scroll a little' },
      { keys: ['Home', 'End'], label: 'Start / end of the document' },
    ],
  },
  {
    title: 'Find and view',
    rows: [
      { keys: [`${MOD}+F`], label: 'Search' },
      { keys: ['Enter', '⇧+Enter'], label: 'Next / previous match' },
      { keys: [`${MOD}+=`, `${MOD}+−`], label: 'Zoom in / out' },
      { keys: [`${MOD}+0`], label: 'Fit width' },
      { keys: [`${MOD}+B`], label: 'Toggle sidebar' },
      { keys: [`${MOD}+⇧+B`], label: 'Toggle outline / pages panel' },
    ],
  },
  {
    title: 'Files',
    rows: [
      { keys: [`${MOD}+S`], label: 'Save session' },
      { keys: [`${MOD}+O`], label: 'Open a PDF' },
      { keys: [`${MOD}+⇧+O`], label: 'Load a session file' },
      ...(DESKTOP ? [{ keys: [`${MOD}+N`], label: 'New window' }] : []),
    ],
  },
  {
    title: 'Help',
    rows: [
      { keys: ['?'], label: 'Show or hide this cheat-sheet' },
    ],
  },
];

export default function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      id="shortcutOverlay"
      className="absolute inset-0 z-50 bg-black/55 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-panel border border-borderapp rounded-xl shadow-2xl px-7 py-6 w-[600px] max-w-[92vw] max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center mb-3">
          <h2 className="text-fgapp font-semibold text-[15px]">Keyboard shortcuts</h2>
          <span className="flex-1" />
          <button
            className="inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer"
            title="Close"
            onClick={onClose}
          >
            <IconClose />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-10 gap-y-4">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-dim text-[11px] uppercase tracking-wider mb-1.5">{g.title}</h3>
              {g.rows.map((r) => <Row key={r.label} keys={r.keys} label={r.label} />)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
