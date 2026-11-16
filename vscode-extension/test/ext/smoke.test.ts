import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { TokenmeterApi } from '../../src/extension.ts';

const fixtures = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const read = (name: string) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const samples: string[] = read('samples.json');
const golden: Record<string, number[][]> = read('golden.json');
const models: { models: { id: string; sha256: string }[] } = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'models.json'), 'utf8'),
);

async function waitFor(api: TokenmeterApi, expected: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (api.getStatusText() === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(api.getStatusText(), expected);
}

async function setModel(id: string): Promise<void> {
  await vscode.workspace.getConfiguration('tokenmeter').update('model', id, vscode.ConfigurationTarget.Global);
}

describe('Tokenmeter extension', () => {
  let api: TokenmeterApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<TokenmeterApi>('ardasdasdas.tokenmeter');
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  after(async () => {
    await vscode.workspace.getConfiguration('tokenmeter').update('model', undefined, vscode.ConfigurationTarget.Global);
  });

  it('shows the token count of the active document and follows the model setting', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: samples[0] });
    const editor = await vscode.window.showTextDocument(doc);
    // Windows opens untitled documents with CRLF, which changes the count.
    await editor.edit((e) => e.setEndOfLine(vscode.EndOfLine.LF));

    await setModel('Qwen/Qwen3-8B');
    await waitFor(api, '$(symbol-numeric) 25 tokens · Qwen3-8B');

    const sha = models.models.find((m) => m.id === 'openai/gpt-oss-20b')?.sha256;
    assert.ok(sha, 'gpt-oss-20b is not in models.json');
    const expected = golden[sha][0].length;
    await setModel('openai/gpt-oss-20b');
    await waitFor(api, `$(symbol-numeric) ${expected.toLocaleString('en-US')} tokens · gpt-oss-20b`);
  });
});
