import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { describe, expect, it } from 'vitest';
import { readModelList } from '../../src/core/models.ts';
import { Pack } from '../../src/core/pack.ts';

const root = process.cwd();
const packDir = join(root, 'dist', 'pack');
const available = existsSync(join(packDir, 'manifest.json'));

describe.skipIf(!available)('tokenizer parity with Python tokenizers', () => {
  const models = available
    ? readModelList(JSON.parse(readFileSync(join(root, 'models.json'), 'utf8')))
    : [];
  const samples = available
    ? (JSON.parse(readFileSync(join(root, 'test/fixtures/samples.json'), 'utf8')) as string[])
    : [];
  const golden = available
    ? (JSON.parse(readFileSync(join(root, 'test/fixtures/golden.json'), 'utf8')) as Record<
        string,
        number[][]
      >)
    : {};
  const files = new Map<string, string>();
  for (const m of models) if (!files.has(m.sha256)) files.set(m.sha256, m.id);

  for (const [sha, id] of files) {
    it(`${id} (${sha.slice(0, 8)})`, { timeout: 10 * 60 * 1000 }, async () => {
      const pack = await Pack.open(packDir);
      const doc = await pack.load(id);
      const cachePath = join(root, '.cache', 'src', `${sha}.json`);
      if (existsSync(cachePath)) {
        expect(doc).toEqual(JSON.parse(readFileSync(cachePath, 'utf8')));
      }
      const tokenizer = new Tokenizer(doc as never, {} as never);
      const expected = golden[sha]!;
      samples.forEach((text, i) => {
        const ids = Array.from(tokenizer.encode(text, { add_special_tokens: false }).ids);
        expect(ids, `${id} sample ${i}`).toEqual(expected[i]);
      });
    });
  }
});
