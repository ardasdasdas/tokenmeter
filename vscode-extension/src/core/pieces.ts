import type { Tokenizer } from '@huggingface/tokenizers';

/**
 * One displayable piece per token (port of `pieces()` in app/static/app.js).
 * Byte-level tokens that split a character are decoded together (up to 4) so
 * each of them shows the whole character instead of U+FFFD.
 */
export function tokenPieces(tok: Tokenizer, ids: number[], tokens: string[], limit: number): string[] {
  const out: string[] = [];
  const n = Math.min(ids.length, limit);
  let group: number[] = [];
  for (let i = 0; i < n; i++) {
    group.push(i);
    let text = tok.decode(
      group.map((j) => ids[j]),
      { skip_special_tokens: false },
    );
    if (text.includes('�') && group.length < 4 && i < n - 1) continue;
    const raw = tokens[group[0]] || '';
    if (/^[▁Ġ]/.test(raw) && !/^\s/.test(text)) text = ' ' + text;
    for (let k = 0; k < group.length; k++) out.push(text);
    group = [];
  }
  return out;
}
