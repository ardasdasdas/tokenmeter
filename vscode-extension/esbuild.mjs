import { readdirSync } from 'node:fs';
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/engine/worker.ts'],
  outfile: 'dist/worker.js',
});

await build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

// Extension-host tests (run by `npm run test:ext`).
const extTests = readdirSync('test/ext')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `test/ext/${f}`);
await build({
  ...common,
  entryPoints: extTests,
  outdir: 'out/test/ext',
  external: ['vscode', 'mocha'],
});
