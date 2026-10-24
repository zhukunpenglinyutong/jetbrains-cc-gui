import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** Match the native Office entry guard before copying a bundle into plugin resources. */
function officeEntryBudget(): Plugin {
  return {
    name: 'office-entry-budget',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const entry = bundle['office.html'];
        if (!entry || entry.type !== 'asset' || Buffer.byteLength(entry.source) > 5 * 1024 * 1024) {
          this.error('Office HTML exceeds the native 5 MiB entry budget. Optimize bundled art before shipping.');
        }
      },
    },
  };
}

// A separate bundle prevents the Office from bootstrapping chat/provider state.
export default defineConfig({
  plugins: [react(), viteSingleFile(), officeEntryBudget()],
  build: {
    outDir: 'dist/office',
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: 'office.html',
      output: { manualChunks: undefined },
    },
  },
});
