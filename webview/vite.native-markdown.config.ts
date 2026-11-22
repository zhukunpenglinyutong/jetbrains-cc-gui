import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    outDir: '../src/main/resources/markdown-annotations',
    emptyOutDir: false,
    target: 'es2020',
    lib: {
      entry: fileURLToPath(new URL('./src/nativeMarkdownAnnotations/index.ts', import.meta.url)),
      name: 'CCGuiMarkdownReview',
      formats: ['iife'],
      fileName: () => 'ccgui-markdown-annotations.js',
      cssFileName: 'ccgui-markdown-annotations',
    },
  },
});
