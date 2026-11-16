import { expect, it } from 'vitest';
import { LatestOnly } from '../../src/core/latestOnly.ts';

it('runs only the first and the newest pushed input', async () => {
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  const q = new LatestOnly<string, string>((input) => {
    calls.push(input);
    return new Promise((resolve) => {
      gates.set(input, () => resolve(input.toLowerCase()));
    });
  });
  const a = q.push('A');
  const b = q.push('B');
  const c = q.push('C');
  expect(calls).toEqual(['A']);
  gates.get('A')!();
  expect(await a).toBe('a');
  expect(await b).toBeUndefined();
  await new Promise((r) => setImmediate(r));
  expect(calls).toEqual(['A', 'C']);
  gates.get('C')!();
  expect(await c).toBe('c');
  expect(calls).toEqual(['A', 'C']);
});

it('rejects the caller of a failing run and keeps working', async () => {
  let n = 0;
  const q = new LatestOnly<number, number>(async (x) => {
    if (n++ === 0) throw new Error('boom');
    return x;
  });
  await expect(q.push(1)).rejects.toThrow('boom');
  expect(await q.push(2)).toBe(2);
});
