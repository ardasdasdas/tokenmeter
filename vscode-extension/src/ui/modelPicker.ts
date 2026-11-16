import * as vscode from 'vscode';
import { getConfig, setModel } from '../config.ts';
import { normalizeModelId } from '../core/modelId.ts';
import type { TokenEngine } from '../engine/engine.ts';

interface Item extends vscode.QuickPickItem {
  modelId?: string;
  isAdd?: boolean;
}

const REMOVE_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('trash'),
  tooltip: 'Remove downloaded tokenizer',
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function buildItems(engine: TokenEngine): Promise<Item[]> {
  const current = getConfig().model;
  const downloaded = await engine.listDownloaded();
  return [
    { label: '$(add) New model…', alwaysShow: true, isAdd: true },
    { label: 'In use', kind: vscode.QuickPickItemKind.Separator },
    { label: current, modelId: current },
    { label: 'Downloaded', kind: vscode.QuickPickItemKind.Separator },
    ...downloaded.map((id): Item => ({ label: id, modelId: id, buttons: [REMOVE_BUTTON] })),
    { label: 'Bundled', kind: vscode.QuickPickItemKind.Separator },
    ...engine.bundled().map((m): Item => ({ label: m.id, description: m.family, modelId: m.id })),
  ];
}

export async function selectModel(engine: TokenEngine): Promise<void> {
  const pick = vscode.window.createQuickPick<Item>();
  pick.title = 'Tokenmeter: Select model';
  pick.placeholder = 'Choose the tokenizer used for counting';
  pick.matchOnDescription = true;
  const refill = async () => {
    pick.busy = true;
    pick.items = await buildItems(engine);
    pick.busy = false;
  };
  const chosen = await new Promise<Item | undefined>((resolve) => {
    pick.onDidAccept(() => resolve(pick.selectedItems[0]));
    pick.onDidHide(() => resolve(undefined));
    pick.onDidTriggerItemButton(async (e) => {
      if (!e.item.modelId) return;
      try {
        await engine.removeDownloaded(e.item.modelId);
        await refill();
      } catch (err) {
        pick.busy = false;
        void vscode.window.showErrorMessage(messageOf(err));
      }
    });
    pick.show();
    refill().catch((err: unknown) => {
      void vscode.window.showErrorMessage(messageOf(err));
      resolve(undefined);
    });
  });
  pick.dispose();
  if (!chosen) return;
  if (chosen.isAdd) await addModel(engine);
  else if (chosen.modelId) await setModel(chosen.modelId);
}

export async function addModel(engine: TokenEngine): Promise<void> {
  const raw = await vscode.window.showInputBox({
    title: 'Tokenmeter: Add model',
    prompt: 'Hugging Face model, e.g. google/gemma-4-31B-it, or a huggingface.co URL',
    placeHolder: 'owner/model',
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        normalizeModelId(value);
        return undefined;
      } catch (e) {
        return messageOf(e);
      }
    },
  });
  if (raw === undefined) return;
  const id = normalizeModelId(raw);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading tokenizer for ${id}…` },
      () => engine.count(id, '', false),
    );
  } catch (e) {
    void vscode.window.showErrorMessage(messageOf(e));
    return;
  }
  await setModel(id);
}

export async function removeModel(engine: TokenEngine): Promise<void> {
  const downloaded = await engine.listDownloaded();
  if (downloaded.length === 0) {
    void vscode.window.showInformationMessage('Tokenmeter: no downloaded tokenizers to remove.');
    return;
  }
  const id = await vscode.window.showQuickPick(downloaded, { placeHolder: 'Remove a downloaded tokenizer' });
  if (id) await engine.removeDownloaded(id);
}
