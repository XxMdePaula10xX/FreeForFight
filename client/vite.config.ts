import { defineConfig } from 'vite';

// The client imports from ../shared, which lives outside the client root.
// Allow Vite's dev server to read one level up.
export default defineConfig({
  server: {
    port: 5173,
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
