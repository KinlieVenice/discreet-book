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

let state = { text: '', name: '', theme: 'coding', fontSize: 17, fontFamily: '', scrollPct: 0, paginated: true, pageGroup: 0 };
let panicOn = false;
let saveTimer = null;
let extracting = false;

// Only the "Office" and "AI Chat" group themes expose a font-family picker —
// engineering themes (code/terminal/diff/man page) stay fixed-monospace,
// same as a real editor or terminal wouldn't let you pick a document font.
const OFFICE_THEMES = new Set([
  'business', 'data', 'spreadsheet', 'docs', 'email', 'memo', 'slides', 'ticket', 'hrpolicy', 'claude', 'gpt'
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
  coding: 'Installing dependencies…',
  business: 'Loading document…',
  data: 'Refreshing report…',
  terminal: 'Reconnecting…',
  prdiff: 'Fetching diff…',
  manpage: 'Loading manual…',
  spreadsheet: 'Recalculating…',
  docs: 'Saving…',
  email: 'Checking for new mail…',
  memo: 'Loading document…',
  slides: 'Loading presentation…',
  ticket: 'Loading ticket…',
  hrpolicy: 'Loading document…',
  claude: 'Thinking…',
  gpt: 'Generating…'
};

const TAB_TITLES = {
  coding: 'notes.md — Visual Studio Code',
  business: 'Draft Proposal.docx',
  data: 'Weekly Report',
  terminal: 'app.log',
  prdiff: 'Pull Request #482',
  manpage: 'notes(1) — Manual Page',
  spreadsheet: 'Q3 Working Notes.xlsx',
  docs: 'Working Notes - Google Docs',
  email: 'Inbox',
  memo: 'Meeting Minutes.docx',
  slides: 'Notes — Slide Deck',
  ticket: 'Ticket #10482',
  hrpolicy: 'Employee Handbook.pdf',
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

function kpi(label, value, up) {
  return `<div class="kpi"><div class="kpi-label">${label}</div>` +
    `<div class="kpi-value${up ? ' up' : ''}">${value}</div></div>`;
}

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
  }
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

function renderCoding(paras) {
  let html = '<div class="code-chrome">';
  html += '<div class="code-titlebar"><div class="code-tab active">notes.md</div>' +
    '<div class="code-tab">README.md</div><div class="code-tab">TODO.md</div></div>';
  html += '<div class="code-fileheader">/**<br>&nbsp;* @fileoverview Internal working notes<br>&nbsp;* @private<br>&nbsp;*/</div>';
  html += '</div>';
  html += '<div class="code-body"><div class="gutter">';
  for (let i = 0; i < paras.length; i++) html += '<span>&nbsp;</span>';
  html += '</div><div class="code-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderBusiness(paras) {
  let html = '<div class="doc-chrome"><div class="doc-kicker"><span>Strategic Planning &mdash; Internal Draft</span><span>Confidential</span></div>' +
    '<div class="doc-chrome-title">Proposal: Q4 Initiative Notes</div></div>';
  html += '<div class="doc-page"><div class="doc-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderData(paras) {
  let html = '<div class="dash-shell"><div class="dash-sidebar">';
  ['Overview', 'Reports', 'Metrics', 'Notes', 'Settings'].forEach((item, idx) => {
    html += `<div class="item${idx === 3 ? ' active' : ''}">${item}</div>`;
  });
  html += '</div><div class="dash-main">';
  html += '<div class="dash-kpis">' +
    kpi('Sessions', '18,204', true) + kpi('Conv. rate', '4.7%', false) +
    kpi('Avg. time', '6m 12s', true) + kpi('Bounce', '31.2%', false) + '</div>';
  html += '<div class="dash-panel"><div class="dash-panel-title">Report notes</div><div class="dash-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div></div></div>';
  return html;
}

function renderTerminal(paras) {
  let html = '<div class="term-header"><span class="prompt-sign">$</span>tail -f app.log</div>';
  html += '<div class="term-body">';
  const levels = ['info', 'debug', 'debug', 'warn', 'info'];
  let t = 0;
  paras.forEach((p, i) => {
    t += 4 + (i % 7);
    const hh = String(9 + Math.floor(t / 3600) % 6).padStart(2, '0');
    const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    const level = levels[i % levels.length];
    html += `<div class="term-line"><span class="term-meta">[${hh}:${mm}:${ss}]</span> ` +
      `<span class="term-level-${level}">${level.toUpperCase().padEnd(5)}</span> ${escapeHtml(p)}</div>`;
  });
  html += '</div>';
  return html;
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

function renderManpage(paras) {
  let html = '<div class="man-bar"><span>NOTES(1)</span><span>General Commands Manual</span><span>NOTES(1)</span></div>';
  html += '<div class="man-body">';
  html += '<div class="man-section">NAME</div><p>notes &mdash; internal working notes</p>';
  html += '<div class="man-section">DESCRIPTION</div>';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
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
    `<span class="sheet-icon">${icon('borders')}</span><span class="sheet-title">Untitled spreadsheet</span>` +
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

function renderEmail(paras) {
  const subjects = ['Re: Q3 planning sync', 'Team offsite logistics', 'FYI: policy update', 'Weekly status', 'Follow-up notes'];
  let html = '<div class="mail-shell"><div class="mail-list">';
  subjects.forEach((s, i) => {
    html += `<div class="mail-item${i === 0 ? ' active' : ''}"><div class="mail-item-subj">${s}</div><div class="mail-item-preview">Open to read the full thread…</div></div>`;
  });
  html += '</div><div class="mail-reading">';
  html += '<div class="mail-chrome"><div class="mail-subject">Re: Q3 planning sync</div>' +
    '<div class="mail-meta"><span class="mail-sender">Team Notes &lt;notes@internal&gt;</span><span class="mail-date">9:14 AM</span></div></div>';
  html += '<div class="mail-body">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div></div>';
  return html;
}

function renderMemo(paras) {
  let html = '<div class="memo-chrome"><div class="memo-title">Meeting Minutes</div>' +
    '<div class="memo-meta"><div><strong>Date:</strong> Today</div><div><strong>Attendees:</strong> J. Ramirez, T. Okafor, P. Singh</div></div></div>';
  html += '<div class="memo-page"><div class="memo-section-label">Notes</div>';
  html += '<div class="memo-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderSlides(paras) {
  let html = '<div class="slides-chrome"><div class="slides-strip">';
  for (let i = 0; i < 5; i++) {
    html += `<div class="slide-thumb${i === 1 ? ' active' : ''}"><span></span><span></span></div>`;
  }
  html += '</div><div class="slides-notes-label">Speaker Notes &mdash; Slide 2</div></div>';
  html += '<div class="slides-notes-wrap"><div class="slides-notes">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderTicket(paras, startIndex = 0) {
  let html = '<div class="ticket-chrome">';
  html += '<div class="ticket-header"><span class="ticket-id">#10482</span><span class="ticket-status">Open</span><span class="ticket-priority">Normal</span></div>';
  html += '<div class="ticket-subject">Working notes &mdash; internal</div>';
  html += '</div>';
  html += '<div class="ticket-thread">';
  paras.forEach((p, i) => {
    html += `<div class="ticket-comment"><div class="ticket-avatar"></div><div class="ticket-comment-body">` +
      `<div class="ticket-comment-meta">Internal note &middot; ${startIndex + i + 1}</div><p>${escapeHtml(p)}</p></div></div>`;
  });
  html += '</div>';
  return html;
}

function renderHrPolicy(paras, startIndex = 0) {
  let html = '<div class="hr-chrome"><div class="hr-title">Employee Handbook</div><div class="hr-effective">Effective Date: This Year</div></div>';
  html += '<div class="hr-page"><div class="hr-section-label">Section 4 &mdash; Working Notes</div>';
  html += '<div class="hr-text">';
  paras.forEach((p, i) => { html += `<p><span class="hr-num">4.${startIndex + i + 1}</span>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
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
    docsTabItem('Draft Outline', 1) +
    docsTabItem('Overview', 1, true) +
    docsTabItem('Objectives', 1) +
    docsTabItem('Notes', 1) +
    docsTabItem('Appendix', 0) +
    docsTabItem('Overview', 1) +
    docsTabItem('References', 1) +
    docsTabItem('Revisions', 1) +
    docsTabItem('Changelog', 1) +
    '</div></div>';

  html += '<div class="docs-main">';
  html += '<div class="docs-chrome">';
  html += '<div class="docs-titlebar">' +
    `<span class="docs-icon">${icon('file')}</span>` +
    '<span class="docs-title">Working Notes</span>' +
    `<span class="docs-ico">${icon('star')}</span><span class="docs-chrome-spacer"></span>` +
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
    toolGroup([icon('paint'), icon('link'), icon('comment')]) +
    `<span class="tgrp"><span class="tico">${icon('align')}</span><span class="tico">${icon('valign')}</span>` +
    `<span class="tico">${icon('bullets')}</span><span class="tico">${icon('bullets')}</span>` +
    `<span class="tico" style="display:inline-block;transform:scaleX(-1)">${icon('indent')}</span><span class="tico">${icon('indent')}</span></span>` +
    '<span class="tgrp docs-editing"><span class="tico">' + icon('pencil') + ' Editing <span class="chev">&#9662;</span></span></span>' +
    '</div>';
  html += `<div class="docs-ruler"><div class="docs-ruler-ticks"></div><div class="docs-ruler-nums">${ruleNums}</div>` +
    '<span class="docs-ruler-marker left">&#9660;</span><span class="docs-ruler-marker right">&#9660;</span></div>';
  html += '</div>';

  html += '<div class="docs-page"><div class="docs-heading">Overview</div><div class="docs-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
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
  coding: renderCoding,
  business: renderBusiness,
  data: renderData,
  terminal: renderTerminal,
  prdiff: renderPrDiff,
  manpage: renderManpage,
  spreadsheet: renderSpreadsheet,
  docs: renderDocs,
  email: renderEmail,
  memo: renderMemo,
  slides: renderSlides,
  ticket: renderTicket,
  hrpolicy: renderHrPolicy,
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
  const renderer = RENDERERS[state.theme] || renderCoding;

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
