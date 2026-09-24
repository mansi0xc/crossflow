import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * This repository uses NodeNext module resolution, so shared sources are imported with a `.js`
 * specifier that actually names a `.ts` file. Vite does not do that rewrite on its own.
 */
function typescriptExtensionResolution(): Plugin {
  return {
    name: 'crossflow-ts-extension-resolution',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.endsWith('.js') || !source.startsWith('.')) return null;
      const candidate = resolvePath(dirname(importer), source.replace(/\.js$/, '.ts'));
      return existsSync(candidate) ? candidate : null;
    },
  };
}

// The app is a local devnet tool: it is served from localhost and talks to the local service.
export default defineConfig({
  root: 'apps/web',
  plugins: [typescriptExtensionResolution(), react()],
  define: { global: 'globalThis' },
  resolve: { alias: { buffer: 'buffer/' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
});
