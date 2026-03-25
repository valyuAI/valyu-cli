import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const result = await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/cli.cjs',
  external: [
    // Keep native modules external
    'fsevents',
  ],
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: false,
  sourcemap: false,
  define: {
    '__VERSION__': JSON.stringify(pkg.version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});

// Make executable
const { chmodSync } = await import('node:fs');
chmodSync('dist/cli.cjs', 0o755);

console.log('Build complete: dist/cli.cjs');
