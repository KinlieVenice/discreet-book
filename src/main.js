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

let state = { text: '', name: '', theme: 'coding', fontSize: 17, fontFamily: '', scrollPct: 0 };
let panicOn = false;
let saveTimer = null;
let extracting = false;

// Only the "Office" and "AI Chat" group themes expose a font-family picker —
// engineering themes (code/terminal/diff/man page) stay fixed-monospace,
// same as a real editor or terminal wouldn't let you pick a document font.
const OFFICE_THEMES = new Set([
  'business', 'data', 'spreadsheet', 'email', 'memo', 'slides', 'ticket', 'hrpolicy', 'claude', 'gpt'
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
    fontFamily: state.fontFamily, scrollPct: state.scrollPct
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

function renderPrDiff(paras) {
  let html = '<div class="diff-chrome">';
  html += '<div class="diff-file-header">📄 notes/reading.md &nbsp; <span class="diff-badge">+' + paras.length + '&nbsp;&minus;0</span></div>';
  html += `<div class="diff-hunk-marker">@@ -0,0 +1,${paras.length} @@</div>`;
  html += '</div>';
  html += '<div class="diff-file">';
  paras.forEach((p, i) => {
    html += `<div class="diff-row"><div class="diff-gutter">${i + 1}</div><div class="diff-linecontent">${escapeHtml(p)}</div></div>`;
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

function renderSpreadsheet(paras) {
  const fontLabel = FONT_LABELS[state.fontFamily] || 'Calibri';
  const ptSize = Math.max(8, Math.round(state.fontSize * 0.75));
  let html = '<div class="sheet-chrome">';
  html += '<div class="sheet-ribbon">' +
    '<div class="ribbon-tabs"><span class="active">Home</span><span>Insert</span><span>Page Layout</span><span>Formulas</span><span>Data</span><span>Review</span><span>View</span></div>' +
    `<div class="ribbon-tools"><span>${escapeHtml(fontLabel)}</span><span>${ptSize}</span><span class="ico">B</span><span class="ico">I</span><span class="ico">U</span><span class="ico">▤</span><span class="ico">%</span></div>` +
    '</div>';
  html += '<div class="sheet-formulabar"><span class="cell-ref">A1</span><span class="fx">fx</span><span class="fx-content"></span></div>';
  html += '<div class="sheet-colheader"><div class="corner"></div>';
  for (let c = 0; c < 3; c++) html += `<div class="col-h">${colLetter(c)}</div>`;
  html += '</div></div>';
  html += '<div class="sheet-grid">';
  paras.forEach((p, i) => {
    html += `<div class="sheet-row"><div class="row-h">${i + 1}</div>` +
      `<div class="sheet-cell wide">${escapeHtml(p)}</div><div class="sheet-cell"></div><div class="sheet-cell"></div></div>`;
  });
  html += '</div>';
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

function renderTicket(paras) {
  let html = '<div class="ticket-chrome">';
  html += '<div class="ticket-header"><span class="ticket-id">#10482</span><span class="ticket-status">Open</span><span class="ticket-priority">Normal</span></div>';
  html += '<div class="ticket-subject">Working notes &mdash; internal</div>';
  html += '</div>';
  html += '<div class="ticket-thread">';
  paras.forEach((p, i) => {
    html += `<div class="ticket-comment"><div class="ticket-avatar"></div><div class="ticket-comment-body">` +
      `<div class="ticket-comment-meta">Internal note &middot; ${i + 1}</div><p>${escapeHtml(p)}</p></div></div>`;
  });
  html += '</div>';
  return html;
}

function renderHrPolicy(paras) {
  let html = '<div class="hr-chrome"><div class="hr-title">Employee Handbook</div><div class="hr-effective">Effective Date: This Year</div></div>';
  html += '<div class="hr-page"><div class="hr-section-label">Section 4 &mdash; Working Notes</div>';
  html += '<div class="hr-text">';
  paras.forEach((p, i) => { html += `<p><span class="hr-num">4.${i + 1}</span>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderClaude(paras) {
  const chats = ['Reading notes', 'Quarterly planning', 'Draft outline', 'Research summary', 'Follow-up questions'];
  let html = '<div class="claude-shell"><div class="claude-sidebar">';
  html += '<div class="claude-brand"><span class="claude-mark">&#10038;</span> Claude</div>';
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
  html += '</div></div></div></div>';
  return html;
}

function renderGpt(paras) {
  const chats = ['Set phone alarms', 'Remove duplicate items', 'Draft outline', 'Trip planning', 'Book notes'];
  let html = '<div class="gpt-shell"><div class="gpt-sidebar">';
  html += '<div class="gpt-brand">ChatGPT</div>';
  html += '<div class="gpt-newbtn">&#9998; New chat</div>';
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
  html += '</div></div></div></div>';
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

function render() {
  document.body.className = 'theme-' + state.theme;
  document.title = TAB_TITLES[state.theme] || 'notes';
  panicText.textContent = PANIC_LABELS[state.theme] || 'Loading…';
  applyFontSize();
  applyFontFamily();
  fontFamilyGroup.style.display = OFFICE_THEMES.has(state.theme) ? 'flex' : 'none';

  const paras = paragraphsOf(state.text);
  const renderer = RENDERERS[state.theme] || renderCoding;
  contentEl.innerHTML = renderer(paras);

  pageInfo.textContent = state.name ? `${state.name} · ${paras.length} sections` : '';
  restoreScroll();
}

function restoreScroll() {
  requestAnimationFrame(() => {
    const max = contentEl.scrollHeight - contentEl.clientHeight;
    contentEl.scrollTop = max > 0 ? max * state.scrollPct : 0;
    updateProgress();
  });
}

function updateProgress() {
  const max = contentEl.scrollHeight - contentEl.clientHeight;
  const pct = max > 0 ? contentEl.scrollTop / max : 0;
  progressFill.style.width = Math.min(100, Math.max(0, pct * 100)) + '%';
  state.scrollPct = pct;
}

function openReader() {
  landing.style.display = 'none';
  readerEl.classList.add('active');
  themeSelect.value = state.theme;
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { togglePanic(); return; }
  if (!readerEl.classList.contains('active') || panicOn) return;
  if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    contentEl.scrollBy({ top: contentEl.clientHeight * 0.85, behavior: 'smooth' });
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    contentEl.scrollBy({ top: -contentEl.clientHeight * 0.85, behavior: 'smooth' });
  }
});

window.addEventListener('beforeunload', () => {
  // Guard against wiping a real saved book with blank defaults: if this
  // session never loaded/resumed a book, state.text is still '' and there
  // is nothing meaningful to persist.
  if (state.text) persist();
});
