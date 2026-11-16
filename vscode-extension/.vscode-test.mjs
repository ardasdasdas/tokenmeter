import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'dist/test/ext/*.test.js',
  version: 'stable',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 60000 },
});
