// Converts dist/pack (brotli parts, for the extension) into a pack the website can read:
// the same manifest, with each part gzip-compressed so browsers can open it with
// DecompressionStream('gzip'). Usage: node scripts/build-web-pack.ts [outDir]
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, constants, gzipSync } from 'node:zlib';
import { readModelList } from '../src/core/models.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packDir = join(root, 'dist', 'pack');
const outDir = resolve(process.argv[2] ?? join(root, '..', 'app', 'static', 'pack'));

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'parts'), { recursive: true });

let bytes = 0;
const parts = (await readdir(join(packDir, 'parts'))).filter((f) => f.endsWith('.br'));
for (const file of parts) {
  const json = brotliDecompressSync(await readFile(join(packDir, 'parts', file)));
  const gz = gzipSync(json, { level: constants.Z_BEST_COMPRESSION });
  await writeFile(join(outDir, 'parts', file.replace(/\.br$/, '.json.gz')), gz);
  bytes += gz.length;
}

const manifest = await readFile(join(packDir, 'manifest.json'), 'utf8');
await writeFile(join(outDir, 'manifest.json'), manifest);
const models = (await readModelList(JSON.parse(await readFile(join(root, 'models.json'), 'utf8')))).map((m) => ({ id: m.id, family: m.family }));
await writeFile(join(outDir, 'models.json'), JSON.stringify(models));

console.log(`web pack: ${parts.length} parts, ${(bytes / 1e6).toFixed(1)} MB -> ${outDir}`);
