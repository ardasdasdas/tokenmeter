import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenEngine } from '../../src/engine/engine.ts';
import type { FetchLike } from '../../src/core/downloads.ts';

const ready = existsSync('dist/pack/manifest.json') && existsSync('dist/worker.js');
const samples: string[] = JSON.parse(readFileSync('test/fixtures/samples.json', 'utf8'));
const golden: Record<string, number[][]> = JSON.parse(readFileSync('test/fixtures/golden.json', 'utf8'));

describe.skipIf(!ready)('TokenEngine', () => {
  const fetchFake = vi.fn<FetchLike>(async () => new Response('nope', { status: 404 }));
  let engine: TokenEngine;

  beforeAll(async () => {
    engine = new TokenEngine({
      packDir: resolve('dist/pack'),
      storageDir: await mkdtemp(join(tmpdir(), 'engine-')),
      workerPath: resolve('dist/worker.js'),
      getToken: async () => undefined,
      fetchImpl: fetchFake,
    });
  });
  afterAll(() => engine.dispose());

  it('counts a bundled model without touching the network', async () => {
    const r = await engine.count('Qwen/Qwen3-8B', samples[0], false);
    expect(r.tokenCount).toBe(25);
    expect(r.source).toBe('bundled');
    expect(r.model).toBe('Qwen/Qwen3-8B');
    expect(r.charCount).toBe([...samples[0]].length);
    expect(fetchFake).not.toHaveBeenCalled();
  });

  it('matches the Python golden counts', async () => {
    const model = 'openai/gpt-oss-20b';
    const sha = engine.bundled().find((m) => m.id === model)!.sha256;
    for (let i = 0; i < samples.length; i++) {
      const r = await engine.count(model, samples[i], false);
      expect(r.tokenCount).toBe(golden[sha][i].length);
    }
  });

  it('rejects an unknown model with not_found and survives', async () => {
    await expect(engine.count('nope/missing', 'x', false)).rejects.toMatchObject({
      name: 'TokenmeterError',
      code: 'not_found',
    });
    await expect(engine.count('not a model', 'x', false)).rejects.toMatchObject({ code: 'invalid' });
    expect((await engine.count('Qwen/Qwen3-8B', 'hello', false)).tokenCount).toBeGreaterThan(0);
  });

  it('cuts ids and pieces to the limit but keeps the full count', async () => {
    const full = await engine.count('Qwen/Qwen3-8B', samples[0], false);
    const r = await engine.tokenize('Qwen/Qwen3-8B', samples[0], false, 3);
    expect(r.ids).toHaveLength(3);
    expect(r.pieces).toHaveLength(3);
    expect(r.tokenCount).toBe(full.tokenCount);
  });

  it('lists bundled models and no downloads', async () => {
    expect(engine.bundled()).toHaveLength(50);
    expect(await engine.listDownloaded()).toEqual([]);
  });

  it('rejects pending requests on dispose', async () => {
    const e2 = new TokenEngine({
      packDir: resolve('dist/pack'),
      storageDir: await mkdtemp(join(tmpdir(), 'engine-')),
      workerPath: resolve('dist/worker.js'),
      getToken: async () => undefined,
      fetchImpl: fetchFake,
    });
    const p = e2.count('google/gemma-4-31B-it', 'x'.repeat(100000), false);
    const assertion = expect(p).rejects.toBeInstanceOf(Error);
    await e2.dispose();
    await assertion;
  });
});
