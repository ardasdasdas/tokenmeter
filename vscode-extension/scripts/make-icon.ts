// Renders the repo's logo mark to media/icon.png (256x256) for the Marketplace.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, '..', 'app', 'static', 'logo-mark.svg'), 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } }).render().asPng();
await mkdir(join(root, 'media'), { recursive: true });
await writeFile(join(root, 'media', 'icon.png'), png);
console.log(`media/icon.png: ${png.length} bytes`);
