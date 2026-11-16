import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { TokenmeterError } from '../../src/core/errors.ts';
import { DownloadStore, type FetchLike } from '../../src/core/downloads.ts';

const ID = 'meta-llama/Llama-3.1-8B';
const HF = `https://huggingface.co/${ID}/resolve/main/tokenizer.json`;
const API = `https://huggingface.co/api/models/${ID}`;
const BODY = JSON.stringify({ version: '1.0', model: { type: 'BPE' } });

type Call = { url: string; headers: Record<string, string> };
let dir: string;
let calls: Call[];

function fake(handler: (url: string) => Response | Promise<Response>): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    return handler(url);
  };
}

async function codeOf(p: Promise<unknown>): Promise<TokenmeterError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TokenmeterError);
    return e as TokenmeterError;
  }
  throw new Error('expected rejection');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenmeter-dl-'));
  calls = [];
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

it('downloads, caches, and the second ensure makes no fetch call', async () => {
  const store = new DownloadStore(dir, fake(() => new Response(BODY, { status: 200 })));
  const p = await store.ensure(ID);
  expect(p).toBe(store.filePath(ID));
  expect(await fs.readFile(p, 'utf8')).toBe(BODY);
  expect(calls).toHaveLength(1);
  await store.ensure(ID);
  expect(calls).toHaveLength(1);
});

it('follows a redirect to cdn-lfs.huggingface.co without the Authorization header', async () => {
  const cdn = 'https://cdn-lfs.huggingface.co/x/tokenizer.json';
  const store = new DownloadStore(
    dir,
    fake((url) =>
      url === HF
        ? new Response(null, { status: 302, headers: { location: cdn } })
        : new Response(BODY, { status: 200 }),
    ),
  );
  await store.ensure(ID, 'hf_secret');
  expect(calls).toHaveLength(2);
  expect(calls[0].headers['Authorization']).toBe('Bearer hf_secret');
  expect(calls[1].url).toBe(cdn);
  expect(calls[1].headers['Authorization']).toBeUndefined();
});

it("maps 401 + api gated:true to code 'gated' with the no-token message", async () => {
  const store = new DownloadStore(
    dir,
    fake((url) =>
      url === API
        ? new Response(JSON.stringify({ gated: 'manual' }), { status: 200 })
        : new Response('no', { status: 401 }),
    ),
  );
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('gated');
  expect(err.message).toBe(
    `'${ID}' is a gated model. Add a Hugging Face token (Tokenmeter: Set Hugging Face Token) and accept the license on the model page.`,
  );
});

it("maps 404 + api 200 to 'no_tokenizer'", async () => {
  const store = new DownloadStore(
    dir,
    fake((url) =>
      url === API
        ? new Response(JSON.stringify({ gated: false }), { status: 200 })
        : new Response('no', { status: 404 }),
    ),
  );
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('no_tokenizer');
  expect(err.message).toBe(`'${ID}' has no tokenizer.json (this model is not supported).`);
});

it("maps 404 + api 404 to 'not_found'", async () => {
  const store = new DownloadStore(dir, fake(() => new Response('no', { status: 404 })));
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('not_found');
  expect(err.message).toBe(
    `'${ID}' was not found. Check the name; private repos need a Hugging Face token.`,
  );
});

it("fetch rejecting maps to 'network' and the message contains the error text", async () => {
  const store = new DownloadStore(dir, async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('network');
  expect(err.message).toBe('Could not reach Hugging Face: getaddrinfo ENOTFOUND');
});

it('rejects content-length above the cap with too_large', async () => {
  const store = new DownloadStore(
    dir,
    fake(() => new Response(BODY, { status: 200, headers: { 'content-length': String(300 * 1024 * 1024) } })),
  );
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('too_large');
  expect(err.message).toBe(`'${ID}': tokenizer.json is larger than 200 MB.`);
});

it('a downloaded file that does not parse is corrupt and leaves no file', async () => {
  const store = new DownloadStore(dir, fake(() => new Response('not json', { status: 200 })));
  const err = await codeOf(store.ensure(ID));
  expect(err.code).toBe('corrupt');
  expect(err.message).toContain(`Could not read tokenizer.json for '${ID}': `);
  await expect(fs.access(store.filePath(ID))).rejects.toThrow();
});

it('a corrupt cached file is replaced by a fresh download', async () => {
  const store = new DownloadStore(dir, fake(() => new Response(BODY, { status: 200 })));
  await fs.mkdir(path.dirname(store.filePath(ID)), { recursive: true });
  await fs.writeFile(store.filePath(ID), '{broken');
  await store.ensure(ID);
  expect(calls).toHaveLength(1);
  expect(await fs.readFile(store.filePath(ID), 'utf8')).toBe(BODY);
});

it("list() returns 'owner/name' ids; remove() deletes and returns true, false when absent", async () => {
  const store = new DownloadStore(dir, fake(() => new Response(BODY, { status: 200 })));
  expect(await new DownloadStore(path.join(dir, 'missing')).list()).toEqual([]);
  await store.ensure(ID);
  expect(await store.list()).toEqual([ID]);
  expect(await store.remove(ID)).toBe(true);
  expect(await store.list()).toEqual([]);
  expect(await store.remove(ID)).toBe(false);
});
