import { join } from 'node:path';
import * as vscode from 'vscode';
import { HF_TOKEN_KEY } from './config.ts';
import { TokenEngine } from './engine/engine.ts';
import { getLastBreakdown, showBreakdown } from './ui/breakdown.ts';
import type { Breakdown } from './ui/breakdown.ts';
import { addModel, removeModel, selectModel } from './ui/modelPicker.ts';
import { StatusBar } from './ui/statusBar.ts';

let engine: TokenEngine | undefined;

/** Exported by `activate` for the extension tests. */
export interface TokenmeterApi {
  getStatusText(): string;
  getLastBreakdown(): Breakdown | undefined;
}

export function activate(context: vscode.ExtensionContext): TokenmeterApi {
  const eng = new TokenEngine({
    packDir: context.asAbsolutePath('dist/pack'),
    storageDir: join(context.globalStorageUri.fsPath, 'tokenizers'),
    workerPath: context.asAbsolutePath('dist/worker.js'),
    getToken: async () => (await context.secrets.get(HF_TOKEN_KEY)) || undefined,
  });
  engine = eng;
  const statusBar = new StatusBar(eng);
  const cmd = (id: string, fn: () => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    statusBar,
    cmd('tokenmeter.selectModel', async () => {
      await selectModel(eng);
      statusBar.retry(); // a tokenizer may have been removed from the picker
    }),
    cmd('tokenmeter.addModel', () => addModel(eng)),
    cmd('tokenmeter.removeModel', async () => {
      await removeModel(eng);
      statusBar.retry();
    }),
    cmd('tokenmeter.showBreakdown', () => showBreakdown(context, eng)),
    cmd('tokenmeter.countNow', () => statusBar.countNow()),
    cmd('tokenmeter.setHfToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Tokenmeter: Set Hugging Face token',
        prompt: 'Used only to download tokenizers of gated or private models from huggingface.co',
        password: true,
        ignoreFocusOut: true,
      });
      if (token?.trim()) await context.secrets.store(HF_TOKEN_KEY, token.trim());
    }),
    cmd('tokenmeter.clearHfToken', () => context.secrets.delete(HF_TOKEN_KEY)),
    context.secrets.onDidChange((e) => {
      if (e.key === HF_TOKEN_KEY) statusBar.retry();
    }),
  );
  return { getStatusText: () => statusBar.text, getLastBreakdown };
}

export async function deactivate(): Promise<void> {
  const eng = engine;
  engine = undefined;
  await eng?.dispose();
}
