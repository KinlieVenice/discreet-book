import { defineConfig } from 'vite';

// GitHub Pages serves this as a project site from /discreet-book/, so every
// mode uses that base consistently — including `vite preview`, which serves
// the already-built dist/index.html (whose asset paths were baked in at
// build time) but otherwise reports the same command as `vite dev`. Splitting
// the base by command breaks `npm run preview` for exactly that reason.
// Local dev: visit http://localhost:5173/discreet-book/ (not the bare root).
export default defineConfig({
  base: '/discreet-book/'
});
