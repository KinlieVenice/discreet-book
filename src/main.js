import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const STORAGE_KEY = 'discrete-book:book';

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
  manpage: 'Loading manual…'
};

const TAB_TITLES = {
  coding: 'notes.md — Visual Studio Code',
  business: 'Draft Proposal.docx',
  data: 'Weekly Report',
  terminal: 'app.log',
  prdiff: 'Pull Request #482',
  manpage: 'notes(1) — Manual Page'
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

function loadSaved() {
  const raw = safeGet(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function persist() {
  safeSet(STORAGE_KEY, JSON.stringify(state));
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

const RENDERERS = {
  coding: renderCoding,
  business: renderBusiness,
  data: renderData,
  terminal: renderTerminal,
  prdiff: renderPrDiff,
  manpage: renderManpage
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

const saved = loadSaved();
if (saved && saved.text) {
  resumeRow.classList.add('show');
  resumeRow.querySelector('strong').textContent = saved.name || 'your book';
  resumeBtn.addEventListener('click', () => { state = saved; openReader(); });
  discardBtn.addEventListener('click', () => {
    safeRemove(STORAGE_KEY);
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
