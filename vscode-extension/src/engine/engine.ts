import { readFileSync } from 'node:fs';
import { access, rm } from 'node:fs/promises';
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

/** One worker thread and the requests sent to it; events of a dead worker only touch its own requests. */
interface Handle {
  worker: Worker;
  pending: Map<number, Pending>;
  dead: boolean;
}

const DEFAULT_LIMIT = 4000;

export class TokenEngine {
  private readonly opts: EngineOptions;
  private readonly store: DownloadStore;
  private handle: Handle | undefined;
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
    const handle = this.handle;
    this.handle = undefined;
    if (handle) {
      handle.dead = true;
      failAll(handle, new TokenmeterError('internal', 'Tokenmeter engine was disposed.'));
      await handle.worker.terminate();
    }
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
      res = await this.loadDownloaded(id, base);
    }
    if (!res.ok) throw new TokenmeterError(res.code === 'need_file' ? 'internal' : res.code, res.message);
    return res.result;
  }

  /** Cached file goes straight to the worker (it parses it); the store is used only to download or re-download. */
  private async loadDownloaded(id: string, base: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const file = this.filePathOf(id);
    const cached = await access(file).then(
      () => true,
      () => false,
    );
    if (cached) {
      const res = await this.send({ ...base, file, fileSource: 'downloaded' });
      if (res.ok || res.code !== 'corrupt') return res;
      await rm(file, { force: true }).catch(() => undefined);
    }
    const fresh = await this.download(id);
    return this.send({ ...base, file: fresh, fileSource: 'downloaded-now' });
  }

  private filePathOf(id: string): string {
    return this.store.filePath(id);
  }

  private async download(id: string): Promise<string> {
    let token: string | undefined;
    try {
      token = await this.opts.getToken();
    } catch {
      token = undefined;
    }
    try {
      return await this.store.ensure(id, token);
    } catch (e) {
      if (e instanceof TokenmeterError) throw e;
      throw new TokenmeterError(
        'corrupt',
        `Could not read tokenizer.json for '${id}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private send(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    if (this.disposed) {
      return Promise.reject(new TokenmeterError('internal', 'Tokenmeter engine was disposed.'));
    }
    const handle = this.ensureHandle();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      handle.pending.set(id, { resolve, reject });
      handle.worker.postMessage({ ...req, id });
    });
  }

  private ensureHandle(): Handle {
    // A terminated worker has threadId -1; never send to it even if its exit event has not arrived yet.
    if (this.handle && !this.handle.dead && this.handle.worker.threadId !== -1) return this.handle;
    const data: WorkerData = { packDir: this.opts.packDir };
    const worker = new Worker(this.opts.workerPath, { workerData: data });
    const handle: Handle = { worker, pending: new Map(), dead: false };
    worker.on('message', (res: WorkerResponse) => {
      const p = handle.pending.get(res.id);
      if (!p) return;
      handle.pending.delete(res.id);
      p.resolve(res);
    });
    const lost = (detail: string) => {
      if (handle.dead) return;
      handle.dead = true;
      if (this.handle === handle) this.handle = undefined;
      failAll(
        handle,
        new TokenmeterError('internal', `Tokenmeter's tokenizer worker stopped unexpectedly: ${detail}`),
      );
    };
    worker.on('error', (e) => lost(e.message));
    worker.on('messageerror', (e: Error) => lost(e.message));
    worker.on('exit', (code) => lost(`exit code ${code}`));
    this.handle = handle;
    return handle;
  }
}

function failAll(handle: Handle, e: Error): void {
  for (const p of handle.pending.values()) p.reject(e);
  handle.pending.clear();
}
