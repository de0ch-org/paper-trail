# Changelog

User-facing changes per release. The release workflow copies the
matching section into the GitHub Release notes.

## 1.2.0

- The standard PDF navigation keys now work. Page Up and Page Down (and
  Space / Shift+Space) scroll by a screenful, Home and End jump to the
  start and end of the document, the up and down arrows scroll in small
  steps, and the left and right arrows go to the previous or next page.
- Like all scrolling, the navigation keys never move the entries on your
  trail — only your reading position. Inside a text field, such as the
  page number box or the search box, the keys keep their normal
  text-editing behavior.
- The keyboard cheat-sheet (press ?) lists the new keys in a Pages
  section.

## 1.1.2

- New command-line helper `ptopen` (macOS), attached to this release as
  a download: `ptopen session.ptl` opens the session in Paper Trail
  together with the PDF it names, looked up next to the session file —
  or pass both files yourself, in either order. Install it anywhere on
  your PATH and make it executable.
- `ptopen` targets the installed Paper Trail app precisely (by path or
  bundle id), so identically named apps — development builds, or
  Windows apps shared into macOS by a virtual machine — can no longer
  intercept the files.

## 1.1.1

- Scanned PDFs now render. Pages compressed with CCITT fax — what most
  scanners produce — previously showed as blank, because the app did
  not ship the pdf.js image decoders; the same was true of JBIG2 and
  JPEG 2000 images. The decoders are now bundled and load fully
  offline.
- Reading a long scanned document no longer accumulates memory: pages
  scrolled out of view release their decoded image data (previously up
  to ~35MB per page was kept for the whole session).
- Session files saved by every previous version are now covered by a
  permanent compatibility test suite, down to the very first release's
  format.

## 1.1.0

- Scrolling is much smoother: pages coming into view appear instantly
  as a quick preview and sharpen moment later, instead of the app
  pausing to draw them at full quality mid-scroll. During a fast fling
  the viewer never stutters, and pages you have already read glide by
  without being redrawn. Zooming out gets the same treatment for the
  pages it reveals.
- Session files no longer record a save time. The timestamp changed on
  every save, which made otherwise-identical files look different to
  git; files now only change when your reading actually changes.
  Existing session files keep working exactly as before — and if an
  older file has a recorded time, saving never alters it.

## 1.0.0

Paper Trail 1.0. From this release on, session files are stable: every
future version of Paper Trail opens sessions saved by this one.

- Search now runs off the main thread and shows matches while it is
  still indexing — typing in the find bar stays instant even on large
  papers, and the match count fills in live.
- Saving at the close prompt is reliable: choosing Save… always shows
  the location picker and writes the full session before the window
  closes. (Previously the app could quit first, losing the session —
  on Windows it could even leave a zero-byte file.)
- Your saved reading position can no longer be corrupted by a failed
  PDF replacement or by an auto-save racing a document that is still
  opening.
- Dropping a PDF and a session file together now always binds the
  session file as the save target, whatever order they arrive in.
  (Previously a save could overwrite the PDF itself.)
- Edits made while a save is already writing are no longer lost.
- The Recent list merges correctly across windows — opening files in
  one window no longer erases another window's entries.
- Opening two files quickly gives each its own window; a file opened
  from a terminal with a relative path resolves correctly; opening a
  file into an existing window brings it to the front; and a window
  remembered on an unplugged monitor comes back on screen.
- Renaming is watertight: the rename box always gets the full row,
  hover tools keep their spacing without covering anything clickable,
  a rename can never land on a different entry, and Alt+Arrow keys
  stay in the text box you are typing in.
- A consistent visual pass: panel headers, list rows, the outline
  tree, the Recent list, and the find bar all share the same edges and
  type sizes.
- Zooming with a pinch no longer carries the gesture onto a newly
  opened document, very large pages render correctly at high zoom, and
  thumbnails refresh when a PDF is replaced by a same-named file.
- Windows: the Installed-apps list shows the real app icon, and the
  installer offers checkboxes for the desktop and Start Menu shortcuts
  (both on by default).
- Windows: the uninstaller now carries the app's own icon instead of a
  generic one, so it is recognisable in every Explorer view.
- macOS: the installer window has a new look — the app and the
  Applications folder sit side by side with a drag hint between them,
  centered in the window and crisp on Retina displays.
- Row buttons behave: the edit and duplicate tools appear only while
  the pointer is over a row, evenly spaced, and the label text makes
  room for them instead of being covered; the close button keeps its
  place on the current trail and entry at all times.
- The README demo video is freshly recorded from this version.

## 0.5.21

- Saving a reading session into your Documents folder no longer makes
  macOS ask for permission to access the folder. The system-managed
  "Open Recent" menu was removed as part of this; the Recent list on
  the welcome screen is the place to reopen your reading.
- The Recent list now remembers files however they were opened — a
  double-click from the Finder or Explorer, a drag onto the window, or
  the file picker all count — and saving a session for the first time
  updates its PDF's entry instead of adding a duplicate.
- Clicking Fit (or making a large zoom jump) no longer leaves a stray
  ghost of a page floating at the wrong place.
- Zooming with the buttons or keyboard keeps the page centered instead
  of pinning it to the left edge.
- Renaming a trail or history entry now gives the text box the full
  row; the row's action icons no longer sit on top of it.
- On Windows, the find bar no longer overlaps the window's
  minimize/maximize/close buttons.
- The app icon now sits on Apple's standard icon grid, so it no longer
  looks oversized next to other apps in the Dock.

## 0.5.20

- Opening a reading session now works the same however you open it —
  dragging a session onto an already-open PDF, the file picker, Recent,
  or a double-click all bind it identically, so it auto-saves and closes
  without asking where to save.
- Closing a window with unsaved changes saves quietly in the background
  and only prompts if the save actually fails; this now applies to
  sessions opened from Recent too.
- Your unsaved reading sessions are now protected when you shut down or
  log out — the app holds the shutdown and lets you save first.
- Recent now remembers each PDF together with its reading session,
  most-recently-used first.
- Right-clicking selected text and choosing "Search for this" now fills
  the find box.
- Refreshed the interface: crisper icons, and controls and list rows
  that line up on a consistent grid.
- New Windows document and installer icons.
- Updates now install quietly in the background and apply the next time
  you quit; there is no separate update window.

## 0.5.18

- Opening a reading session now behaves the same however you open it.
  Before, dragging a session file onto the window or using "Load
  session…" could leave Paper Trail unsure where to save — so it didn't
  auto-save, and asked "Do you want to save?" when you closed. Now every
  way of opening binds the session, so it auto-saves and closes without
  nagging. (In the browser, closing with unsaved changes still shows the
  browser's own warning — that can't be avoided on the web.)
- The Windows installer and the "Installed apps" entry now show a Paper
  Trail package icon instead of a generic one.

## 0.5.15

- In the macOS update window, Cancel (and closing the window) now simply
  dismisses it and lets the download keep running in the background,
  instead of stopping it — updates download automatically, so there's
  nothing to abort; the next check goes straight to "Restart to Update"
  once it's ready.
- On Windows, reopening Paper Trail while an update is installing no
  longer flashes an empty, broken-looking window: it quietly keeps the
  current version running and applies the update the next time you quit.
- Closing a window whose reading session auto-saves no longer asks
  whether to save — it closes right away and writes your changes in the
  background. If a save ever fails, the window returns with the normal
  save prompt so nothing is lost.
- Double-clicking a reading session (.ptl) now shows its window
  immediately instead of after a brief delay.
- When searching, pressing Enter to step through matches keeps a single
  entry in your history; the next search, after you do something else,
  starts a fresh one.
- The rename box no longer shifts the text sideways when you start
  editing.

## 0.5.13

- The macOS "Check for Updates…" flow is now a proper update window,
  like the ones many Mac apps use: it announces the new version and
  lets you Update Now or Later, shows a progress bar while it downloads
  — which you can Cancel to stop the download — and offers Restart to
  Update once it's ready.
- Documents no longer wear the app's icon: on macOS they get the
  system-composed document icon, and on Windows a proper page icon with
  the Paper Trail logo and file-type label.
- A new app icon — the trail on a dark squircle — identical on macOS,
  Windows, and the web.
- The installer and uninstaller use the standard installer icons
  instead of hand-drawn ones.
- Scrollbars are the operating system's own dark scrollbars again; on
  Windows the rail and arrow buttons are back.
- Windows opened for a document never flash empty first.
- The reference hover preview opens reliably even while the page is
  still re-rendering.
- Opening a reading session (.ptl) and then its PDF now keeps the
  session bound to that file, so auto-save works and Save no longer
  asks where to put it.
- The README gained the new logo plus build and coverage badges.

## 0.5.12 (skipped)

Never released: the tagged build's release workflow startup-failed. The
owner-keyed CI matrix used a `fromJSON` expression that is valid on a
normal push but not when the release calls the CI as a reusable workflow
(workflow_call). Version numbers are not reused, so these changes shipped
as 0.5.13, with the matrix rewritten to a static matrix plus an
owner-keyed `runs-on`.

## 0.5.11

- The Windows installer is no longer pixelated on HiDPI screens.
- Right-clicking the Paper Trail taskbar icon on Windows now really
  shows the "New Window" entry.
- Scrollbars blend into the dark theme instead of standing out as
  light rails.
- The side panels share one tidy layout: trail and history names use
  the full row width, the edit and duplicate buttons appear over the
  text on hover without anything shifting, close buttons show only on
  hover or on the active trail, all panel buttons line up on one
  vertical axis, and the outline list uses the same font and spacing
  as the other lists.
- Double-clicking a PDF no longer flashes an empty window first or
  opens the document in a window nudged away from its usual position.
- Pressing Tab no longer highlights random buttons with a yellow
  focus ring.
- List rows across the outline, trails and history panels breathe a
  little more: a comfortable fixed height with the text vertically
  centered, identical in all three lists.
- The reference preview can no longer be dragged past the bottom of
  the app window.
- Opening a document on a slow machine no longer briefly shows an
  empty window while the PDF is still loading.

## 0.5.10 (skipped)

Never released: its release run was blocked by a one-off test flake
in the CI gate. Version numbers are not reused, so the changes
shipped as 0.5.11.

## 0.5.9

- The Windows installer never force-closes a running Paper Trail
  anymore. It asks the app to close — you get the usual chance to save
  an unsaved reading session — and if you keep the app open, the
  installer stops with a message instead of killing it.
- Updates that download in the background are now completely silent:
  no progress bar on the taskbar or Dock icon, no pop-up asking you to
  restart. The update simply installs when you quit, and the next
  start greets you with "Paper Trail was updated to …". (The progress
  bar still appears for downloads you start yourself in the update
  window.)
- Restarting for an update with several windows open now asks the
  windows with unsaved sessions first — cancelling keeps every window
  exactly as it was.
- Closing the update window during a download and checking again now
  returns to the download's progress instead of offering the update
  from scratch.

## 0.5.8

- Checking for updates now opens a standard update window: it shows
  the available version, a progress bar while downloading, and a
  "Restart to Update" button when the download is ready — instead of
  a chain of alert boxes.
- Restarting for an update protects unsaved reading sessions: you are
  asked to save first, and cancelling simply returns you to the app
  with the update still ready.
- Fixed: choosing "Save…" when closing a window with a never-saved
  session did nothing — the window stayed open but no file was
  written. The save dialog now always appears.
- Windows: right-clicking the Paper Trail taskbar icon now offers a
  "New Window" task, like the macOS Dock menu.

## 0.5.7

- Fixed: checking for updates failed with "Update check failed …
  status 404" on both macOS and Windows — the updater was sent to
  download names that didn't exist on the release. (The 0.5.5
  downloads were also repaired in place, so updating from older
  versions works again immediately.)
- The web app at paper-trail-green.vercel.app now updates together
  with each release, after the full test suite passes — instead of on
  every code change.

## 0.5.6 (skipped)

Never released: its release run was cancelled mid-build so the
update-download fix above could ship with it. Version numbers are not
reused, so the changes shipped as 0.5.7.

## 0.5.5

- Fixed: on macOS, opening a session or PDF by double-clicking it in
  Finder could crash the app with a "JavaScript error" dialog the
  moment it launched.
- Session files now carry their own document icon in Finder and
  Explorer: a page with the trail-and-target logo.
- The reference preview popup no longer extends up into the toolbar —
  dragging its top edge stops just below it.
- Windows: right-click menus are now real Windows menus with the
  native look, instead of the browser-style menus Electron draws.
- Releases are now published only after the complete test suite —
  including installer and self-update tests — passes on all four
  machine types (Windows and macOS, Intel and ARM each).

## 0.5.4 (skipped)

Never released: its build was blocked by failing CI (the macOS
packaging step rejected a Windows-only native module in the universal
build). Version numbers are not reused, so the fix shipped as 0.5.5.

## 0.5.3

- Checking for updates is now a real conversation: if a new version
  exists, the app offers "Update Now", shows the download's progress
  on the Dock or taskbar icon, and asks to restart when it's ready.
  Restarting goes through the usual unsaved-session prompt for every
  window — keeping a window open simply postpones the update to the
  next time the app quits.
- The update mechanism itself is now tested on every change, on all
  four kinds of machines: Windows machines (Intel and ARM) install a
  build, update it from a test feed, and verify the new version runs;
  Macs verify the update is found and downloaded, and script the
  Check for Updates menu flow end to end.

## 0.5.2

- Fixed: on Windows ARM machines the installer finished but installed
  a broken app — the desktop shortcut pointed at nothing. (The
  compressor used a filter the installer's extractor couldn't decode,
  so every executable was silently dropped while the rest installed.)
- The Windows installer is now a standard wizard — pick the install
  folder, then Install — instead of the one-click installer, and it
  creates Start Menu and Desktop shortcuts.
- Fixed: on the desktop, reopening a PDF together with its session
  from the Recent list left continuous auto-save off until the next
  manual save.
- The Windows and web icons are now the paper-and-trail artwork
  itself, scaled to fill the canvas — the rounded dark plate belongs
  to the macOS icon only.
- Installers are now tested in CI end to end on four kinds of machines
  (Windows and macOS, Intel and ARM each): install, check shortcuts,
  launch, uninstall.

## 0.5.1

- Fixed: PDFs written with CJK (Chinese, Japanese, Korean) fonts that
  don't embed their font data showed no text at all and couldn't be
  searched. The character maps and standard fonts pdf.js needs for
  them now ship inside the app, so such documents work fully offline
  in the desktop app too.
- Windows: the toolbar's thin bottom border now continues underneath
  the minimize/maximize/close buttons instead of stopping where they
  start.

## 0.5.0

- The desktop apps now **update themselves**: new releases download in
  the background and install when you quit (a toast tells you when one
  is ready; macOS also has Check for Updates… in the app menu). Windows
  updates download only the changed pieces. This release is the last
  one you need to install by hand.
- Session files from a newer version of Paper Trail are refused with a
  clear "update the app" message instead of failing confusingly.

## 0.4.7

- Fixed: Load Reading Session (and first-time Save) from the macOS menu
  bar did nothing — menu clicks can't open the browser-style file
  pickers, so the app's own dialogs handle both now.
- The Recent list remembers each PDF together with its saved session
  and reopens them as a pair. If either file has gone missing, nothing
  loads at all and the message names exactly which file it was; a PDF
  that never had a session still reopens on its own.
- Opening a PDF while one is already showing opens it in a new window
  (desktop) or a new tab (web) instead of replacing what you're
  reading; an empty window is used directly.
- `Cmd/Ctrl+F` now toggles the search bar — pressing it again closes
  the bar and clears the highlights.
- Windows: the app now ships for ARM (one installer covers both Intel
  and ARM; separate zips per architecture).

## 0.4.6

- Windows: the toolbar now uses the standard 48px height that Fluent
  recommends for title bars with content (like Outlook and Edge), so
  it no longer feels cramped.

## 0.4.5

- Fixed: marking a spot (`Cmd/Ctrl+D`) no longer silently rewrites the
  anchor of the entry you were on — anchors only ever move when you
  re-anchor deliberately.
- Fixed: expanding an outline section after Collapse All no longer
  flashes the whole subtree before settling.
- Re-anchoring is now `Cmd/Ctrl+G` (the E-based combos belong to the
  browser and never reached the app).
- The app feels more at home on the desktop: the macOS close button
  shows the standard dot while the session has unsaved changes, opened
  files appear in the title-bar proxy and the Windows taskbar Jump
  List, the Dock menu offers New Window, and there's a proper About
  panel.

## 0.4.4

- Search is a floating find bar now: `Cmd/Ctrl+F` summons it, Escape
  puts it away, and the toolbar never shifts. The undo/redo buttons are
  gone too (`Cmd/Ctrl+Z` does that), leaving a leaner toolbar.
- History entries show a hover × to remove just that entry (undoable),
  and the page-number badge is gone.
- The outline has Expand All / Collapse All buttons.
- New shortcuts: `Alt+Shift+D` duplicates the current trail, and
  re-anchoring is `Cmd/Ctrl+Shift+E` (plain `Cmd/Ctrl+E` belongs to the
  browser and never worked there).
- Windows: the window buttons sit at the platform's standard caption
  size and can no longer cover toolbar content.
- Right-clicking dead space no longer shows a stray menu, and the
  empty-state drop overlay mentions session files.

## 0.4.3

- Opening a PDF and loading a session are now fully separate actions:
  `Cmd/Ctrl+O` (and File ▸ Open) picks PDFs only, `Cmd/Ctrl+Shift+O`
  (and Load session…) picks session files only, and the toolbar Open
  button is gone — opening lives on the welcome screen, the shortcut,
  and drag-and-drop.
- With a document open, dropping a PDF no longer replaces it (open
  another window for another paper); dropping a session file still
  loads it.
- Desktop: files opened from the OS (Open With…, dropping onto the app
  icon) always get their own window, and the cheat-sheet includes
  desktop shortcuts such as `Cmd/Ctrl+N`.
- The hover preview can be resized from its top edge too, and it never
  covers the link you're hovering, even in small windows.

## 0.4.2

- Every keyboard shortcut now uses a modifier, like a normal app —
  plain typing never triggers anything. Back/Forward are `Alt+←`/`Alt+→`
  (or `Cmd/Ctrl+[`/`]`), mark is `Cmd/Ctrl+D`, re-anchor is
  `Cmd/Ctrl+E`, trails switch with `Alt+[`/`Alt+]`, the sidebar toggles
  with `Cmd/Ctrl+B`.
- Press `?` for a proper shortcut cheat-sheet overlay.
- Right-click menus everywhere, and they feel native: full edit menus
  with spell-check in text fields, Copy / Look Up / "Search Document
  for …" on selections, and context actions on links (follow, follow in
  a new trail), history entries (jump, rename, re-anchor), trails
  (switch, rename, duplicate, close), and the page (back, forward,
  mark, zoom).
- Windows: the window buttons are integrated into the toolbar and the
  menu bar is gone — everything is in the app itself.
- macOS: the traffic lights are now exactly centered in the toolbar.
- The README explains what trails and branches are up front.

## 0.4.1

- Session files are now fully transparent: they identify the PDF by
  **name only** — no more hidden fingerprint. Opening a session is
  always two explicit steps (session file, then PDF); the app never
  opens a PDF by itself. Old session files still load.
- Re-anchoring an entry (⌖) now also refreshes its label to the new
  position — unless you renamed the entry yourself, in which case your
  name is kept. New `r` shortcut re-anchors the current entry.
- macOS: the traffic lights sit properly centered in a native-height
  toolbar.
- Trails: a + button starts a fresh trail, every trail can be
  duplicated from its row, and `[` / `]` switch between trails.
- Press `?` for the shortcut cheat-sheet.
- The Recent list on the welcome screen has a × to remove entries.
- Desktop: standard right-click menus, a leaner toolbar (Open and the
  GitHub link live in the menus / web version), and properly centered
  traffic lights on macOS.
- Paper Trail is now MIT licensed.

## 0.4.0

- Desktop apps grew standard behaviors: multiple windows (Cmd/Ctrl+N),
  Open… in a new window, Open With… / dragging a PDF onto the Dock
  icon, Open Recent, remembered window size, a standard
  Save / Don't Save / Cancel close prompt, and .pdf/.ptl file
  associations.
- The outline is collapsible: sections with subsections get a chevron.
- The hover preview is sharp and scrolls through the entire document.
- All icons are crisp SVGs; keyboard hints show your platform's own
  modifier key; single-key shortcuts (m, Shift+M, t) appear in the
  macOS menus; renaming happens in place without the row shifting.
- Opening a PDF always starts fresh — reading state lives only in
  session files you save explicitly.

## 0.3.4

- macOS builds are signed and notarized — no more right-click → Open.

## 0.3.1

- First public release: reading trails with exact-position
  back/forward, branching (Cmd/Ctrl+click), hover previews, search,
  plain-text session files, and web + macOS + Windows builds.
