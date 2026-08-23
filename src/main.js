import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Kept as "discrete-book" (repo was renamed to discreet-book) so anyone's
// already-saved reading progress in localStorage/IndexedDB isn't lost.
const META_KEY = 'discrete-book:meta';
const DB_NAME = 'discrete-book';
const STORE_NAME = 'text';
const TEXT_KEY = 'book';

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

let state = { text: '', name: '', theme: 'coding', fontSize: 17, scrollPct: 0 };
let panicOn = false;
let saveTimer = null;
let extracting = false;

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
  hrpolicy: 'Loading document…'
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
  hrpolicy: 'Employee Handbook.pdf'
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
    name: state.name, theme: state.theme, fontSize: state.fontSize, scrollPct: state.scrollPct
  }));
}

/* The extracted book text goes in IndexedDB, not localStorage: a long book
   can easily run past localStorage's ~5-10MB quota, while IndexedDB has no
   such practical ceiling — so reading progress survives regardless of book
   length or page count. */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetText(text) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(text, TEXT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* storage unavailable or full — reading still works this session */ }
}

async function idbGetText() {
  try {
    const db = await openDb();
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
    const db = await openDb();
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
  let html = '<div class="code-titlebar"><div class="code-tab active">notes.md</div>' +
    '<div class="code-tab">README.md</div><div class="code-tab">TODO.md</div></div>';
  html += '<div class="code-body"><div class="gutter">';
  for (let i = 0; i < paras.length + 4; i++) html += '<span>&nbsp;</span>';
  html += '</div><div class="code-text">';
  html += '<div class="code-header">/**<br>&nbsp;* @fileoverview Internal working notes<br>&nbsp;* @private<br>&nbsp;*/</div>';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderBusiness(paras) {
  let html = '<div class="doc-page">';
  html += '<div class="doc-kicker"><span>Strategic Planning &mdash; Internal Draft</span><span>Confidential</span></div>';
  html += '<div class="doc-title">Proposal: Q4 Initiative Notes</div>';
  html += '<div class="doc-text">';
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
  let html = '<div class="diff-file">';
  html += '<div class="diff-file-header">📄 notes/reading.md &nbsp; <span class="diff-badge">+' + paras.length + '&nbsp;&minus;0</span></div>';
  html += `<div class="diff-hunk-marker">@@ -0,0 +1,${paras.length} @@</div>`;
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
  let html = '<div class="sheet-ribbon">' +
    '<div class="ribbon-tabs"><span class="active">Home</span><span>Insert</span><span>Page Layout</span><span>Formulas</span><span>Data</span><span>Review</span><span>View</span></div>' +
    '<div class="ribbon-tools"><span>Calibri</span><span>11</span><span class="ico">B</span><span class="ico">I</span><span class="ico">U</span><span class="ico">▤</span><span class="ico">%</span></div>' +
    '</div>';
  html += '<div class="sheet-formulabar"><span class="cell-ref">A1</span><span class="fx">fx</span><span class="fx-content"></span></div>';
  html += '<div class="sheet-colheader"><div class="corner"></div>';
  for (let c = 0; c < 3; c++) html += `<div class="col-h">${colLetter(c)}</div>`;
  html += '</div>';
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
  html += '<div class="mail-subject">Re: Q3 planning sync</div>';
  html += '<div class="mail-meta"><span class="mail-sender">Team Notes &lt;notes@internal&gt;</span><span class="mail-date">9:14 AM</span></div>';
  html += '<div class="mail-body">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div></div>';
  return html;
}

function renderMemo(paras) {
  let html = '<div class="memo-page">';
  html += '<div class="memo-title">Meeting Minutes</div>';
  html += '<div class="memo-meta"><div><strong>Date:</strong> Today</div><div><strong>Attendees:</strong> J. Ramirez, T. Okafor, P. Singh</div></div>';
  html += '<div class="memo-section-label">Notes</div>';
  html += '<div class="memo-text">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderSlides(paras) {
  let html = '<div class="slides-strip">';
  for (let i = 0; i < 5; i++) {
    html += `<div class="slide-thumb${i === 1 ? ' active' : ''}"><span></span><span></span></div>`;
  }
  html += '</div>';
  html += '<div class="slides-notes-wrap"><div class="slides-notes-label">Speaker Notes &mdash; Slide 2</div>';
  html += '<div class="slides-notes">';
  paras.forEach((p) => { html += `<p>${escapeHtml(p)}</p>`; });
  html += '</div></div>';
  return html;
}

function renderTicket(paras) {
  let html = '<div class="ticket-card">';
  html += '<div class="ticket-header"><span class="ticket-id">#10482</span><span class="ticket-status">Open</span><span class="ticket-priority">Normal</span></div>';
  html += '<div class="ticket-subject">Working notes &mdash; internal</div>';
  html += '<div class="ticket-thread">';
  paras.forEach((p, i) => {
    html += `<div class="ticket-comment"><div class="ticket-avatar"></div><div class="ticket-comment-body">` +
      `<div class="ticket-comment-meta">Internal note &middot; ${i + 1}</div><p>${escapeHtml(p)}</p></div></div>`;
  });
  html += '</div></div>';
  return html;
}

function renderHrPolicy(paras) {
  let html = '<div class="hr-page">';
  html += '<div class="hr-header"><div class="hr-title">Employee Handbook</div><div class="hr-effective">Effective Date: This Year</div></div>';
  html += '<div class="hr-section-label">Section 4 &mdash; Working Notes</div>';
  html += '<div class="hr-text">';
  paras.forEach((p, i) => { html += `<p><span class="hr-num">4.${i + 1}</span>${escapeHtml(p)}</p>`; });
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
  email: renderEmail,
  memo: renderMemo,
  slides: renderSlides,
  ticket: renderTicket,
  hrpolicy: renderHrPolicy
};

function render() {
  document.body.className = 'theme-' + state.theme;
  document.title = TAB_TITLES[state.theme] || 'notes';
  panicText.textContent = PANIC_LABELS[state.theme] || 'Loading…';
  contentEl.style.fontSize = state.fontSize + 'px';

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

const savedMeta = loadMeta();
if (savedMeta) {
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
}

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
  contentEl.style.fontSize = state.fontSize + 'px';
  schedulePersist();
});
fontDownBtn.addEventListener('click', () => {
  state.fontSize = Math.max(12, state.fontSize - 1);
  contentEl.style.fontSize = state.fontSize + 'px';
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

window.addEventListener('beforeunload', persist);
