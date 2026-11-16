import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfig } from '../config.ts';
import { shortName } from '../core/modelId.ts';
import type { TokenEngine } from '../engine/engine.ts';
import { countTarget } from './countTarget.ts';

/** Same as the website's MAX_RENDER. */
export const MAX_RENDER = 4000;

export interface Breakdown {
  model: string;
  tokenCount: number;
  charCount: number;
  ids: number[];
  pieces: string[];
  what: 'selection' | 'document';
}

let panel: vscode.WebviewPanel | undefined;
let last: Breakdown | undefined;

/** Test hook: the data of the last rendered breakdown. */
export function getLastBreakdown(): Breakdown | undefined {
  return last;
}

/** Tokenizes the selection (or document) of the active editor and shows it in one reused panel. */
export async function showBreakdown(context: vscode.ExtensionContext, engine: TokenEngine): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const target = editor && countTarget(editor.document, editor.selections);
  if (!target) {
    void vscode.window.showInformationMessage('Tokenmeter: open a text editor to see its tokens.');
    return;
  }
  const cfg = getConfig();
  let data: Breakdown;
  try {
    data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Tokenizing with ${shortName(cfg.model)}…` },
      () => tokenizeAll(engine, cfg.model, target.texts, cfg.includeSpecialTokens),
    );
  } catch (e) {
    void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    return;
  }
  data.what = target.what;
  last = data;

  const title = `Tokenmeter: ${shortName(data.model)}`;
  if (panel) {
    panel.title = title;
    panel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    panel = vscode.window.createWebviewPanel('tokenmeter.breakdown', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.onDidDispose(() => (panel = undefined));
    // Without retainContextWhenHidden the page reloads when shown again; it asks for the data then.
    panel.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m?.type === 'ready' && last) void panel?.webview.postMessage({ type: 'data', data: last });
    });
    panel.webview.html = html(panel.webview, context.extensionUri);
  }
  void panel.webview.postMessage({ type: 'data', data });
}

async function tokenizeAll(engine: TokenEngine, model: string, texts: string[], special: boolean): Promise<Breakdown> {
  const out: Breakdown = { model, tokenCount: 0, charCount: 0, ids: [], pieces: [], what: 'document' };
  for (const text of texts) {
    const left = Math.max(0, MAX_RENDER - out.pieces.length);
    const r = await engine.tokenize(model, text, special, left);
    out.model = r.model;
    out.tokenCount += r.tokenCount;
    out.charCount += r.charCount;
    out.ids.push(...r.ids.slice(0, left));
    out.pieces.push(...r.pieces.slice(0, left));
  }
  return out;
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'breakdown.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'media', 'breakdown.js'));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Tokenmeter</title>
</head>
<body>
<header>
  <div id="model" class="model"></div>
  <div class="stats">
    <span><b id="tokens">–</b> tokens</span>
    <span><b id="chars">–</b> characters</span>
    <span><b id="ratio">–</b> chars/token</span>
    <span id="what" class="muted"></span>
  </div>
  <label><input type="checkbox" id="show-ids"> Show IDs</label>
</header>
<p id="note" class="muted" hidden></p>
<div id="list" class="tokens"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
