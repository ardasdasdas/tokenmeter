import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Pack, assemble, splitTokenizer, writePack } from '../../src/core/pack.ts';

it('round-trips a document exactly', () => {
  const doc = {
    version: '1.0',
    added_tokens: [{ id: 0, content: '<s>' }],
    normalizer: null,
    model: { type: 'BPE', vocab: { a: 0, '1': 1, 'ğ': 2 }, merges: [['a', 'ğ']] },
  };
  const { layout, parts } = splitTokenizer(doc);
  expect(assemble(layout, (h) => JSON.parse(parts.get(h)!))).toEqual(doc);
});

it('keeps a non-object model as a single part', () => {
  const doc = { model: 'x', a: 1 };
  const { layout, parts } = splitTokenizer(doc);
  expect(layout.map((e) => e[0])).toEqual(['model', 'a']);
  expect(assemble(layout, (h) => JSON.parse(parts.get(h)!))).toEqual(doc);
});

it('shares identical parts across files', async () => {
  const a = { model: { type: 'BPE', vocab: { x: 0 } }, added_tokens: [] };
  const b = { model: { type: 'BPE', vocab: { x: 0 } }, added_tokens: [{ id: 1, content: '<eos>' }] };
  const dir = await mkdtemp(join(tmpdir(), 'pack-'));
  const r = await writePack(dir, [
    { fileSha256: 'f1', doc: a, modelIds: ['o/a'] },
    { fileSha256: 'f2', doc: b, modelIds: ['o/b', 'o/b2'] },
  ]);
  expect(r.parts).toBe(4); // type, vocab, added_tokens(a), added_tokens(b)
  expect(r.bytes).toBeGreaterThan(0);
  const pack = await Pack.open(dir);
  expect(pack.ids().sort()).toEqual(['o/a', 'o/b', 'o/b2']);
  expect(pack.fileOf('o/b2')).toBe('f2');
  expect(await pack.load('o/b2')).toEqual(b);
  expect(await pack.load('o/a')).toEqual(a);
  expect(pack.has('o/missing')).toBe(false);
  expect(pack.has('O/A')).toBe(false);
});

it('load of unknown id throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pack-'));
  await writePack(dir, [{ fileSha256: 'f1', doc: { a: 1 }, modelIds: ['o/a'] }]);
  const pack = await Pack.open(dir);
  await expect(pack.load('o/nope')).rejects.toThrow(/o\/nope/);
});
