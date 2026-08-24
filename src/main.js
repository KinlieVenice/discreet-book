import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const META_KEY = 'discreet-book:meta';
const DB_NAME = 'discreet-book';
const STORE_NAME = 'text';
const TEXT_KEY = 'book';

// Old key names from before the repo was renamed from discrete-book to
// discreet-book. migrateLegacyStorage() below moves anything found under
// these into the new names, once, so nobody's saved progress is lost.
const LEGACY_META_KEY = 'discrete-book:meta';
const LEGACY_DB_NAME = 'discrete-book';

const landing = document.getElementById('landing');
const readerEl = document.getElementById('reader');
const contentEl = document.getElementById('content');
const dropzone = document.getElementById('dropzone');
const dropzoneMain = document.getElementById('dropzoneMain');
const dropzoneSub = document.getElementById('dropzoneSub');
const fileInput = document.getElementById('fileInput');
const resumeRow = document.getElementById('resumeRow');
const resumeBtn = document.getElementById('resumeBtn');
const discardBtn = document.getElementById('discardBtn');
const themeSelect = document.getElementById('themeSelect');
const progressFill = document.getElementById('progressFill');
const pageInfo = document.getElementById('pageInfo');
const panicOverlay = document.getElementById('panicOverlay');
const panicText = document.getElementById('panicText');
const loadNewBtn = document.getElementById('loadNew');
const hideBtn = document.getElementById('hideBtn');
const fontUpBtn = document.getElementById('fontUp');
const fontDownBtn = document.getElementById('fontDown');
const fontFamilyGroup = document.getElementById('fontFamilyGroup');
const fontFamilySelect = document.getElementById('fontFamilySelect');
const controlsHandle = document.getElementById('controlsHandle');
const pageToggleBtn = document.getElementById('pageToggle');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageIndicator = document.getElementById('pageIndicator');

// One "reader page" groups this many source PDF pages (paragraphs — each
// paragraph is one PDF page's worth of text) together, when pagination is on.
const PAGE_SIZE = 10;

let state = { text: '', name: '', theme: 'gitlab', fontSize: 17, fontFamily: '', scrollPct: 0, paginated: true, pageGroup: 0 };
let panicOn = false;
let saveTimer = null;
let extracting = false;

// Only the "Office" and "AI Chat" group themes expose a font-family picker —
// engineering themes (diff/GitLab issue) stay fixed to their own real
// typography, same as those tools wouldn't let you pick a document font.
const OFFICE_THEMES = new Set([
  'spreadsheet', 'docs', 'email', 'claude', 'gpt'
]);

const FONT_STACKS = {
  calibri: "'Calibri', 'Carlito', var(--sans)",
  arial: "Arial, Helvetica, sans-serif",
  times: "'Times New Roman', Times, serif",
  georgia: "Georgia, 'Times New Roman', serif",
  cambria: "Cambria, Georgia, serif",
  verdana: "Verdana, Geneva, sans-serif",
  tahoma: "Tahoma, Geneva, sans-serif"
};

const FONT_LABELS = {
  '': 'Calibri', calibri: 'Calibri', arial: 'Arial', times: 'Times New Roman',
  georgia: 'Georgia', cambria: 'Cambria', verdana: 'Verdana', tahoma: 'Tahoma'
};

const PANIC_LABELS = {
  prdiff: 'Fetching diff…',
  gitlab: 'Loading issue…',
  github: 'Rendering preview…',
  spreadsheet: 'Recalculating…',
  docs: 'Saving…',
  email: 'Checking for new mail…',
  claude: 'Thinking…',
  gpt: 'Generating…'
};

const TAB_TITLES = {
  prdiff: 'Pull Request #482',
  gitlab: 'Issue #128 · Working notes — internal · GitLab',
  github: 'project/README.md at main',
  spreadsheet: 'Q3 Working Notes.xlsx',
  docs: 'Working Notes - Google Docs',
  email: 'Inbox',
  claude: 'Claude',
  gpt: 'ChatGPT'
};

function safeGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try { window.localStorage.setItem(key, val); } catch { /* storage unavailable or full */ }
}
function safeRemove(key) {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

function loadMeta() {
  const raw = safeGet(META_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function persistMeta() {
  safeSet(META_KEY, JSON.stringify({
    name: state.name, theme: state.theme, fontSize: state.fontSize,
    fontFamily: state.fontFamily, scrollPct: state.scrollPct,
    paginated: state.paginated, pageGroup: state.pageGroup
  }));
}

/* The extracted book text goes in IndexedDB, not localStorage: a long book
   can easily run past localStorage's ~5-10MB quota, while IndexedDB has no
   such practical ceiling — so reading progress survives regardless of book
   length or page count. */
function openDb(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetText(text, dbName = DB_NAME) {
  try {
    const db = await openDb(dbName);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(text, TEXT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* storage unavailable or full — reading still works this session */ }
}

async function idbGetText(dbName = DB_NAME) {
  try {
    const db = await openDb(dbName);
    const text = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(TEXT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return text;
  } catch { return null; }
}

async function idbDeleteText() {
  try {
    const db = await openDb(DB_NAME);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(TEXT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* ignore */ }
}

function clearSaved() {
  safeRemove(META_KEY);
  idbDeleteText();
}

function persist() {
  persistMeta();
  idbSetText(state.text);
}

function schedulePersist() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

/* One-time move from the pre-rename "discrete-book" storage names to the
   current "discreet-book" ones, so renaming the app didn't quietly wipe
   anyone's saved reading progress. Safe to run every load: it's a no-op
   once nothing is left under the legacy names. */
async function migrateLegacyStorage() {
  const legacyMetaRaw = safeGet(LEGACY_META_KEY);
  if (legacyMetaRaw && !safeGet(META_KEY)) {
    safeSet(META_KEY, legacyMetaRaw);
  }
  if (legacyMetaRaw) safeRemove(LEGACY_META_KEY);

  try {
    const alreadyHasNewText = await idbGetText(DB_NAME);
    if (!alreadyHasNewText) {
      const legacyText = await idbGetText(LEGACY_DB_NAME);
      if (legacyText) await idbSetText(legacyText, DB_NAME);
    }
  } catch { /* ignore */ }

  try { indexedDB.deleteDatabase(LEGACY_DB_NAME); } catch { /* ignore */ }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paragraphsOf(text) {
  return text.split(/\n{2,}/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* ---------------- PDF extraction (fully client-side) ---------------- */

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) pageTexts.push(pageText);
    setExtractProgress(i, pdf.numPages);
    page.cleanup();
  }
  return pageTexts.join('\n\n');
}

function setExtractProgress(done, total) {
  dropzoneMain.textContent = `Extracting… page ${done} of ${total}`;
  dropzoneSub.textContent = 'This can take a moment for long books.';
}

/* ---------------- Theme rendering ---------------- */

/* Small inline-SVG icon set, used in place of emoji. Emoji render as
   colorful platform-specific pictographs (and are occasionally the wrong
   glyph entirely for the intended entity code) — completely at odds with
   recreating a specific app's actual monochrome toolbar icons. These use
   currentColor so they pick up each theme's icon color automatically. */
const ICON_DEFS = {
  file: { body: '<rect x="3" y="1.5" width="10" height="13" rx="1"/><line x1="5.5" y1="5" x2="10.5" y2="5"/><line x1="5.5" y1="8" x2="10.5" y2="8"/><line x1="5.5" y1="11" x2="8.5" y2="11"/>' },
  comment: { body: '<rect x="2" y="3" width="12" height="7" rx="1.5"/><path d="M5 10l-1.5 2.5V10z"/>' },
  lock: { body: '<rect x="3.5" y="7.5" width="9" height="6" rx="1"/><path d="M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2"/>' },
  print: { body: '<rect x="2.5" y="5.5" width="11" height="6" rx="1"/><rect x="4.5" y="2" width="7" height="4"/><rect x="4.5" y="10" width="7" height="3.5"/>' },
  paint: { body: '<rect x="3" y="2" width="3.2" height="6" rx="1"/><rect x="3.9" y="7.5" width="1.4" height="5" rx="0.7"/><path d="M8.5 3l4 4-4.2 4.2-2-2z"/>' },
  fill: { body: '<path d="M3 6.5 8 2l5 4.5L8 11z"/><path d="M11.5 9.5c0 1.4-1.1 2.5-2.5 2.5"/>' },
  link: { body: '<rect x="1.7" y="6.6" width="6" height="2.8" rx="1.4" transform="rotate(-45 4.7 8)"/><rect x="8.3" y="6.6" width="6" height="2.8" rx="1.4" transform="rotate(-45 11.3 8)"/>' },
  chart: { body: '<line x1="3" y1="13.5" x2="3" y2="9"/><line x1="8" y1="13.5" x2="8" y2="5"/><line x1="13" y1="13.5" x2="13" y2="7"/>', strokeWidth: 2.2 },
  filter: { body: '<path d="M2.5 3.5h11L9.2 8.6v4l-2.4 1.2V8.6z"/>' },
  search: { body: '<circle cx="6.7" cy="6.7" r="4"/><line x1="9.6" y1="9.6" x2="13.5" y2="13.5"/>' },
  undo: { body: '<path d="M4.5 4v4h4"/><path d="M4.5 8a5 5 0 1 1 1.5 5.6"/>' },
  redo: { body: '<path d="M11.5 4v4h-4"/><path d="M11.5 8a5 5 0 1 0-1.5 5.6"/>' },
  borders: { body: '<rect x="2.5" y="2.5" width="11" height="11"/><line x1="2.5" y1="8" x2="13.5" y2="8"/><line x1="8" y1="2.5" x2="8" y2="13.5"/>' },
  merge: { body: '<rect x="2.5" y="2.5" width="11" height="11"/><line x1="2.5" y1="8" x2="13.5" y2="8"/>' },
  align: { body: '<line x1="2.5" y1="4" x2="13.5" y2="4"/><line x1="2.5" y1="7.3" x2="10.5" y2="7.3"/><line x1="2.5" y1="10.6" x2="13.5" y2="10.6"/><line x1="2.5" y1="13.4" x2="10.5" y2="13.4"/>' },
  valign: { body: '<line x1="4" y1="2.2" x2="4" y2="13.8"/><line x1="8" y1="4.2" x2="8" y2="11.8"/><line x1="12" y1="6.2" x2="12" y2="9.8"/>' },
  wrap: { body: '<path d="M2.5 5.5h8a2.2 2.2 0 0 1 0 4.4H8.3"/><path d="M9.8 7.6 7.9 9.9l1.9 2.3"/>' },
  rotate: { body: '<path d="M12.8 5.2A5.3 5.3 0 1 0 13.3 9.3"/><path d="M13.3 2.8v3.4h-3.4"/>' },
  hamburger: { body: '<line x1="2.5" y1="4" x2="13.5" y2="4"/><line x1="2.5" y1="8" x2="13.5" y2="8"/><line x1="2.5" y1="12" x2="13.5" y2="12"/>' },
  more: { body: '<circle cx="8" cy="3" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="8" cy="13" r="1.1"/>', filled: true },
  star: { body: '<path d="M8 1.6l1.9 3.9 4.3.5-3.1 3 .8 4.3L8 11.2l-3.9 2.1.8-4.3-3.1-3 4.3-.5z"/>' },
  sunburst: {
    body: '<g stroke-linecap="round"><line x1="8" y1="1.3" x2="8" y2="4.3"/><line x1="8" y1="11.7" x2="8" y2="14.7"/>' +
      '<line x1="1.3" y1="8" x2="4.3" y2="8"/><line x1="11.7" y1="8" x2="14.7" y2="8"/>' +
      '<line x1="3.4" y1="3.4" x2="5.5" y2="5.5"/><line x1="10.5" y1="10.5" x2="12.6" y2="12.6"/>' +
      '<line x1="12.6" y1="3.4" x2="10.5" y2="5.5"/><line x1="5.5" y1="10.5" x2="3.4" y2="12.6"/></g>'
  },
  pencil: { body: '<path d="M11.2 2.3l2.5 2.5L6 12.5H3.5V10z"/>' },
  check: { body: '<path d="M3 8.5l3 3 7-7"/>' },
  indent: {
    body: '<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="6.5" x2="14" y2="6.5"/>' +
      '<path d="M2 5.2v2.6l1.8-1.3z" fill="currentColor" stroke="none"/>' +
      '<line x1="6" y1="10" x2="14" y2="10"/><line x1="2" y1="13" x2="14" y2="13"/>'
  },
  bullets: {
    body: '<circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="4" x2="14" y2="4"/>' +
      '<circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="8" x2="14" y2="8"/>' +
      '<circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none"/><line x1="6" y1="12" x2="14" y2="12"/>'
  },
  numbered: {
    body: '<rect x="1.6" y="3.1" width="1.8" height="1.8" fill="currentColor" stroke="none"/><line x1="6" y1="4" x2="14" y2="4"/>' +
      '<rect x="1.6" y="7.1" width="1.8" height="1.8" fill="currentColor" stroke="none"/><line x1="6" y1="8" x2="14" y2="8"/>' +
      '<rect x="1.6" y="11.1" width="1.8" height="1.8" fill="currentColor" stroke="none"/><line x1="6" y1="12" x2="14" y2="12"/>'
  },
  highlight: { body: '<path d="M10 2l4 4-7 7H3.5v-3.5z"/><line x1="1.5" y1="14.5" x2="12.5" y2="14.5"/>' },
  outdent: {
    body: '<line x1="2" y1="3" x2="14" y2="3"/><line x1="6" y1="6.5" x2="14" y2="6.5"/>' +
      '<path d="M6 5.2v2.6L4.2 6.5z" fill="currentColor" stroke="none"/>' +
      '<line x1="6" y1="10" x2="14" y2="10"/><line x1="2" y1="13" x2="14" y2="13"/>'
  },
  rulermarker: { body: '<path d="M4 2h8l-4 5z" fill="currentColor" stroke="none"/><path d="M4 14h8l-4-5z" fill="currentColor" stroke="none"/>' },
  lightbulb: {
    body: '<path d="M8 1.8a4.3 4.3 0 0 0-2.4 7.9c.4.3.6.7.6 1.2v.4h3.6v-.4c0-.5.2-.9.6-1.2A4.3 4.3 0 0 0 8 1.8z"/>' +
      '<line x1="6.4" y1="13.2" x2="9.6" y2="13.2"/><line x1="6.7" y1="14.4" x2="9.3" y2="14.4"/>'
  },
  person: { body: '<circle cx="8" cy="5" r="2.6"/><path d="M2.7 14c0-2.9 2.4-4.8 5.3-4.8s5.3 1.9 5.3 4.8"/>' },
  mappin: { body: '<path d="M8 14.3S12.6 9.7 12.6 6.3a4.6 4.6 0 1 0-9.2 0C3.4 9.7 8 14.3 8 14.3z"/><circle cx="8" cy="6.2" r="1.7"/>' },
  waffle: {
    body: '<g fill="currentColor" stroke="none">' +
      ['3', '8', '13'].map((cy) => ['3', '8', '13'].map((cx) => `<circle cx="${cx}" cy="${cy}" r="1.3"/>`).join('')).join('') +
      '</g>'
  },
  gmaillogo: {
    body: '<rect x="1" y="2.6" width="14" height="10.8" rx="1.6" fill="#ffffff" stroke="#dadce0" stroke-width="1"/>' +
      '<path d="M2.2 4.4 8 8.6l5.8-4.2" fill="none" stroke="#ea4335" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M2 4.1v7.5a1.1 1.1 0 0 0 1.1 1.1H4V6.9z" fill="#4285f4" stroke="none"/>' +
      '<path d="M14 4.1v7.5a1.1 1.1 0 0 1-1.1 1.1H12V6.9z" fill="#34a853" stroke="none"/>' +
      '<path d="M2 4.1 4 5.6v1.3L2 5.3z" fill="#fbbc04" stroke="none"/>' +
      '<path d="M14 4.1 12 5.6v1.3l2-1.6z" fill="#fbbc04" stroke="none"/>'
  },
  googledocslogo: {
    body: '<rect x="2.3" y="0.8" width="9.8" height="14.4" rx="1.3" fill="#ffffff" stroke="#c7cdd4" stroke-width="0.6"/>' +
      '<path d="M8.7 0.9v3.2a1 1 0 0 0 1 1H12z" fill="#a4c2f4" stroke="none"/>' +
      '<line x1="4.3" y1="7.5" x2="9.9" y2="7.5" stroke="#4285f4" stroke-width="1.1" stroke-linecap="round"/>' +
      '<line x1="4.3" y1="9.6" x2="9.9" y2="9.6" stroke="#4285f4" stroke-width="1.1" stroke-linecap="round"/>' +
      '<line x1="4.3" y1="11.7" x2="7.7" y2="11.7" stroke="#4285f4" stroke-width="1.1" stroke-linecap="round"/>'
  },
  googlesheetslogo: {
    body: '<rect x="2.3" y="0.8" width="9.8" height="14.4" rx="1.3" fill="#ffffff" stroke="#c7cdd4" stroke-width="0.6"/>' +
      '<path d="M8.7 0.9v3.2a1 1 0 0 0 1 1H12z" fill="#a0ddb1" stroke="none"/>' +
      '<rect x="4.3" y="7.1" width="5.6" height="5.4" fill="none" stroke="#34a853" stroke-width="0.9"/>' +
      '<line x1="4.3" y1="9.8" x2="9.9" y2="9.8" stroke="#34a853" stroke-width="0.9"/>' +
      '<line x1="7.1" y1="7.1" x2="7.1" y2="12.5" stroke="#34a853" stroke-width="0.9"/>'
  },
  inboxtray: {
    body: '<path d="M2.3 9V4.3a1 1 0 0 1 1-1h9.4a1 1 0 0 1 1 1V9"/>' +
      '<path d="M2.3 9h3.4l1 1.7h2.6l1-1.7h3.4"/>' +
      '<path d="M2.3 9v2.7a1 1 0 0 0 1 1h9.4a1 1 0 0 0 1-1V9"/>'
  },
  send: { body: '<path d="M2 8.2 13.7 2.3 9.3 13.7l-1.8-4.6z"/><path d="M7.5 9.1 13.7 2.3"/>' },
  clock: { body: '<circle cx="8" cy="8.6" r="5.8"/><path d="M8 5.4v3.2l2.3 1.3"/><line x1="5.6" y1="1.5" x2="10.4" y2="1.5"/>' },
  chevrondown: { body: '<path d="M4 6.2 8 10l4-3.8"/>' },
  bag: { body: '<path d="M4.2 5h7.6l.8 8.5H3.4z"/><path d="M6.2 5V3.8a1.8 1.8 0 0 1 3.6 0V5"/>' },
  envelope: { body: '<rect x="1.6" y="3.6" width="12.8" height="9" rx="1"/><path d="M1.9 4.2 8 9l6.1-4.8"/>' },
  folder: { body: '<path d="M2 4.2h4.2l1.1 1.4h6.7a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1z"/>' },
  tag: { body: '<path d="M2 2.3h5.4L14 8.9 8.9 14 2.3 7.4z"/><circle cx="4.9" cy="4.9" r="1" fill="currentColor" stroke="none"/>' },
  trash: {
    body: '<line x1="2.8" y1="4.5" x2="13.2" y2="4.5"/><path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5"/>' +
      '<path d="M4.4 4.5l.7 9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.7-9"/>'
  },
  alertcircle: { body: '<circle cx="8" cy="8" r="6.3"/><line x1="8" y1="5" x2="8" y2="9.2"/><circle cx="8" cy="11.3" r="0.2" fill="currentColor" stroke="none"/>' },
  archivebox: {
    body: '<rect x="2" y="2.6" width="12" height="3" rx="0.8"/><rect x="2.7" y="5.6" width="10.6" height="8" rx="0.8"/><line x1="6.3" y1="8.7" x2="9.7" y2="8.7"/>'
  },
  calendar: {
    body: '<rect x="2" y="3.4" width="12" height="10.6" rx="1"/><line x1="2" y1="6.4" x2="14" y2="6.4"/><line x1="5.2" y1="1.9" x2="5.2" y2="4.6"/><line x1="10.8" y1="1.9" x2="10.8" y2="4.6"/>'
  },
  gear: {
    body: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9 3.7 3.7"/>'
  },
  helpcircle: {
    body: '<circle cx="8" cy="8" r="6.3"/><path d="M6.1 6.2a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3v.3"/><circle cx="8" cy="11.6" r="0.2" fill="currentColor" stroke="none"/>'
  },
  puzzle: {
    body: '<path d="M3 3h3.1a1.15 1.15 0 0 1 2.3 0H11a1 1 0 0 1 1 1v2.6a1.15 1.15 0 0 1 0 2.3V11a1 1 0 0 1-1 1H8.4a1.15 1.15 0 0 1-2.3 0H3a1 1 0 0 1-1-1V7.9a1.15 1.15 0 0 1 0-2.3V4a1 1 0 0 1 1-1z"/>'
  },
  spark: { body: '<path d="M8 1.4c.4 2.7 1.1 3.7 3.8 4.1a.25.25 0 0 1 0 .5c-2.7.4-3.4 1.4-3.8 4.1a.25.25 0 0 1-.5 0c-.4-2.7-1.1-3.7-3.8-4.1a.25.25 0 0 1 0-.5c2.7-.4 3.4-1.4 3.8-4.1a.25.25 0 0 1 .5 0z" fill="currentColor" stroke="none"/>' },
  expand: { body: '<path d="M5.6 1.8h-3.8v3.8"/><path d="M1.8 1.8l4.3 4.3"/><path d="M10.4 14.2h3.8v-3.8"/><path d="M14.2 14.2 9.9 9.9"/>' },
  popout: {
    body: '<path d="M6.5 2h7.5v7.5"/><path d="M14 2 7.2 8.8"/><path d="M10.8 8.8v3.9a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 12.7V6.5a1.3 1.3 0 0 1 1.3-1.3h3.9"/>'
  },
  smiley: {
    body: '<circle cx="8" cy="8" r="6.3"/><circle cx="5.6" cy="6.7" r="0.75" fill="currentColor" stroke="none"/>' +
      '<circle cx="10.4" cy="6.7" r="0.75" fill="currentColor" stroke="none"/><path d="M5.2 9.7c.7 1.1 1.7 1.7 2.8 1.7s2.1-.6 2.8-1.7"/>'
  },
  reply: { body: '<path d="M6.6 4.2 2.4 8l4.2 3.8"/><path d="M2.4 8h6.4a4.7 4.7 0 0 1 4.7 4.7v.4"/>' },
  forward: { body: '<path d="M9.4 4.2 13.6 8l-4.2 3.8"/><path d="M13.6 8H7.2a4.7 4.7 0 0 0-4.7 4.7v.4"/>' },
  gitlablogo: {
    body: '<path d="M1.3 6.2 5.3 6.2 8 14.2Z" fill="#e24329" stroke="none"/>' +
      '<path d="M14.7 6.2 10.7 6.2 8 14.2Z" fill="#e24329" stroke="none"/>' +
      '<path d="M5.3 6.2 10.7 6.2 8 14.2Z" fill="#fc6d26" stroke="none"/>' +
      '<path d="M1.3 6.2 3.6 6.2 2.6 2.3Z" fill="#fc6d26" stroke="none"/>' +
      '<path d="M14.7 6.2 12.4 6.2 13.4 2.3Z" fill="#fc6d26" stroke="none"/>' +
      '<path d="M5.3 6.2 10.7 6.2 8 1.6Z" fill="#fca326" stroke="none"/>' +
      '<path d="M1.3 6.2 2.6 2.3 5.3 6.2Z" fill="#fca326" stroke="none"/>' +
      '<path d="M14.7 6.2 13.4 2.3 10.7 6.2Z" fill="#fca326" stroke="none"/>'
  },
  gitbranch: {
    body: '<circle cx="4" cy="3.2" r="1.6"/><circle cx="4" cy="12.8" r="1.6"/><circle cx="12" cy="8" r="1.6"/>' +
      '<line x1="4" y1="4.8" x2="4" y2="11.2"/><path d="M4 7.3a4.3 4.3 0 0 0 4 3.2h1.5"/>'
  },
  gitmerge: {
    body: '<circle cx="4" cy="3.2" r="1.6"/><circle cx="4" cy="12.8" r="1.6"/><circle cx="12" cy="12.8" r="1.6"/>' +
      '<line x1="4" y1="4.8" x2="4" y2="11.2"/><path d="M12 11.2V7.5a4.3 4.3 0 0 0-4-4.3"/>'
  },
  board: { body: '<rect x="1.8" y="2.5" width="12.4" height="11" rx="1"/><line x1="5.8" y1="2.5" x2="5.8" y2="13.5"/><line x1="10.2" y1="2.5" x2="10.2" y2="13.5"/>' },
  headset: {
    body: '<path d="M3 8.3V8a5 5 0 0 1 10 0v.3"/><rect x="2.2" y="8" width="2.4" height="3.6" rx="1"/>' +
      '<rect x="11.4" y="8" width="2.4" height="3.6" rx="1"/><path d="M12.6 11.6v.5a2 2 0 0 1-2 2H9"/>'
  },
  flag: { body: '<line x1="3.2" y1="1.8" x2="3.2" y2="14.2"/><path d="M3.2 2.5h8.4l-2 2.8 2 2.8H3.2z"/>' },
  rocket: {
    body: '<path d="M8 1.7c2.4 1 3.8 3.5 3.8 6.5 0 1.6-.4 3-1 4.2H5.2c-.6-1.2-1-2.6-1-4.2 0-3 1.4-5.5 3.8-6.5z"/>' +
      '<circle cx="8" cy="6.7" r="1.3"/><path d="M5.6 11.6 4 14.3l1.8-.6"/><path d="M10.4 11.6 12 14.3l-1.8-.6"/>'
  },
  shield: { body: '<path d="M8 1.5 13.6 3.6v4c0 3.7-2.3 6.5-5.6 7.5-3.3-1-5.6-3.8-5.6-7.5v-4z"/><path d="M5.5 8.1 7.1 9.7l3.3-3.5"/>' },
  server: {
    body: '<rect x="2" y="2.5" width="12" height="4" rx="1"/><rect x="2" y="9.5" width="12" height="4" rx="1"/>' +
      '<circle cx="4.2" cy="4.5" r="0.5" fill="currentColor" stroke="none"/><circle cx="4.2" cy="11.5" r="0.5" fill="currentColor" stroke="none"/>'
  },
  book: { body: '<path d="M2.5 2.8c1.6-.6 3.5-.6 5.5.4v9.8c-2-1-3.9-1-5.5-.4z"/><path d="M13.5 2.8c-1.6-.6-3.5-.6-5.5.4v9.8c2-1 3.9-1 5.5-.4z"/>' },
  codebrackets: { body: '<path d="M5.6 3.5 2 8l3.6 4.5"/><path d="M10.4 3.5 14 8l-3.6 4.5"/>' },
  bell: { body: '<path d="M4 11V7.2a4 4 0 0 1 8 0V11l1.3 1.7H2.7z"/><path d="M6.6 13.6a1.6 1.6 0 0 0 2.8 0"/>' },
  eye: { body: '<path d="M1.5 8S4 3.3 8 3.3 14.5 8 14.5 8 12 12.7 8 12.7 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.1"/>' },
  clipboard: { body: '<rect x="3.2" y="2.8" width="9.6" height="11.4" rx="1.2"/><rect x="5.8" y="1.5" width="4.4" height="2.2" rx="0.6"/>' },
  githublogo: {
    body: '<path d="M8 1.6c-3.6 0-6.4 2.9-6.4 6.5 0 2.9 1.9 5.4 4.5 6.2.3.1.5-.1.5-.4v-1.4c-1.8.4-2.2-.8-2.2-.8-.3-.8-.7-1-.7-1-.6-.4.1-.4.1-.4.6 0 1 .6 1 .6.6 1 1.6.7 2 .5.1-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.2-1.3.6-1.7-.1-.2-.3-.9.1-1.8 0 0 .5-.2 1.7.6.5-.1 1-.2 1.5-.2s1 .1 1.5.2c1.1-.8 1.7-.6 1.7-.6.3.9.1 1.6.1 1.8.4.5.6 1 .6 1.7 0 2.5-1.5 3-2.9 3.1.2.2.4.6.4 1.2v1.8c0 .3.2.5.5.4 2.6-.9 4.5-3.3 4.5-6.2 0-3.6-2.9-6.5-6.4-6.5z" fill="currentColor" stroke="none"/>'
  },
  imageicon: { body: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><circle cx="5.5" cy="6" r="1.3"/><path d="M2 12l3.5-4 2.5 3 2-2.5L14 12"/>' },
  checklist: {
    body: '<rect x="1.7" y="2.7" width="2.4" height="2.4" rx="0.4"/><path d="M2.2 3.9l0.6 0.6 1-1.2"/><line x1="6" y1="3.9" x2="14" y2="3.9"/>' +
      '<rect x="1.7" y="6.8" width="2.4" height="2.4" rx="0.4"/><path d="M2.2 8l0.6 0.6 1-1.2"/><line x1="6" y1="8" x2="14" y2="8"/>' +
      '<rect x="1.7" y="10.9" width="2.4" height="2.4" rx="0.4"/><line x1="6" y1="12.1" x2="14" y2="12.1"/>'
  },
  clearformat: { body: '<line x1="2" y1="3" x2="10" y2="3"/><line x1="6" y1="3" x2="6" y2="11"/><line x1="10.5" y1="9.5" x2="14.5" y2="13.5"/><line x1="14.5" y1="9.5" x2="10.5" y2="13.5"/>' },
  cloudsaved: {
    body: '<path d="M4.8 11.5a3 3 0 0 1-.3-6 4 4 0 0 1 7.6-1.2A2.8 2.8 0 0 1 11.5 11.5z"/><path d="M6 8.3l1.5 1.5 3-3.2"/>'
  },
  mention: { body: '<circle cx="8" cy="8.4" r="3"/><path d="M11 8.4V10a1.8 1.8 0 0 0 3.5-.5V8a6.5 6.5 0 1 0-2.7 5.3"/>' }
};

function icon(name, cls) {
  const def = ICON_DEFS[name];
  if (!def) return '';
  const sw = def.strokeWidth || 1.3;
  const fillAttr = def.filled ? 'currentColor' : 'none';
  const strokeAttr = def.filled ? 'none' : 'currentColor';
  return `<svg class="ico-svg${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" fill="${fillAttr}" stroke="${strokeAttr}" ` +
    `stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def.body}</svg>`;
}

function renderPrDiff(paras, startIndex = 0, totalParas = paras.length) {
  let html = '<div class="diff-chrome">';
  html += `<div class="diff-file-header">${icon('file')} notes/reading.md &nbsp; <span class="diff-badge">+` + totalParas + '&nbsp;&minus;0</span></div>';
  html += `<div class="diff-hunk-marker">@@ -0,0 +${startIndex + 1},${paras.length} @@</div>`;
  html += '</div>';
  html += '<div class="diff-file">';
  paras.forEach((p, i) => {
    html += `<div class="diff-row"><div class="diff-gutter">${startIndex + i + 1}</div><div class="diff-linecontent">${escapeHtml(p)}</div></div>`;
  });
  html += '</div>';
  return html;
}

function gitlabNavItem(iconName, label, count) {
  return `<div class="gl-navitem">${icon(iconName)}<span>${label}</span>` +
    (count != null ? `<span class="gl-navcount">${count}</span>` : '') + '</div>';
}

function gitlabRailRow(iconName, label) {
  return `<div class="gl-railrow"><span class="gl-railico">${icon(iconName)}</span><span class="gl-railtext">${label}</span></div>`;
}

function renderGitlab(paras, startIndex = 0, totalParas = paras.length) {
  let html = '<div class="gl-page">';

  html += '<div class="gl-topbar">' +
    `<span class="gl-topico">${icon('hamburger')}</span>` +
    `<span class="gl-brand">${icon('gitlablogo')}GitLab</span>` +
    `<span class="gl-search">${icon('search')}<span class="gl-search-ph">Search GitLab</span></span>` +
    '<span class="gl-topbar-spacer"></span>' +
    `<span class="gl-topico">+</span>` +
    `<span class="gl-topico">${icon('gitmerge')}</span>` +
    `<span class="gl-topico gl-bell"><span class="gl-badge">6</span>${icon('bell')}</span>` +
    `<span class="gl-topico">${icon('helpcircle')}</span>` +
    `<span class="gl-topico">${icon('gear')}</span>` +
    '<span class="gl-avatar">U</span>' +
    '</div>';

  html += '<div class="gl-shell">';

  html += '<div class="gl-sidebar">';
  html += `<div class="gl-project"><span class="gl-project-icon">${icon('gitbranch')}</span><span>Workspace</span></div>`;
  html += '<div class="gl-navlist">' +
    gitlabNavItem('file', 'Project information') +
    gitlabNavItem('gitbranch', 'Repository') +
    gitlabNavItem('alertcircle', 'Issues', 24) +
    `<div class="gl-navsub">` +
    gitlabNavItem('board', 'Boards') +
    gitlabNavItem('headset', 'Service Desk') +
    gitlabNavItem('flag', 'Milestones') +
    '</div>' +
    gitlabNavItem('gitmerge', 'Merge requests', 3) +
    gitlabNavItem('rocket', 'CI/CD') +
    gitlabNavItem('shield', 'Security & Compliance') +
    gitlabNavItem('rocket', 'Deployments') +
    gitlabNavItem('chart', 'Monitor') +
    gitlabNavItem('server', 'Infrastructure') +
    gitlabNavItem('archivebox', 'Packages & Registries') +
    gitlabNavItem('chart', 'Analytics') +
    gitlabNavItem('book', 'Wiki') +
    gitlabNavItem('codebrackets', 'Snippets') +
    '</div>';
  html += `<div class="gl-collapse">${icon('chevrondown', 'gl-collapse-ico')}<span>Collapse sidebar</span></div>`;
  html += '</div>';

  html += '<div class="gl-main">';
  html += '<div class="gl-chrome">';
  html += `<div class="gl-breadcrumb">Workspace <span class="sep">&rsaquo;</span> Project <span class="sep">&rsaquo;</span> Issues <span class="sep">&rsaquo;</span> <strong>#128</strong></div>`;
  html += '<div class="gl-issuehead">' +
    '<span class="gl-status open">Open</span>' +
    '<span class="gl-issuemeta">Created 5 days ago by <span class="gl-avatar-sm">A</span> A. Rivera <span class="gl-role">Developer</span></span>' +
    '<span class="gl-hspacer"></span>' +
    '<span class="gl-closebtn">Close issue</span>' +
    `<span class="gl-tico">${icon('more')}</span>` +
    '</div>';
  html += `<div class="gl-title">Working notes &mdash; internal<span class="gl-edit-ico">${icon('pencil')}</span></div>`;
  html += '</div>';

  html += '<div class="gl-body">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div>';
  html += '</div>';

  html += '<div class="gl-rail">' +
    `<div class="gl-railtop">${icon('chevrondown', 'gl-rail-collapse')}</div>` +
    gitlabRailRow('person', 'Assignee: None') +
    gitlabRailRow('flag', 'Milestone: None') +
    gitlabRailRow('calendar', 'Due date: None') +
    gitlabRailRow('tag', 'Labels: 0') +
    gitlabRailRow('eye', 'Confidential: No') +
    gitlabRailRow('lock', 'Locked: No') +
    gitlabRailRow('person', 'Participants: 1') +
    gitlabRailRow('bell', 'Notifications') +
    gitlabRailRow('clipboard', 'Copy reference') +
    '</div>';

  html += '</div></div>';
  return html;
}

function renderGithub(paras) {
  let html = '<div class="gh-page">';

  html += '<div class="gh-topbar">' +
    `<span class="gh-topico">${icon('hamburger')}</span>` +
    `<span class="gh-brand">${icon('githublogo')}</span>` +
    `<span class="gh-crumb">workspace <span class="sep">/</span> <strong>project</strong>${icon('chevrondown')}</span>` +
    `<span class="gh-search">${icon('search')}<span class="gh-search-ph">Type <kbd>/</kbd> to search</span></span>` +
    '<span class="gh-topbar-spacer"></span>' +
    `<span class="gh-topico">+${icon('chevrondown')}</span>` +
    `<span class="gh-topico">${icon('gitmerge')}</span>` +
    `<span class="gh-topico gh-bell"><span class="gh-badge"></span>${icon('bell')}</span>` +
    '<span class="gh-avatar">U</span>' +
    '</div>';

  html += '<div class="gh-chrome">';
  html += '<div class="gh-filebar">' +
    `<span class="gh-fileico">${icon('folder')}</span>` +
    '<span class="gh-filecrumb">project <span class="sep">/</span> <span class="gh-filename">README.md</span></span>' +
    `<span class="gh-branchpill">${icon('gitbranch')}in main</span>` +
    '<span class="gh-hspacer"></span>' +
    '<span class="gh-cancelbtn">Cancel changes</span>' +
    '<span class="gh-commitbtn">Commit changes&hellip;</span>' +
    '</div>';
  html += '<div class="gh-tabbar">' +
    '<span class="gh-tab">Edit</span><span class="gh-tab active">Preview</span>' +
    '<span class="gh-hspacer"></span>' +
    '<label class="gh-diffcheck"><span class="gh-checkbox"></span>Show diff</label>' +
    '</div>';
  html += '</div>';

  html += '<div class="gh-body markdown-body">';
  html += '<h1>Project Notes</h1>';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div>';

  html += '</div>';
  return html;
}

function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toolGroup(icons) {
  return `<span class="tgrp">${icons.map((i) => `<span class="tico">${i}</span>`).join('')}</span><span class="tdiv"></span>`;
}

function renderSpreadsheet(paras, startIndex = 0) {
  const fontLabel = FONT_LABELS[state.fontFamily] || 'Default';
  const ptSize = Math.max(8, Math.round(state.fontSize * 0.75));

  let html = '<div class="sheet-chrome">';
  html += '<div class="sheet-titlebar">' +
    `<span class="sheet-icon">${icon('googlesheetslogo')}</span><span class="sheet-title">Untitled spreadsheet</span>` +
    `<span class="sheet-star">${icon('star')}</span><span class="sheet-chrome-spacer"></span>` +
    `<span class="sheet-titlebar-ico">${icon('comment')}</span>` +
    `<span class="sheet-share">${icon('lock')} Share <span class="chev">&#9662;</span></span>` +
    '<span class="sheet-avatar">U</span></div>';
  html += '<div class="sheet-menubar">' +
    ['File', 'Edit', 'View', 'Insert', 'Format', 'Data', 'Tools', 'Extensions', 'Help', 'Accessibility']
      .map((m) => `<span>${m}</span>`).join('') + '</div>';
  html += '<div class="sheet-toolbar">' +
    toolGroup([icon('search'), icon('undo'), icon('redo'), icon('print'), icon('paint')]) +
    `<span class="tgrp"><span class="tico twide">100% &#9662;</span></span><span class="tdiv"></span>` +
    toolGroup(['$', '%', '.0', '.00', '123&nbsp;&#9662;']) +
    `<span class="tgrp"><span class="tico twide">${escapeHtml(fontLabel)}&nbsp;&#9662;</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico">&minus;</span><span class="tico tsize">${ptSize}</span><span class="tico">+</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico" style="font-weight:700">B</span><span class="tico" style="font-style:italic">I</span>` +
    `<span class="tico" style="text-decoration:line-through">S</span><span class="tico">A</span></span><span class="tdiv"></span>` +
    toolGroup([icon('fill'), icon('borders'), icon('merge')]) +
    toolGroup([icon('align'), icon('valign'), icon('wrap'), icon('rotate')]) +
    toolGroup([icon('link'), icon('comment'), icon('chart'), icon('filter')]) +
    `<span class="tgrp"><span class="tico">&Sigma;</span><span class="tico">${icon('more')}</span></span>` +
    '</div>';
  html += '<div class="sheet-formulabar"><span class="cell-ref">A1</span><span class="fx"><i>fx</i></span><span class="fx-content"></span></div>';
  html += '<div class="sheet-colheader"><div class="corner"></div>';
  for (let c = 0; c < 13; c++) html += `<div class="col-h">${colLetter(c)}</div>`;
  html += '</div></div>';

  html += '<div class="sheet-grid">';
  paras.forEach((p, i) => {
    html += `<div class="sheet-row"><div class="row-h">${startIndex + i + 1}</div>` +
      `<div class="sheet-cell wide">${escapeHtml(p)}</div>` + '<div class="sheet-cell"></div>'.repeat(12) + '</div>';
  });
  html += '</div>';

  html += `<div class="sheet-tabbar"><span class="tico">+</span><span class="tico">${icon('hamburger')}</span>` +
    '<span class="sheet-tab active">Sheet1 <span class="chev">&#9662;</span></span></div>';
  return html;
}

function renderEmail(paras, startIndex = 0, totalParas = paras.length) {
  let html = '<div class="mail-shell"><div class="mail-nav">';
  html += `<div class="mail-navtop"><span class="mail-hamburger">${icon('hamburger')}</span>` +
    `<span class="mail-logo">${icon('gmaillogo')}Gmail</span></div>`;
  html += `<div class="mail-compose">${icon('pencil')} Compose</div>`;
  html += '<div class="mail-navlist">' +
    `<div class="mail-navitem active">${icon('inboxtray')} Inbox<span class="mail-navcount">72</span></div>` +
    `<div class="mail-navitem">${icon('star')} Starred</div>` +
    `<div class="mail-navitem">${icon('clock')} Snoozed</div>` +
    `<div class="mail-navitem">${icon('send')} Sent</div>` +
    `<div class="mail-navitem">${icon('file')} Drafts<span class="mail-navcount light">5</span></div>` +
    `<div class="mail-navitem">${icon('chevrondown')} Categories</div>` +
    `<div class="mail-navitem sub">${icon('bag')} Purchases</div>` +
    `<div class="mail-navitem">${icon('chevrondown')} More</div>` +
    '</div>';
  html += `<div class="mail-labels-head">Labels<span class="mail-plus">+</span></div>`;
  html += '</div>';

  html += '<div class="mail-main">';
  html += '<div class="mail-chrome">';
  html += '<div class="mail-topbar">' +
    `<span class="mail-search">${icon('search')}<span class="mail-search-ph">Search mail</span>${icon('filter')}</span>` +
    '<span class="mail-topbar-spacer"></span>' +
    `<span class="mail-status"><span class="dot"></span>Active${icon('chevrondown')}</span>` +
    `<span class="mail-topico">${icon('helpcircle')}</span>` +
    `<span class="mail-topico">${icon('gear')}</span>` +
    `<span class="mail-topico">${icon('puzzle')}</span>` +
    `<span class="mail-topico spark">${icon('spark')}</span>` +
    `<span class="mail-topico">${icon('waffle')}</span>` +
    `<span class="mail-avatar">U</span>` +
    '</div>';
  html += '<div class="mail-toolbar">' +
    `<span class="mail-tico">${icon('reply')}</span>` +
    `<span class="mail-tico">${icon('archivebox')}</span>` +
    `<span class="mail-tico">${icon('alertcircle')}</span>` +
    `<span class="mail-tico">${icon('trash')}</span>` +
    '<span class="mail-tdiv"></span>' +
    `<span class="mail-tico">${icon('envelope')}</span>` +
    `<span class="mail-tico">${icon('clock')}</span>` +
    `<span class="mail-tico">${icon('check')}</span>` +
    '<span class="mail-tdiv"></span>' +
    `<span class="mail-tico">${icon('folder')}</span>` +
    `<span class="mail-tico">${icon('tag')}</span>` +
    `<span class="mail-tico">${icon('more')}</span>` +
    '<span class="mail-toolbar-spacer"></span>' +
    `<span class="mail-pageinfo">${Math.min(startIndex + 1, Math.max(totalParas, 1))} of ${totalParas.toLocaleString()}</span>` +
    `<span class="mail-tico small">${icon('chevrondown', 'mail-flip-left')}</span>` +
    `<span class="mail-tico small">${icon('chevrondown', 'mail-flip-right')}</span>` +
    '</div>';
  html += '<div class="mail-subjectrow">' +
    '<span class="mail-subject">Important Update on Ticket SR-103309</span>' +
    `<span class="mail-inbox-chip">Inbox<span class="chip-x">&times;</span></span>` +
    '<span class="mail-subjrow-spacer"></span>' +
    `<span class="mail-tico">${icon('expand')}</span>` +
    `<span class="mail-tico">${icon('print')}</span>` +
    `<span class="mail-tico">${icon('popout')}</span>` +
    '</div>';
  html += `<div class="mail-summarize">${icon('spark')}Summarize this email</div>`;
  html += '<div class="mail-sender-row">' +
    '<div class="mail-sender-avatar">G</div>' +
    '<div class="mail-sender-meta">' +
    `<div class="mail-sender-name">The Gmail Team<span class="mail-sender-addr">&lt;mail-noreply@google.com&gt;</span></div>` +
    `<div class="mail-sender-to">to me${icon('chevrondown')}</div>` +
    '</div>' +
    '<span class="mail-sender-date">Wed, Aug 19, 12:10 PM (5 days ago)</span>' +
    `<span class="mail-tico">${icon('star')}</span>` +
    `<span class="mail-tico">${icon('smiley')}</span>` +
    `<span class="mail-tico">${icon('reply')}</span>` +
    `<span class="mail-tico">${icon('more')}</span>` +
    '</div>';
  html += '</div>';

  html += '<div class="mail-body">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '<div class="mail-footer-note">This message is for the designated recipient only and may contain confidential ' +
    'and/or privileged information. If you have received it in error, please delete it and advise the sender immediately. ' +
    'You should not copy or use it for any other purpose, nor disclose contents to any other person</div>';
  html += '<div class="mail-footer-actions">' +
    `<span class="mail-fbtn">${icon('reply')}Reply</span>` +
    `<span class="mail-fbtn">${icon('forward')}Forward</span>` +
    `<span class="mail-fbtn icon-only">${icon('smiley')}</span>` +
    `<span class="mail-fbtn">${icon('comment')}Share in chat</span>` +
    '</div>';
  html += '</div>';
  html += '</div>';

  html += '<div class="mail-iconrail">' +
    `<span class="mail-rail-badge">${icon('calendar')}<span class="mail-rail-num">31</span></span>` +
    '<div class="mail-rail-group">' +
    `<span class="mail-rail-ico">${icon('lightbulb')}</span>` +
    `<span class="mail-rail-ico circle">${icon('check')}</span>` +
    `<span class="mail-rail-ico">${icon('person')}</span>` +
    '</div>' +
    '<span class="mail-rail-plus">+</span>' +
    '</div>';
  html += '</div>';
  return html;
}

function docsTabItem(label, level, active) {
  return `<div class="docs-tab-item level${level}${active ? ' active' : ''}">${label}</div>`;
}

function renderDocs(paras) {
  const fontLabel = FONT_LABELS[state.fontFamily] || 'Arial';
  const ruleNums = [1, 2, 3, 4, 5, 6, 7].map((n) => `<span>${n}</span>`).join('');

  let html = '<div class="docs-shell"><div class="docs-sidebar">';
  html += `<div class="docs-sidebar-header"><span class="docs-back">&#8592;</span>Document tabs<span class="docs-plus">+</span></div>`;
  html += '<div class="docs-tabtree">' +
    docsTabItem('Tab 1', 0) +
    docsTabItem('Working Notes', 1) +
    docsTabItem('Overview', 2, true) +
    docsTabItem('Objectives', 2) +
    docsTabItem('Details', 2) +
    docsTabItem('Reference Material', 1) +
    docsTabItem('Overview', 2) +
    docsTabItem('Technical Notes', 1) +
    docsTabItem('Timeline', 1) +
    docsTabItem('Milestones', 2) +
    docsTabItem('Checklist', 3) +
    '</div></div>';

  html += '<div class="docs-main">';
  html += '<div class="docs-chrome">';
  html += '<div class="docs-titlebar">' +
    `<span class="docs-icon">${icon('googledocslogo')}</span>` +
    '<span class="docs-title">Working Notes</span>' +
    `<span class="docs-ico">${icon('mention')}</span>` +
    `<span class="docs-ico">${icon('star')}</span>` +
    `<span class="docs-ico">${icon('folder')}</span>` +
    `<span class="docs-ico">${icon('cloudsaved')}</span>` +
    '<span class="docs-chrome-spacer"></span>' +
    `<span class="docs-ico">${icon('clock')}</span>` +
    `<span class="docs-ico">${icon('comment')}</span>` +
    `<span class="docs-share">${icon('lock')} Share <span class="chev">&#9662;</span></span>` +
    '<span class="docs-avatar">U</span></div>';
  html += '<div class="docs-toolbar">' +
    `<span class="docs-menus">${icon('search')} Menus</span>` +
    toolGroup([icon('undo'), icon('redo'), icon('print'), icon('check'), icon('paint')]) +
    `<span class="tgrp"><span class="tico twide">100% &#9662;</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico twide">Normal text &#9662;</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico twide">${escapeHtml(fontLabel)} &#9662;</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico">&minus;</span><span class="tico tsize">10</span><span class="tico">+</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico" style="font-weight:700">B</span><span class="tico" style="font-style:italic">I</span>` +
    `<span class="tico" style="text-decoration:underline">U</span><span class="tico">A</span></span><span class="tdiv"></span>` +
    toolGroup([icon('highlight'), icon('link'), icon('comment')]) +
    `<span class="tgrp"><span class="tico">+</span><span class="tico">${icon('imageicon')}</span></span><span class="tdiv"></span>` +
    `<span class="tgrp"><span class="tico">${icon('align')}</span><span class="tico">${icon('valign')}</span>` +
    `<span class="tico">${icon('checklist')}</span><span class="tico">${icon('bullets')}</span><span class="tico">${icon('numbered')}</span>` +
    `<span class="tico">${icon('outdent')}</span><span class="tico">${icon('indent')}</span>` +
    `<span class="tico">${icon('clearformat')}</span></span>` +
    '<span class="tgrp docs-editing"><span class="tico">' + icon('pencil') + ' Editing <span class="chev">&#9662;</span></span></span>' +
    `<span class="tico docs-toolbar-collapse-wrap">${icon('chevrondown', 'docs-toolbar-collapse')}</span>` +
    '</div>';
  html += `<div class="docs-ruler"><div class="docs-ruler-ticks"></div><div class="docs-ruler-nums">${ruleNums}</div>` +
    `<span class="docs-ruler-marker left">${icon('rulermarker')}</span><span class="docs-ruler-marker right">${icon('rulermarker')}</span></div>`;
  html += '</div>';

  html += `<div class="docs-iconrail">` +
    `<span class="docs-rail-ico">${icon('lightbulb')}</span>` +
    `<span class="docs-rail-ico docs-rail-circle">${icon('check')}</span>` +
    `<span class="docs-rail-ico">${icon('person')}</span>` +
    `<span class="docs-rail-ico">${icon('mappin')}</span>` +
    `<span class="docs-rail-ico">${icon('waffle')}</span>` +
    `<span class="docs-rail-ico docs-rail-plus">+</span>` +
    '</div>';

  const PAGE_BREAK_SIZE = 7;
  const chunks = [];
  for (let i = 0; i < paras.length; i += PAGE_BREAK_SIZE) chunks.push(paras.slice(i, i + PAGE_BREAK_SIZE));
  if (chunks.length === 0) chunks.push([]);

  chunks.forEach((chunk, ci) => {
    const isLast = ci === chunks.length - 1;
    html += `<div class="docs-page${isLast ? ' last' : ''}">`;
    if (ci === 0) {
      html += '<div class="docs-heading">Overview</div>';
    }
    html += '<div class="docs-text">';
    chunk.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
    html += '</div></div>';
  });

  html += '</div></div>';
  return html;
}

function renderClaude(paras) {
  const chats = ['Reading notes', 'Quarterly planning', 'Draft outline', 'Research summary', 'Follow-up questions'];
  let html = '<div class="claude-shell"><div class="claude-sidebar">';
  html += `<div class="claude-brand"><span class="claude-mark">${icon('sunburst')}</span> Claude</div>`;
  html += '<div class="claude-tabs"><span class="active">Home</span><span>Code</span></div>';
  html += '<div class="claude-newbtn">+ New</div>';
  html += '<div class="claude-nav">' +
    '<div class="claude-nav-item">Projects</div><div class="claude-nav-item">Artifacts</div>' +
    '<div class="claude-nav-item">Scheduled</div><div class="claude-nav-item">Customize</div></div>';
  html += '<div class="claude-section-label">Chats and tasks</div><div class="claude-history">';
  chats.forEach((t, i) => { html += `<div class="claude-hist-item${i === 0 ? ' active' : ''}">${t}</div>`; });
  html += '</div>';
  html += '<div class="claude-profile"><span class="claude-avatar-sm">U</span><span>You &middot; Pro</span></div>';
  html += '</div>';
  html += '<div class="claude-main">';
  html += '<div class="claude-chrome"><div class="claude-chat-title">Reading notes <span class="chev">&#9662;</span></div>' +
    '<div class="claude-share">Share</div></div>';
  html += '<div class="claude-response">';
  html += '<div class="claude-user-msg">Can you walk me through this in detail, section by section?</div>';
  html += '<div class="claude-thought">Thought for 9s</div>';
  html += '<div class="claude-response-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  html += '<div class="claude-inputbar"><div class="claude-inputbox">' +
    '<div class="claude-inputbox-placeholder">Write a message&hellip;</div>' +
    '<div class="claude-inputbox-row"><span class="claude-plus">+</span><span class="claude-inputbar-spacer"></span>' +
    '<span class="claude-model">Opus 5</span><span class="claude-effort">High <span class="chev">&#9662;</span></span>' +
    '<span class="claude-mic"></span>' +
    '<span class="claude-wave"><span></span><span></span><span></span><span></span></span>' +
    '</div></div>' +
    '<div class="claude-disclaimer">Claude is AI and can make mistakes. Please double-check responses.</div></div>';
  html += '</div></div>';
  return html;
}

function renderGpt(paras) {
  const chats = ['Set phone alarms', 'Remove duplicate items', 'Draft outline', 'Trip planning', 'Book notes'];
  let html = '<div class="gpt-shell"><div class="gpt-sidebar">';
  html += '<div class="gpt-brand">ChatGPT</div>';
  html += `<div class="gpt-newbtn">${icon('pencil')} New chat</div>`;
  html += '<div class="gpt-nav">' +
    '<div class="gpt-nav-item">Images</div><div class="gpt-nav-item">Library</div>' +
    '<div class="gpt-nav-item">Projects</div><div class="gpt-nav-item">Codex</div>' +
    '<div class="gpt-nav-item">More</div></div>';
  html += '<div class="gpt-section-label">Recents</div><div class="gpt-history">';
  chats.forEach((t, i) => { html += `<div class="gpt-hist-item${i === 0 ? ' active' : ''}">${t}</div>`; });
  html += '</div>';
  html += '<div class="gpt-profile"><span class="gpt-avatar-sm">U</span><span>You &middot; Free</span></div>';
  html += '</div>';
  html += '<div class="gpt-main">';
  html += '<div class="gpt-chrome"><div class="gpt-chrome-spacer"></div><div class="gpt-share">Share</div><div class="gpt-more">&hellip;</div></div>';
  html += '<div class="gpt-response">';
  html += '<div class="gpt-user-msg">Can you explain this in detail?</div>';
  html += '<div class="gpt-response-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  html += '<div class="gpt-inputbar"><div class="gpt-inputbox">' +
    '<span class="gpt-plus">+</span><span class="gpt-inputbox-placeholder">Ask anything</span>' +
    '<span class="gpt-inputbar-spacer"></span>' +
    '<span class="gpt-think"><span class="gpt-think-dot"></span> Think</span>' +
    '<span class="gpt-mic"></span>' +
    '<span class="gpt-voice-btn"><span class="gpt-wave"><span></span><span></span><span></span></span></span>' +
    '</div>' +
    '<div class="gpt-disclaimer">ChatGPT can make mistakes. Check important info.</div></div>';
  html += '</div></div>';
  return html;
}

const RENDERERS = {
  prdiff: renderPrDiff,
  gitlab: renderGitlab,
  github: renderGithub,
  spreadsheet: renderSpreadsheet,
  docs: renderDocs,
  email: renderEmail,
  claude: renderClaude,
  gpt: renderGpt
};

function applyFontSize() {
  // A real ancestor font-size (not one set via inline style on #content
  // alone) is what theme paragraph rules read via calc(var(--reader-font-size) * …) —
  // rem units on those rules would otherwise ignore this entirely.
  contentEl.style.setProperty('--reader-font-size', state.fontSize + 'px');
}

function applyFontFamily() {
  if (state.fontFamily && FONT_STACKS[state.fontFamily]) {
    document.documentElement.style.setProperty('--office-font-body', FONT_STACKS[state.fontFamily]);
  } else {
    document.documentElement.style.removeProperty('--office-font-body');
  }
  fontFamilySelect.value = state.fontFamily || '';
}

const controlsEl = document.getElementById('controls');
let controlsCollapsed = false;

// Themes with their own fake bottom input bar (Claude, ChatGPT) need to know
// the real control bar's actual height so their sticky positioning clears it
// instead of guessing a fixed pixel gap — the real bar's height changes when
// the font-family picker shows/hides or the bar wraps on narrow screens.
// When the bar is collapsed, both the sticky offset and the bottom padding
// every theme reserves collapse down too, so hiding the bar actually frees
// the screen for full-screen reading instead of leaving a dead gap.
function updateControlsSpacing() {
  if (controlsCollapsed) {
    contentEl.style.setProperty('--controls-h', '0px');
    contentEl.style.setProperty('--content-bottom-pad', '1.5rem');
  } else {
    contentEl.style.setProperty('--controls-h', controlsEl.offsetHeight + 'px');
    contentEl.style.setProperty('--content-bottom-pad', '8rem');
  }
}

function setControlsCollapsed(collapsed) {
  controlsCollapsed = collapsed;
  controlsEl.classList.toggle('collapsed', collapsed);
  controlsHandle.classList.toggle('show', collapsed);
  updateControlsSpacing();
}

function totalPageGroups(allParasLength) {
  return Math.max(1, Math.ceil(allParasLength / PAGE_SIZE));
}

function clampPageGroup(allParasLength) {
  const total = totalPageGroups(allParasLength);
  state.pageGroup = Math.min(Math.max(0, state.pageGroup || 0), total - 1);
}

function updatePaginationUI(allParasLength) {
  pageToggleBtn.textContent = state.paginated ? 'Pagination: On' : 'Pagination: Off';
  const show = state.paginated ? 'inline-block' : 'none';
  prevPageBtn.style.display = show;
  nextPageBtn.style.display = show;
  pageIndicator.style.display = state.paginated ? 'inline' : 'none';
  if (!state.paginated) return;
  const total = totalPageGroups(allParasLength);
  pageIndicator.textContent = `Page ${state.pageGroup + 1} / ${total}`;
  prevPageBtn.disabled = state.pageGroup <= 0;
  nextPageBtn.disabled = state.pageGroup >= total - 1;
}

function goToPage(delta) {
  if (!state.paginated) return;
  const allParas = paragraphsOf(state.text);
  const total = totalPageGroups(allParas.length);
  const next = Math.min(Math.max(0, state.pageGroup + delta), total - 1);
  if (next === state.pageGroup) return;
  state.pageGroup = next;
  render();
  schedulePersist();
}

function render() {
  document.body.className = 'theme-' + state.theme;
  document.title = TAB_TITLES[state.theme] || 'notes';
  panicText.textContent = PANIC_LABELS[state.theme] || 'Loading…';
  applyFontSize();
  applyFontFamily();
  fontFamilyGroup.style.display = OFFICE_THEMES.has(state.theme) ? 'flex' : 'none';

  const allParas = paragraphsOf(state.text);
  const renderer = RENDERERS[state.theme] || renderGitlab;

  let startIndex = 0;
  let visibleParas = allParas;
  if (state.paginated) {
    clampPageGroup(allParas.length);
    startIndex = state.pageGroup * PAGE_SIZE;
    visibleParas = allParas.slice(startIndex, startIndex + PAGE_SIZE);
  }
  contentEl.innerHTML = renderer(visibleParas, startIndex, allParas.length);

  pageInfo.textContent = state.name ? `${state.name} · ${allParas.length} sections` : '';
  updatePaginationUI(allParas.length);
  updateControlsSpacing();
  restoreScroll();
}

window.addEventListener('resize', () => {
  if (readerEl.classList.contains('active')) updateControlsSpacing();
});

function restoreScroll() {
  requestAnimationFrame(() => {
    if (state.paginated) {
      contentEl.scrollTop = 0;
    } else {
      const max = contentEl.scrollHeight - contentEl.clientHeight;
      contentEl.scrollTop = max > 0 ? max * state.scrollPct : 0;
    }
    updateProgress();
  });
}

function updateProgress() {
  if (state.paginated) {
    const allParasLength = paragraphsOf(state.text).length;
    const total = totalPageGroups(allParasLength);
    const pct = total > 1 ? state.pageGroup / (total - 1) : 0;
    progressFill.style.width = Math.min(100, Math.max(0, pct * 100)) + '%';
    return;
  }
  const max = contentEl.scrollHeight - contentEl.clientHeight;
  const pct = max > 0 ? contentEl.scrollTop / max : 0;
  progressFill.style.width = Math.min(100, Math.max(0, pct * 100)) + '%';
  state.scrollPct = pct;
}

function openReader() {
  landing.style.display = 'none';
  readerEl.classList.add('active');
  themeSelect.value = state.theme;
  // Normalize state coming from a resumed save that predates pagination
  // (paginated will be undefined there) as well as a fresh book.
  state.paginated = state.paginated !== false;
  state.pageGroup = state.pageGroup || 0;
  setControlsCollapsed(false);
  render();
  contentEl.focus();
}

function resetDropzone() {
  dropzoneMain.textContent = 'Drop a .pdf here, or click to browse';
  dropzoneSub.textContent = 'Extraction happens locally — the file never leaves this tab.';
}

async function loadFile(file) {
  if (!file || extracting) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    dropzoneSub.textContent = 'Please choose a .pdf file.';
    return;
  }
  extracting = true;
  dropzone.classList.add('busy');
  setExtractProgress(0, 1);
  try {
    const text = await extractPdfText(file);
    state.text = text;
    state.name = file.name.replace(/\.pdf$/i, '');
    state.scrollPct = 0;
    persist();
    openReader();
  } catch (err) {
    dropzoneMain.textContent = 'Could not read that PDF.';
    dropzoneSub.textContent = err && err.message ? err.message : 'Try a different file.';
  } finally {
    extracting = false;
    dropzone.classList.remove('busy');
    resetDropzone();
  }
}

dropzone.addEventListener('click', () => { if (!extracting) fileInput.click(); });
dropzone.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && !extracting) { e.preventDefault(); fileInput.click(); }
});
['dragover', 'dragenter'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]);
});

(async function initResume() {
  await migrateLegacyStorage();

  const savedMeta = loadMeta();
  if (!savedMeta) return;

  resumeRow.classList.add('show');
  resumeRow.querySelector('strong').textContent = savedMeta.name || 'your book';
  resumeBtn.addEventListener('click', async () => {
    resumeBtn.disabled = true;
    resumeBtn.textContent = 'Loading…';
    const text = await idbGetText();
    if (text) {
      state = { ...savedMeta, text };
      openReader();
    } else {
      resumeRow.classList.remove('show');
      safeRemove(META_KEY);
    }
  });
  discardBtn.addEventListener('click', () => {
    clearSaved();
    resumeRow.classList.remove('show');
  });
})();

themeSelect.addEventListener('change', () => {
  state.theme = themeSelect.value;
  render();
  schedulePersist();
});

loadNewBtn.addEventListener('click', () => {
  readerEl.classList.remove('active');
  landing.style.display = 'flex';
  fileInput.value = '';
  resetDropzone();
});

fontUpBtn.addEventListener('click', () => {
  state.fontSize = Math.min(26, state.fontSize + 1);
  applyFontSize();
  if (state.theme === 'spreadsheet') render();
  schedulePersist();
});
fontDownBtn.addEventListener('click', () => {
  state.fontSize = Math.max(12, state.fontSize - 1);
  applyFontSize();
  if (state.theme === 'spreadsheet') render();
  schedulePersist();
});

pageToggleBtn.addEventListener('click', () => {
  state.paginated = !state.paginated;
  if (state.paginated) clampPageGroup(paragraphsOf(state.text).length);
  render();
  schedulePersist();
});
prevPageBtn.addEventListener('click', () => goToPage(-1));
nextPageBtn.addEventListener('click', () => goToPage(1));

fontFamilySelect.addEventListener('change', () => {
  state.fontFamily = fontFamilySelect.value;
  applyFontFamily();
  if (state.theme === 'spreadsheet') render();
  schedulePersist();
});

contentEl.addEventListener('scroll', () => {
  updateProgress();
  schedulePersist();
});

function togglePanic() {
  panicOn = !panicOn;
  panicOverlay.classList.toggle('show', panicOn);
}
panicOverlay.addEventListener('click', togglePanic);
hideBtn.addEventListener('click', togglePanic);

// The inert parts of the control bar (labels, the book title/section count,
// the empty spacer) double as a big, fast target for collapsing the bar
// itself — distinct from Esc/"Hide", which blank the whole screen. This
// just tucks the toolbar away so reading is full-screen; the small handle
// that appears at the bottom center brings it back.
document.querySelectorAll('.shell-label, #pageInfo, .ctrl-spacer').forEach((el) => {
  el.classList.add('hide-zone');
  el.addEventListener('click', () => setControlsCollapsed(true));
});
controlsHandle.addEventListener('click', () => setControlsCollapsed(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { togglePanic(); return; }
  if (!readerEl.classList.contains('active') || panicOn) return;
  if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    if (state.paginated) goToPage(1);
    else contentEl.scrollBy({ top: contentEl.clientHeight * 0.85, behavior: 'smooth' });
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    if (state.paginated) goToPage(-1);
    else contentEl.scrollBy({ top: -contentEl.clientHeight * 0.85, behavior: 'smooth' });
  }
});

window.addEventListener('beforeunload', () => {
  // Guard against wiping a real saved book with blank defaults: if this
  // session never loaded/resumed a book, state.text is still '' and there
  // is nothing meaningful to persist.
  if (state.text) persist();
});
