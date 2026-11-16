const SUPPORTED_SCHEMES = new Set(['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote', 'vscode-userdata']);

/** Whether documents with this URI scheme are counted. */
export function isCountable(scheme: string): boolean {
  return SUPPORTED_SCHEMES.has(scheme);
}

export interface TargetDocument<S> {
  getText(range?: S): string;
  uri: { scheme: string };
}

export interface TargetSelection {
  isEmpty: boolean;
}

export interface CountTargetResult {
  texts: string[];
  what: 'selection' | 'document';
}

/** What to count: the non-empty selections, else the whole document; undefined for unsupported documents. */
export function countTarget<S extends TargetSelection>(
  doc: TargetDocument<S>,
  selections: ReadonlyArray<S>,
): CountTargetResult | undefined {
  if (!SUPPORTED_SCHEMES.has(doc.uri.scheme)) return undefined;
  const selected = selections.filter((s) => !s.isEmpty);
  if (selected.length === 0) return { what: 'document', texts: [doc.getText()] };
  return { what: 'selection', texts: selected.map((s) => doc.getText(s)) };
}
