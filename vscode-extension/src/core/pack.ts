import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

export type Layout = Array<
  [key: string, part: string] | [key: 'model', sub: Array<[key: string, part: string]>]
>;

export interface PackManifest {
  version: 1;
  files: Record<string, Layout>;
  models: Record<string, string>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitTokenizer(doc: Record<string, unknown>): {
  layout: Layout;
  parts: Map<string, string>;
} {
  const parts = new Map<string, string>();
  const add = (value: unknown): string => {
    const text = JSON.stringify(value);
    const hash = sha256(text);
    parts.set(hash, text);
    return hash;
  };
  const layout: Layout = [];
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'model' && isPlainObject(value)) {
      layout.push([key, Object.entries(value).map(([k, v]): [string, string] => [k, add(v)])]);
    } else {
      layout.push([key, add(value)] as [string, string]);
    }
  }
  return { layout, parts };
}

export function assemble(
  layout: Layout,
  getPart: (hash: string) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of layout) {
    if (typeof value === 'string') {
      out[key] = getPart(value);
    } else {
      const model: Record<string, unknown> = {};
      for (const [k, hash] of value) model[k] = getPart(hash);
      out[key] = model;
    }
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writePack(
  dir: string,
  entries: Array<{ fileSha256: string; doc: Record<string, unknown>; modelIds: string[] }>,
): Promise<{ bytes: number; parts: number }> {
  const partsDir = join(dir, 'parts');
  await mkdir(partsDir, { recursive: true });
  const manifest: PackManifest = { version: 1, files: {}, models: {} };
  const written = new Set<string>();
  let bytes = 0;
  for (const { fileSha256, doc, modelIds } of entries) {
    const { layout, parts } = splitTokenizer(doc);
    manifest.files[fileSha256] = layout;
    for (const id of modelIds) manifest.models[id] = fileSha256;
    for (const [hash, text] of parts) {
      if (written.has(hash)) continue;
      const path = join(partsDir, `${hash}.br`);
      if (!(await exists(path))) {
        const input = Buffer.from(text, 'utf8');
        const packed = await compress(input, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 11,
            [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          },
        });
        await writeFile(path, packed);
        bytes += packed.length;
      }
      written.add(hash);
    }
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { bytes, parts: written.size };
}

export class Pack {
  private readonly dir: string;
  private readonly manifest: PackManifest;

  private constructor(dir: string, manifest: PackManifest) {
    this.dir = dir;
    this.manifest = manifest;
  }

  static async open(dir: string): Promise<Pack> {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as PackManifest;
    return new Pack(dir, manifest);
  }

  has(id: string): boolean {
    return Object.hasOwn(this.manifest.models, id);
  }

  ids(): string[] {
    return Object.keys(this.manifest.models);
  }

  fileOf(id: string): string | undefined {
    return this.has(id) ? this.manifest.models[id] : undefined;
  }

  async load(id: string): Promise<Record<string, unknown>> {
    const file = this.fileOf(id);
    const layout = file === undefined ? undefined : this.manifest.files[file];
    if (layout === undefined) throw new Error(`Model not in pack: ${id}`);
    const hashes: string[] = [];
    for (const [, value] of layout) {
      if (typeof value === 'string') hashes.push(value);
      else for (const [, hash] of value) hashes.push(hash);
    }
    const cache = new Map<string, unknown>();
    await Promise.all(
      [...new Set(hashes)].map(async (hash) => {
        const packed = await readFile(join(this.dir, 'parts', `${hash}.br`));
        cache.set(hash, JSON.parse((await decompress(packed)).toString('utf8')));
      }),
    );
    return assemble(layout, (hash) => cache.get(hash));
  }
}
