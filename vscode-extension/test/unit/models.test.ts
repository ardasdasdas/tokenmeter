import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { readModelList } from '../../src/core/models.ts';

it('reads the bundled list', () => {
  const list = readModelList(JSON.parse(readFileSync('models.json', 'utf8')));
  expect(list).toHaveLength(56);
  expect(new Set(list.map((m) => m.sha256)).size).toBe(33);
  expect(list.find((m) => m.id === 'google/gemma-4-31B-it')?.family).toBe('Gemma');
});

it('rejects malformed data', () => expect(() => readModelList({ models: [{ id: 1 }] })).toThrow());
