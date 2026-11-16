import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TokenmeterError } from './errors.ts';
import { normalizeModelId } from './modelId.ts';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'manual'; signal?: AbortSignal },
) => Promise<Response>;

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const HF_HOST = 'huggingface.co';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class DownloadStore {
  private readonly dir: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxBytes: number;
  private readonly inflight = new Map<string, Promise<string>>();
  private tmpCounter = 0;

  constructor(
    dir: string,
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
    options: { maxBytes?: number } = {},
  ) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  filePath(id: string): string {
    const norm = normalizeModelId(id);
    // Canonical ids only: reject anything normalization would rewrite (e.g. 'a/../../b' -> 'a/..').
    if (norm !== id || norm.split('/').some((part) => /^\.+$/.test(part))) {
      throw new TokenmeterError('invalid', `Invalid model name: ${id}`);
    }
    return path.join(this.dir, norm.replace('/', '--'), 'tokenizer.json');
  }

  async list(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    return entries
      .filter((d) => d.isDirectory() && d.name.includes('--'))
      .map((d) => d.name.replace('--', '/'))
      .sort();
  }

  async remove(id: string): Promise<boolean> {
    const folder = path.dirname(this.filePath(id));
    try {
      await fs.access(folder);
    } catch {
      return false;
    }
    await fs.rm(folder, { recursive: true, force: true });
    return true;
  }

  ensure(rawId: string, token?: string): Promise<string> {
    const id = normalizeModelId(rawId);
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = this.doEnsure(id, token).finally(() => {
      this.inflight.delete(id);
    });
    this.inflight.set(id, p);
    return p;
  }

  private async doEnsure(id: string, token?: string): Promise<string> {
    const file = this.filePath(id);

    let cached: string | undefined;
    try {
      cached = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (cached !== undefined) {
      try {
        JSON.parse(cached);
        return file;
      } catch {
        await fs.rm(file, { force: true });
      }
    }

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await this.get(`https://${HF_HOST}/${id}/resolve/main/tokenizer.json`, token, signal);

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw await this.explainFailure(id, token, signal);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TokenmeterError('network', `Could not reach Hugging Face: HTTP ${res.status}`);
    }

    const tooLarge = () => new TokenmeterError('too_large', `'${id}': tokenizer.json is larger than 200 MB.`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw tooLarge();
          }
          chunks.push(value);
        }
      }
    } catch (e) {
      if (e instanceof TokenmeterError) throw e;
      throw new TokenmeterError('network', `Could not reach Hugging Face: ${errText(e)}`);
    }

    const text = Buffer.concat(chunks).toString('utf8');
    try {
      JSON.parse(text);
    } catch (e) {
      throw new TokenmeterError('corrupt', `Could not read tokenizer.json for '${id}': ${errText(e)}`);
    }

    const tmp = `${file}.${process.pid}.${this.tmpCounter++}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file);
    } catch (e) {
      throw new TokenmeterError('corrupt', `Could not read tokenizer.json for '${id}': ${errText(e)}`);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
    return file;
  }

  private async get(startUrl: string, token: string | undefined, signal: AbortSignal): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      const u = new URL(url);
      if (token && u.protocol === 'https:' && u.hostname === HF_HOST) headers['Authorization'] = `Bearer ${token}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers, redirect: 'manual', signal });
      } catch (e) {
        throw new TokenmeterError('network', `Could not reach Hugging Face: ${errText(e)}`);
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) {
          throw new TokenmeterError('network', 'Could not reach Hugging Face: too many redirects');
        }
        const next = new URL(location, url);
        if (next.protocol !== 'https:') {
          throw new TokenmeterError(
            'network',
            `Could not reach Hugging Face: insecure redirect to ${next.toString()}`,
          );
        }
        url = next.toString();
        continue;
      }
      return res;
    }
  }

  private async explainFailure(id: string, token: string | undefined, signal: AbortSignal): Promise<TokenmeterError> {
    const res = await this.get(`https://${HF_HOST}/api/models/${id}`, token, signal);
    let info: { gated?: unknown } | undefined;
    if (res.ok) {
      try {
        info = (await res.json()) as { gated?: unknown };
      } catch {
        info = undefined;
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    if (info?.gated) {
      return new TokenmeterError(
        'gated',
        token
          ? `'${id}' is a gated model. Check that your Hugging Face token is valid and that you accepted the license on the model page.`
          : `'${id}' is a gated model. Add a Hugging Face token (Tokenmeter: Set Hugging Face Token) and accept the license on the model page.`,
      );
    }
    if (res.ok) {
      return new TokenmeterError('no_tokenizer', `'${id}' has no tokenizer.json (this model is not supported).`);
    }
    return new TokenmeterError(
      'not_found',
      `'${id}' was not found. Check the name; private repos need a Hugging Face token.`,
    );
  }
}
