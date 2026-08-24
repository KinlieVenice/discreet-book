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
- **Spreadsheet** — Excel-style ribbon, formula bar, row/column grid
- **Email inbox** — Outlook/Gmail-style message list and reading pane
- **Meeting notes** — memo with date/attendee header
- **Slide deck notes** — PowerPoint speaker-notes view with a thumbnail strip
- **Support ticket** — helpdesk queue card with a comment thread
- **HR policy doc** — numbered handbook sections, formal serif body

**AI Chat**
- **Claude** — sidebar chat history, sticky user question, your book as the response
- **ChatGPT** — same idea in ChatGPT's grayscale styling

Switch themes anytime from the bar at the bottom without losing your place.
Office and AI Chat themes also get a font picker (Calibri, Arial, Times New
Roman, Georgia, Cambria, Verdana, Tahoma, or theme default) next to the
existing text-size buttons.

## Running it

```bash
npm install
npm run dev
```

Open the printed local URL (typically `http://localhost:5173`). Keep it open at
that address — bookmark it, or run `npm run build && npm run preview` for a
slightly more "just a website" feeling than a dev server banner.

## Usage

- Drop or click to choose a `.pdf`. It's parsed page-by-page entirely client-side
  (via `pdfjs-dist`) — no network request ever contains your file or its text.
- `Space` / `↓` scrolls forward, `↑` scrolls back.
- `Esc` instantly blanks the screen to a generic loading spinner; `Esc` again
  (or click) returns you to exactly where you were.
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
