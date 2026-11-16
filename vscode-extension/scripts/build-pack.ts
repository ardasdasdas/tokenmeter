import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModelList } from '../src/core/models.ts';
import type { BundledModel } from '../src/core/models.ts';
import { writePack } from '../src/core/pack.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, '.cache', 'src');
const packDir = join(root, 'dist', 'pack');
const MAX_BYTES = 60 * 1024 * 1024;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRetry(url: string): Promise<Response> {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status !== 429 && res.status < 500) return res;
    last = `${res.status}`;
    await sleep(1000 * (attempt + 1));
  }
  return fail(`Request failed after retries (${last}): ${url}`);
}

async function checkLicense(id: string): Promise<void> {
  const res = await fetchRetry(`https://huggingface.co/api/models/${id}`);
  if (!res.ok) fail(`HF API ${res.status} for ${id}`);
  const info = (await res.json()) as { gated?: unknown; cardData?: { license?: unknown } };
  if (info.gated) fail(`Model is gated: ${id}`);
  const license = info.cardData?.license;
  if (license !== 'apache-2.0' && license !== 'mit') {
    fail(`Unexpected license for ${id}: ${String(license)}`);
  }
}

async function readIfMatching(path: string, hash: string): Promise<Buffer | undefined> {
  try {
    const buf = await readFile(path);
    return sha256(buf) === hash ? buf : undefined;
  } catch {
    return undefined;
  }
}

const list = readModelList(JSON.parse(await readFile(join(root, 'models.json'), 'utf8')));

for (const model of list) await checkLicense(model.id);

const byFile = new Map<string, BundledModel[]>();
for (const model of list) {
  const group = byFile.get(model.sha256) ?? [];
  group.push(model);
  byFile.set(model.sha256, group);
}

await mkdir(srcDir, { recursive: true });
const entries: Array<{ fileSha256: string; doc: Record<string, unknown>; modelIds: string[] }> = [];
for (const [hash, models] of byFile) {
  const first = models[0]!;
  const path = join(srcDir, `${hash}.json`);
  let buf = await readIfMatching(path, hash);
  if (buf === undefined) {
    const url = `https://huggingface.co/${first.id}/resolve/${first.revision}/tokenizer.json`;
    console.log(`download ${first.id}`);
    const res = await fetchRetry(url);
    if (!res.ok) fail(`Download failed (${res.status}) for ${first.id}`);
    buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== hash) {
      fail(`sha256 mismatch for ${first.id}: expected ${hash}, got ${sha256(buf)}`);
    }
    await writeFile(path, buf);
  }
  entries.push({
    fileSha256: hash,
    doc: JSON.parse(buf.toString('utf8')) as Record<string, unknown>,
    modelIds: models.map((m) => m.id),
  });
}

await rm(packDir, { recursive: true, force: true });
const { parts } = await writePack(packDir, entries);
await copyFile(join(root, 'models.json'), join(packDir, 'models.json'));

let total = 0;
for (const name of await readdir(join(packDir, 'parts'))) {
  total += (await stat(join(packDir, 'parts', name))).size;
}
for (const name of ['manifest.json', 'models.json']) total += (await stat(join(packDir, name))).size;
console.log(
  `pack: ${(total / 1024 / 1024).toFixed(1)} MB, ${parts} parts, ${byFile.size} files, ${list.length} models`,
);

const rows = list.map(
  (m) => `| ${m.id} | ${m.license} | https://huggingface.co/${m.id}/blob/${m.revision}/tokenizer.json |`,
);
await writeFile(
  join(root, 'THIRD_PARTY_NOTICES.md'),
  [
    '# Third-party notices',
    '',
    'The bundled `tokenizer.json` files belong to their respective authors and are redistributed under the licenses listed below.',
    '',
    '| Model | License | Source |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'),
);

if (total > MAX_BYTES) fail(`Pack exceeds 60 MB: ${total} bytes`);
