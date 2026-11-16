import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DownloadStore, type FetchLike } from '../core/downloads.ts';
import { TokenmeterError } from '../core/errors.ts';
import { normalizeModelId } from '../core/modelId.ts';
import { readModelList, type BundledModel } from '../core/models.ts';
import type {
  CountResult,
  TokenizeResult,
  WorkerData,
  WorkerRequest,
  WorkerResponse,
  WorkerSuccess,
} from './protocol.ts';

export type { CountResult, Source, TokenizeResult } from './protocol.ts';

export interface EngineOptions {
  packDir: string;
  storageDir: string;
  workerPath: string;
  getToken: () => Promise<string | undefined>;
  fetchImpl?: FetchLike;
}

interface Pending {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}

const DEFAULT_LIMIT = 4000;

export class TokenEngine {
  private readonly opts: EngineOptions;
  private readonly store: DownloadStore;
  private worker: Worker | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private models: BundledModel[] | undefined;
  private disposed = false;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.store = new DownloadStore(opts.storageDir, opts.fetchImpl);
  }

  /** Bundled models, read from models.json next to the pack. */
  bundled(): BundledModel[] {
    this.models ??= readModelList(JSON.parse(readFileSync(join(this.opts.packDir, 'models.json'), 'utf8')));
    return this.models;
  }

  async count(model: string, text: string, special: boolean): Promise<CountResult> {
    const r = await this.request(model, text, special, null);
    return { model: r.model, tokenCount: r.tokenCount, charCount: r.charCount, source: r.source };
  }

  async tokenize(
    model: string,
    text: string,
    special: boolean,
    limit: number = DEFAULT_LIMIT,
  ): Promise<TokenizeResult> {
    const r = await this.request(model, text, special, limit);
    return { ...r, ids: r.ids ?? [], pieces: r.pieces ?? [] };
  }

  listDownloaded(): Promise<string[]> {
    return this.store.list();
  }

  removeDownloaded(id: string): Promise<boolean> {
    return this.store.remove(id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.failAll(new Error('Tokenizer engine was disposed'));
    await worker?.terminate();
  }

  private async request(
    model: string,
    text: string,
    special: boolean,
    limit: number | null,
  ): Promise<WorkerSuccess['result']> {
    const id = normalizeModelId(model);
    const base = { model: id, text, special, limit };
    let res = await this.send(base);
    if (!res.ok && res.code === 'need_file') {
      // Not in memory or the pack: use the cached download or fetch it here, then let the worker load it.
      const cached = await access(this.store.filePath(id)).then(
        () => true,
        () => false,
      );
      const file = await this.store.ensure(id, await this.opts.getToken());
      res = await this.send({ ...base, file, fileSource: cached ? 'downloaded' : 'downloaded-now' });
    }
    if (!res.ok) throw new TokenmeterError(res.code === 'need_file' ? 'corrupt' : res.code, res.message);
    return res.result;
  }

  private send(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new Error('Tokenizer engine was disposed'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...req, id });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const data: WorkerData = { packDir: this.opts.packDir };
    const worker = new Worker(this.opts.workerPath, { workerData: data });
    worker.on('message', (res: WorkerResponse) => {
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      p.resolve(res);
    });
    // A crashed worker rejects what was in flight; the next request starts a fresh one.
    const lost = (e: Error) => {
      if (this.worker === worker) this.worker = undefined;
      this.failAll(e);
    };
    worker.on('error', lost);
    worker.on('exit', (code) => lost(new Error(`Tokenizer worker exited (code ${code})`)));
    this.worker = worker;
    return worker;
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
