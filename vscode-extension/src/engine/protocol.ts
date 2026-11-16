import type { ErrorCode } from '../core/errors.ts';

export type Source = 'bundled' | 'downloaded' | 'downloaded-now';

export interface CountResult {
  model: string;
  tokenCount: number;
  charCount: number;
  source: Source;
}

export interface TokenizeResult extends CountResult {
  ids: number[];
  pieces: string[];
}

export interface WorkerData {
  packDir: string;
}

/**
 * Main -> worker. `limit` null means count only. `file` is a downloaded
 * tokenizer.json to load if the model is neither in memory nor in the pack.
 */
export interface WorkerRequest {
  id: number;
  model: string;
  text: string;
  special: boolean;
  limit: number | null;
  file?: string;
  fileSource?: 'downloaded' | 'downloaded-now';
}

export interface WorkerSuccess {
  id: number;
  ok: true;
  result: CountResult & { ids?: number[]; pieces?: string[] };
}

/** `need_file` asks the main thread to resolve a downloaded file and resend. */
export interface WorkerFailure {
  id: number;
  ok: false;
  code: ErrorCode | 'need_file';
  message: string;
}

export type WorkerResponse = WorkerSuccess | WorkerFailure;
