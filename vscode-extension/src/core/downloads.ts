import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TokenmeterError } from './errors.ts';
import { normalizeModelId } from './modelId.ts';

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; redirect?: 'manual'; signal?: AbortSignal },
) => Promise<Response>;

const MAX_BYTES = 200 * 1024 * 1024;
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

  constructor(dir: string, fetchImpl: FetchLike = (url, init) => fetch(url, init)) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
  }

  filePath(id: string): string {
    return path.join(this.dir, id.replace('/', '--'), 'tokenizer.json');
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

  async ensure(rawId: string, token?: string): Promise<string> {
    const id = normalizeModelId(rawId);
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
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
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
          if (total > MAX_BYTES) {
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

    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
    return file;
  }

  private async get(startUrl: string, token: string | undefined, signal: AbortSignal): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = {};
      if (token && new URL(url).hostname === HF_HOST) headers['Authorization'] = `Bearer ${token}`;
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
        url = new URL(location, url).toString();
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
