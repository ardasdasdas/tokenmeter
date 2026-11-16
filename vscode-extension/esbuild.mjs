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

// Task 6: add the extension bundle here.
// await build({
//   ...common,
//   entryPoints: ['src/extension.ts'],
//   outfile: 'dist/extension.js',
//   external: ['vscode'],
// });
