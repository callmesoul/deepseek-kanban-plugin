import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Build a plain CJS bundle (react / react-dom externalized — the DSH shell
// provides them). `scripts/wrap-client.mjs` then wraps the whole file in the
// `window.__ModuleLoader__.load` factory that the client-modules loader expects.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/client.ts', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'client.raw.js',
    },
    outDir: 'lib',
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: 'esbuild',
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    },
  },
});
