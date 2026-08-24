# discreet-book

Drop a PDF, read it disguised as something else. Everything — PDF parsing, text,
your reading progress — stays in your browser. Nothing is uploaded to a server.

## Themes

**Engineering**
- **PR diff** — GitHub-style diff view with a green addition gutter
- **GitLab issue** — dark top nav with the real GitLab mark, project sidebar (Issues/Merge requests/CI-CD/…), issue header with status badge and title, metadata rail on the right
- **GitHub README** — dark top nav with the real Octocat mark, file breadcrumb with a branch pill, Edit/Preview tabs, Cancel/Commit changes buttons, rendered markdown preview body

**Office**
- **Spreadsheet** — Google Sheets-style title bar/menu/toolbar, formula bar, row/column grid, sticky sheet-tab strip
- **Google Docs** — real Docs logo, title bar/toolbar/ruler, document-tabs sidebar, floating pages with page breaks, a right-edge icon rail
- **Email inbox** — real Gmail logo, full nav (Inbox/Starred/Snoozed/…), search bar, toolbar, sender row, icon rail

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
- **Pagination** (on by default): the control bar groups every 10 source PDF
  pages into one reader "page," with `‹`/`›` buttons and a `Page X / Y`
  indicator. `Space`/`↓`/`PageDown` goes to the next page, `↑`/`PageUp` goes
  back. Click "Pagination: On" to turn it off and fall back to one
  continuously scrolling document — `Space`/arrows then scroll instead of
  paging, and your exact scroll position is what gets remembered.
- With pagination off: `Space` / `↓` scrolls forward, `↑` scrolls back.
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
