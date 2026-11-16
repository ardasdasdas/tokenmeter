import { describe, expect, it } from 'vitest';
import {
  clickToCountView,
  errorView,
  loadingView,
  resultView,
  type ResultInput,
} from '../../src/ui/statusModel.ts';

const base: ResultInput = {
  currentModel: 'google/gemma-4-31B-it',
  result: { model: 'google/gemma-4-31B-it', tokenCount: 1234, charCount: 5000, source: 'bundled' },
  what: 'document',
  threshold: 0,
};

describe('resultView', () => {
  it('drops a result of a model other than the current one', () => {
    expect(resultView({ ...base, currentModel: 'Qwen/Qwen3-8B' })).toBeUndefined();
  });

  it('formats the status text', () => {
    expect(resultView(base)?.text).toBe('$(symbol-numeric) 1,234 tokens · gemma-4-31B-it');
  });

  it('describes the count in the tooltip', () => {
    const lines = resultView(base)!.tooltip;
    expect(lines.join('\n')).toContain('google/gemma-4-31B-it');
    expect(lines.join('\n')).toContain('document');
    expect(lines.join('\n')).toContain('5,000');
    expect(lines.join('\n')).toContain('4.05');
    expect(lines.join('\n')).toContain('bundled');
  });

  it('shows downloaded-now as downloaded', () => {
    const v = resultView({ ...base, result: { ...base.result, source: 'downloaded-now' } })!;
    expect(v.tooltip.join('\n')).toContain('downloaded');
    expect(v.tooltip.join('\n')).not.toContain('downloaded-now');
  });

  it('threshold 0 is off', () => {
    const v = resultView({ ...base, threshold: 0 })!;
    expect(v.warning).toBe(false);
    expect(v.tooltip.join('\n')).not.toContain('Over the limit');
  });

  it('warns when over the threshold', () => {
    const v = resultView({ ...base, threshold: 1000 })!;
    expect(v.warning).toBe(true);
    expect(v.tooltip).toContain('Over the limit by 234 tokens (limit 1,000)');
  });

  it('does not warn at or under the threshold', () => {
    expect(resultView({ ...base, threshold: 1234 })!.warning).toBe(false);
    expect(resultView({ ...base, threshold: 2000 })!.warning).toBe(false);
  });

  it('handles an empty text without dividing by zero', () => {
    const v = resultView({ ...base, result: { ...base.result, tokenCount: 0, charCount: 0 } })!;
    expect(v.text).toBe('$(symbol-numeric) 0 tokens · gemma-4-31B-it');
  });
});

describe('other views', () => {
  it('loading', () => {
    expect(loadingView().text).toBe('$(loading~spin) …');
  });

  it('click to count', () => {
    expect(clickToCountView('Qwen/Qwen3-8B').text).toBe('$(symbol-numeric) Click to count · Qwen3-8B');
  });

  it('error', () => {
    const v = errorView('Qwen/Qwen3-8B', 'boom');
    expect(v.text).toBe('$(warning) Tokenmeter · Qwen3-8B');
    expect(v.tooltip).toEqual(['boom']);
  });
});
