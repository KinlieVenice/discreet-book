# discreet-book

Drop a PDF, read it disguised as something else. Everything — PDF parsing, text,
your reading progress — stays in your browser. Nothing is uploaded to a server.

## Themes

**Engineering**
- **Code file** — VS Code-style tabs, comment-block styling, line-number gutter
- **Terminal / logs** — looks like `tail -f app.log` scrolling by
- **PR diff** — GitHub-style diff view with a green addition gutter
- **Man page** — classic black-background `man(1)` styling

**Office**
- **Business proposal** — white page, serif type, "Confidential" header
- **Analytics dashboard** — dark sidebar nav, fake KPI tiles
- **Spreadsheet** — Google Sheets-style title bar/menu/toolbar, formula bar, row/column grid, sticky sheet-tab strip
- **Email inbox** — Outlook/Gmail-style message list and reading pane
- **Meeting notes** — memo with date/attendee header
- **Slide deck notes** — PowerPoint speaker-notes view with a thumbnail strip
- **Support ticket** — helpdesk queue card with a comment thread
- **HR policy doc** — numbered handbook sections, formal serif body

**AI Chat**
- **Claude** — dark warm UI, sidebar chat history, sticky chat-title bar, your book as the assistant's response, a fake sticky "Write a message…" bar at the bottom
- **ChatGPT** — near-black UI, icon sidebar (Images/Library/Projects/Codex), blue user message bubble, a fake sticky "Ask anything" bar at the bottom

Switch themes anytime from the bar at the bottom without losing your place.
Office and AI Chat themes also get a font picker (Calibri, Arial, Times New
Roman, Georgia, Cambria, Verdana, Tahoma, or theme default) next to the
existing text-size buttons.

## Running it

```bash
npm install
npm run dev
```

Vite is configured with a fixed `/discreet-book/` base (matching the GitHub
Pages URL below), so open **`http://localhost:5173/discreet-book/`** — not
the bare root. Keep it open at that address — bookmark it, or run
`npm run build && npm run preview` for a slightly more "just a website"
feeling than a dev server banner (same `/discreet-book/` suffix applies
there too).

### Hosted version

Pushes to `main` auto-deploy to GitHub Pages via `.github/workflows/deploy.yml`.
One-time setup in the repo's GitHub settings: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. Once that's set, the site is live at
`https://<owner>.github.io/discreet-book/` a minute or two after each push —
no need to run `npm run dev` locally every time.

## Usage

- Drop or click to choose a `.pdf`. It's parsed page-by-page entirely client-side
  (via `pdfjs-dist`) — no network request ever contains your file or its text.
- `Space` / `↓` scrolls forward, `↑` scrolls back.
- `Esc` instantly blanks the whole screen to a generic loading spinner; `Esc`
  again (or click) returns you to exactly where you were.
- Clicking the inert parts of the bottom control bar (the labels, the book
  title/section count, the empty space) does something different: it tucks
  the bar itself away for distraction-free, full-screen reading — the space
  it was taking up is reclaimed, not just left blank. A small handle appears
  at the bottom center; click it to bring the bar back.
- Your extracted book text is saved in IndexedDB (no practical size limit, so
  long books are fine); theme, font size, and scroll position are saved in
  `localStorage`. Both are scoped to this page only. Reopening the tab offers
  to resume.
- "Load different PDF" on the control bar starts over with a new file.

## Notes

- Paragraph breaks are approximated at PDF page boundaries — extraction doesn't
  attempt to reconstruct exact paragraph structure from the source PDF.
- This is a personal reading tool. Don't redistribute extracted text from
  copyrighted books.
