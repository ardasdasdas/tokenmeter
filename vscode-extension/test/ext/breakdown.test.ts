import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { TokenmeterApi } from '../../src/extension.ts';

const root = join(__dirname, '..', '..', '..');
const samples: string[] = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'samples.json'), 'utf8'));
const golden: Record<string, number[][]> = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'golden.json'), 'utf8'));
const models: { models: { id: string; sha256: string }[] } = JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'));

describe('Tokenmeter breakdown', () => {
  let api: TokenmeterApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<TokenmeterApi>('ardasdasdas.tokenmeter');
    assert.ok(ext, 'extension not found');
    api = await ext.activate();
  });

  after(async () => {
    await vscode.workspace.getConfiguration('tokenmeter').update('model', undefined, vscode.ConfigurationTarget.Global);
  });

  it('tokenizes the active document with the selected model', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: samples[1] });
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.setEndOfLine(vscode.EndOfLine.LF));
    await vscode.workspace.getConfiguration('tokenmeter').update('model', 'Qwen/Qwen3-8B', vscode.ConfigurationTarget.Global);

    await vscode.commands.executeCommand('tokenmeter.showBreakdown');

    const sha = models.models.find((m) => m.id === 'Qwen/Qwen3-8B')?.sha256;
    assert.ok(sha, 'Qwen3-8B is not in models.json');
    const expected = golden[sha][1].length;
    const b = api.getLastBreakdown();
    assert.ok(b, 'no breakdown rendered');
    assert.strictEqual(b.model, 'Qwen/Qwen3-8B');
    assert.strictEqual(b.tokenCount, expected);
    assert.strictEqual(b.pieces.length, b.tokenCount);
  });
});
