import * as vscode from 'vscode';
import { normalizeModelId } from './core/modelId.ts';

export const DEFAULT_MODEL = 'google/gemma-4-31B-it';
export const HF_TOKEN_KEY = 'tokenmeter.hfToken';

export interface TokenmeterConfig {
  model: string;
  includeSpecialTokens: boolean;
  warningThreshold: number;
  maxDocumentSize: number;
}

/** The model id is normalized when valid, so it compares equal to `CountResult.model`. */
export function getConfig(): TokenmeterConfig {
  const c = vscode.workspace.getConfiguration('tokenmeter');
  const raw = (c.get<string>('model') ?? '').trim() || DEFAULT_MODEL;
  let model = raw;
  try {
    model = normalizeModelId(raw);
  } catch {
    // keep the raw value; the engine reports 'invalid' for it
  }
  return {
    model,
    includeSpecialTokens: c.get<boolean>('includeSpecialTokens') ?? false,
    warningThreshold: c.get<number>('warningThreshold') ?? 0,
    maxDocumentSize: c.get<number>('maxDocumentSize') ?? 500000,
  };
}

/** Writes at Global unless the workspace overrides the setting, then at Workspace. */
export async function setModel(id: string): Promise<void> {
  const c = vscode.workspace.getConfiguration('tokenmeter');
  const inWorkspace = c.inspect<string>('model')?.workspaceValue !== undefined;
  await c.update(
    'model',
    id,
    inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
  );
}
