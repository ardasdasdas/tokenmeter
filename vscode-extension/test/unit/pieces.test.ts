import { existsSync } from 'node:fs';
import { Tokenizer } from '@huggingface/tokenizers';
import { describe, expect, it } from 'vitest';
import { Pack } from '../../src/core/pack.ts';
import { tokenPieces } from '../../src/core/pieces.ts';

describe.skipIf(!existsSync('dist/pack/manifest.json'))('tokenPieces', () => {
  it('gives one piece per token and never shows broken characters', async () => {
    const pack = await Pack.open('dist/pack');
    const tok = new Tokenizer(await pack.load('Qwen/Qwen3-8B'), {});
    const text = 'Merhaba dünya! 🚀 Çok güzel.';
    const enc = tok.encode(text, { add_special_tokens: false });
    const pieces = tokenPieces(tok, enc.ids, enc.tokens, 4000);
    expect(pieces).toHaveLength(11);
    expect(pieces.slice(0, 3)).toEqual(['Mer', 'hab', 'a']);
    for (const i of [5, 6, 7]) expect(pieces[i]).toContain('🚀');
    for (const p of pieces) expect(p).not.toContain('�');
  });

  it('honours the limit', async () => {
    const pack = await Pack.open('dist/pack');
    const tok = new Tokenizer(await pack.load('Qwen/Qwen3-8B'), {});
    const enc = tok.encode('Merhaba dünya!', { add_special_tokens: false });
    expect(tokenPieces(tok, enc.ids, enc.tokens, 2)).toHaveLength(2);
  });
});
