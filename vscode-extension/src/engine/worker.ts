import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Tokenizer } from '@huggingface/tokenizers';
import { TokenmeterError } from '../core/errors.ts';
import { Pack } from '../core/pack.ts';
import { tokenPieces } from '../core/pieces.ts';
import type { Source, WorkerData, WorkerFailure, WorkerRequest, WorkerResponse } from './protocol.ts';

const MAX_LOADED = 2;
const { packDir } = workerData as WorkerData;

interface Loaded {
  tok: Tokenizer;
  source: Source;
}

class NeedFile extends Error {}

// Map iteration order = recency (entries are re-inserted on use).
const loaded = new Map<string, Loaded>();
let packPromise: Promise<Pack | undefined> | undefined;

function getPack(): Promise<Pack | undefined> {
  packPromise ??= Pack.open(packDir).catch(() => undefined);
  return packPromise;
}

function remember(model: string, entry: Loaded): void {
  loaded.delete(model);
  loaded.set(model, entry);
  while (loaded.size > MAX_LOADED) {
    loaded.delete(loaded.keys().next().value as string);
  }
}

function build(doc: unknown): Tokenizer {
  try {
    return new Tokenizer(doc as Record<string, unknown>, {});
  } catch (e) {
    throw new TokenmeterError('corrupt', `Could not read tokenizer.json: ${(e as Error).message}`);
  }
}

async function resolveTokenizer(req: WorkerRequest): Promise<{ entry: Loaded; source: Source }> {
  const hit = loaded.get(req.model);
  if (hit) {
    remember(req.model, hit);
    return { entry: hit, source: hit.source };
  }
  const pack = await getPack();
  let entry: Loaded;
  if (pack?.has(req.model)) {
    entry = { tok: build(await pack.load(req.model)), source: 'bundled' };
  } else if (req.file !== undefined) {
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(req.file, 'utf8'));
    } catch (e) {
      throw new TokenmeterError('corrupt', `Could not read tokenizer.json: ${(e as Error).message}`);
    }
    entry = { tok: build(doc), source: 'downloaded' };
  } else {
    throw new NeedFile();
  }
  remember(req.model, entry);
  // Only the call that loaded a file the main thread just downloaded reports 'downloaded-now'.
  const source = entry.source === 'downloaded' && req.fileSource === 'downloaded-now' ? 'downloaded-now' : entry.source;
  return { entry, source };
}

function describe(e: unknown): Pick<WorkerFailure, 'code' | 'message'> {
  if (e instanceof NeedFile) return { code: 'need_file', message: 'Tokenizer file required' };
  if (e instanceof TokenmeterError) return { code: e.code, message: e.message };
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    const {
      entry: { tok },
      source,
    } = await resolveTokenizer(req);
    const enc = tok.encode(req.text, { add_special_tokens: req.special });
    const result: Extract<WorkerResponse, { ok: true }>['result'] = {
      model: req.model,
      tokenCount: enc.ids.length,
      charCount: [...req.text].length,
      source,
    };
    if (req.limit !== null) {
      result.ids = enc.ids.slice(0, req.limit);
      result.pieces = tokenPieces(tok, enc.ids, enc.tokens, req.limit);
    }
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, ...describe(e) };
  }
}

const port = parentPort;
if (!port) throw new Error('worker.ts must run inside a worker thread');

// Messages are processed strictly in order; handle() never rejects.
let chain: Promise<void> = Promise.resolve();
port.on('message', (req: WorkerRequest) => {
  chain = chain.then(async () => {
    port.postMessage(await handle(req));
  });
});
