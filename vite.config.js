import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo-name>/, so asset URLs need
// that prefix in production. Local dev/preview stay at "/" so testing is
// unaffected.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/discreet-book/' : '/'
}));
