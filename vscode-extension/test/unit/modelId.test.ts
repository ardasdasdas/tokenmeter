import { expect, it } from 'vitest';
import { TokenmeterError } from '../../src/core/errors.ts';
import { normalizeModelId, shortName } from '../../src/core/modelId.ts';

it.each([
  ['google/gemma-4-31B-it', 'google/gemma-4-31B-it'],
  ['  google/gemma-4-31B-it \n', 'google/gemma-4-31B-it'],
  ['https://huggingface.co/google/gemma-4-31B-it', 'google/gemma-4-31B-it'],
  ['https://huggingface.co/Qwen/Qwen3-8B/tree/main?x=1', 'Qwen/Qwen3-8B'],
  ['hf.co/openai/gpt-oss-20b/', 'openai/gpt-oss-20b'],
])('normalizes %s', (raw, id) => expect(normalizeModelId(raw)).toBe(id));

it.each(['', 'gpt2-only-name', 'a/b c', '../etc/passwd'])('rejects %j', (raw) => {
  expect(() => normalizeModelId(raw)).toThrow(TokenmeterError);
  try {
    normalizeModelId(raw);
  } catch (e) {
    expect((e as TokenmeterError).code).toBe('invalid');
  }
});

it('shortName', () => expect(shortName('google/gemma-4-31B-it')).toBe('gemma-4-31B-it'));
