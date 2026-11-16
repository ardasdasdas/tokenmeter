import { TokenmeterError } from './errors.ts';

const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/** Turns 'owner/name', a Hugging Face URL, or padded input into 'owner/name'. */
export function normalizeModelId(raw: string): string {
  let value = (raw ?? '').trim();
  value = value.replace(/^(https?:\/\/)?(www\.)?(huggingface\.co|hf\.co)\//, '');
  value = value.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  const parts = value.split('/');
  if (parts.length >= 2) {
    value = parts.slice(0, 2).join('/');
  }
  if (!REPO_RE.test(value)) {
    throw new TokenmeterError(
      'invalid',
      "Invalid model name. Use the 'owner/model' format, e.g. google/gemma-4-31B-it.",
    );
  }
  return value;
}

/** The part of a model id after the '/'. */
export function shortName(id: string): string {
  return id.slice(id.indexOf('/') + 1);
}
