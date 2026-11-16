import type { CountResult } from '../engine/engine.ts';
import { shortName } from '../core/modelId.ts';

export interface StatusView {
  text: string;
  /** Tooltip paragraphs (Markdown). */
  tooltip: string[];
  warning: boolean;
}

export interface ResultInput {
  currentModel: string;
  result: CountResult;
  what: 'selection' | 'document';
  /** 0 = off. */
  threshold: number;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Status for a finished count; undefined when the result belongs to a model that is no longer selected. */
export function resultView(input: ResultInput): StatusView | undefined {
  const { currentModel, result, what, threshold } = input;
  if (result.model !== currentModel) return undefined;
  const perToken = result.tokenCount > 0 ? (result.charCount / result.tokenCount).toFixed(2) : '–';
  const source = result.source === 'bundled' ? 'bundled' : 'downloaded';
  const tooltip = [
    `**${result.model}**`,
    `Counted: ${what}`,
    `Characters: ${fmt(result.charCount)}`,
    `Characters per token: ${perToken}`,
    `Tokenizer: ${source}`,
  ];
  const over = threshold > 0 && result.tokenCount > threshold;
  if (threshold > 0) tooltip.push(`Warning threshold: ${fmt(threshold)} tokens`);
  if (over) tooltip.push(`Over the limit by ${fmt(result.tokenCount - threshold)} tokens (limit ${fmt(threshold)})`);
  return {
    text: `$(symbol-numeric) ${fmt(result.tokenCount)} tokens · ${shortName(result.model)}`,
    tooltip,
    warning: over,
  };
}

export function loadingView(): StatusView {
  return { text: '$(loading~spin) …', tooltip: ['Counting tokens…'], warning: false };
}

export function clickToCountView(model: string): StatusView {
  return {
    text: `$(symbol-numeric) Click to count · ${shortName(model)}`,
    tooltip: ['The text is larger than `tokenmeter.maxDocumentSize`. Click to count it once.'],
    warning: false,
  };
}

export function errorView(model: string, message: string): StatusView {
  return { text: `$(warning) Tokenmeter · ${shortName(model)}`, tooltip: [message], warning: false };
}
