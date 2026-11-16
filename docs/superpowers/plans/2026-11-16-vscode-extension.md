# Tokenmeter VS Code Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension that shows the token count of the active document or selection for a chosen Hugging Face model, with 50 models' tokenizers bundled for offline use and any other model downloadable.

**Architecture:** `vscode-extension/` is a self-contained npm project in this repo. `src/core/` is plain TypeScript with no `vscode` import (unit-tested with vitest). Tokenizer loading and encoding run in a `worker_threads` worker (`src/engine/`). `src/ui/` + `src/extension.ts` hold everything that touches the VS Code API. A Node script builds a content-addressed, brotli-compressed "pack" of the bundled tokenizers at build time; the pack is not committed.

**Tech Stack:** TypeScript (erasable syntax only), Node ≥ 24 for scripts, esbuild bundling, vitest, `@huggingface/tokenizers@0.2.0`, `@vscode/test-cli` + `@vscode/test-electron`, `@vscode/vsce`. Python (repo `.venv`, `tokenizers` already installed) only for generating golden test IDs.

**Spec:** `docs/superpowers/specs/2026-11-16-vscode-extension-design.md` — read it before starting any task.

## Global Constraints

- All extension code lives under `vscode-extension/`. Do not change `app/`, `tests/` (Python) or the website, except `.github/workflows/pages.yml` in Task 8.
- `package.json` `engines.vscode`: `^1.100.0`; `@types/vscode`: `1.100.0` exactly.
- npm dependency versions are pinned exactly (no `^`/`~`), each the newest release that is at least 14 days old on the day you install it (check with `npm view <pkg> time`). Exception: `@huggingface/tokenizers` is exactly `0.2.0`.
- Only runtime dependency: `@huggingface/tokenizers`. Everything else is a devDependency. Compression uses Node's built-in `zlib` brotli.
- TypeScript must be erasable-only (`"erasableSyntaxOnly": true` in tsconfig): no enums, namespaces or constructor parameter properties. Scripts in `scripts/*.ts` run directly with `node scripts/<name>.ts`.
- User-visible strings are English. Status bar text format exactly: `$(symbol-numeric) 1,234 tokens · gemma-4-31B-it` (number with `en-US` grouping, model name = part after the `/`).
- The user's text never leaves the machine. Network is used only to download `tokenizer.json` and query `https://huggingface.co/api/models/<id>`.
- The HF token is sent only to hosts exactly `huggingface.co`; never on redirects to other hosts.
- Bundled model data: `vscode-extension/models.json` is a copy of `docs/superpowers/plans/data/models.json` (50 models, 32 distinct `sha256`, each with pinned `revision`). Do not edit the list.
- Pack size gate: total size of `dist/pack/` > 60 MB → build fails. `.vsix` > 60 MB → CI fails.
- Default model: `google/gemma-4-31B-it`. Settings: `tokenmeter.model` (string), `tokenmeter.includeSpecialTokens` (boolean, false), `tokenmeter.warningThreshold` (number, 0 = off), `tokenmeter.maxDocumentSize` (number, 500000); all `"scope": "window"`.
- Token breakdown renders at most 4000 tokens (same as the website's `MAX_RENDER`).
- Commit after each task with a message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Fast typing / big files** — the extension host never blocks, and a slow, older count never overwrites a newer one in the status bar. Pinned by `LatestOnly` tests (Task 5) and the "stale result" test in Task 6.
2. **Switching model while a count is in flight** — the status bar ends showing the new model's count, never the old model's number with the new name. Pinned in Task 6 (`statusBar` test: result's `model` must equal the current setting or it is dropped).
3. **Offline** — bundled models work with no network; a downloaded model that is cached works offline; an uncached one shows the network error text in the tooltip and the extension keeps working. Pinned in Task 4 (fetch throws → `network` error) and Task 5 (bundled load does not call fetch).
4. **Token leak on redirect** — HF `resolve` URLs redirect to CDN hosts; `Authorization` must not follow. Pinned in Task 4.
5. **Emoji / multi-byte characters in the breakdown** — byte-level tokens that split a character must not show broken characters; pieces stay one-per-token. Pinned in Task 5 (`pieces` test with `"🚀 Çok"`).

---

### Task 1: Project scaffold, model ids and errors

**Files:**
- Create: `vscode-extension/package.json`, `vscode-extension/tsconfig.json`, `vscode-extension/.gitignore`, `vscode-extension/vitest.config.ts`, `vscode-extension/models.json` (copy of `docs/superpowers/plans/data/models.json`)
- Create: `vscode-extension/src/core/errors.ts`, `vscode-extension/src/core/modelId.ts`, `vscode-extension/src/core/models.ts`
- Test: `vscode-extension/test/unit/modelId.test.ts`, `vscode-extension/test/unit/models.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = 'invalid' | 'gated' | 'not_found' | 'no_tokenizer' | 'network' | 'too_large' | 'corrupt'`
  - `class TokenmeterError extends Error { readonly code: ErrorCode; constructor(code: ErrorCode, message: string) }`
  - `normalizeModelId(raw: string): string` — throws `TokenmeterError('invalid', ...)`
  - `shortName(id: string): string` — part after `/`
  - `interface BundledModel { id: string; family: string; license: string; revision: string; sha256: string; size: number }`
  - `readModelList(json: unknown): BundledModel[]` — validates shape, throws `Error` on bad data

- [ ] **Step 1: Scaffold** — `package.json` with `"name": "tokenmeter"`, `"displayName": "Tokenmeter"`, `"publisher": "ardasdasdas"`, `"license": "MIT"`, `"version": "0.1.0"`, `"type": "commonjs"`, `"main": "./dist/extension.js"`, `engines.vscode`, repository `https://github.com/ardasdasdas/tokenmeter`, scripts `"test:unit": "vitest run"`, `"typecheck": "tsc --noEmit"`. tsconfig: `strict`, `module`/`moduleResolution` `nodenext`, `target` `es2022`, `erasableSyntaxOnly`, `noEmit`. `.gitignore`: `node_modules/`, `dist/`, `.cache/`, `*.vsix`, `.vscode-test/`. Install devDependencies: `typescript`, `vitest`, `@types/node`, `@types/vscode@1.100.0`, and dependency `@huggingface/tokenizers@0.2.0`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/unit/modelId.test.ts — cases copied from the Python tests (tests/test_tokenizer_cache.py)
it.each([
  ['google/gemma-4-31B-it', 'google/gemma-4-31B-it'],
  ['  google/gemma-4-31B-it \n', 'google/gemma-4-31B-it'],
  ['https://huggingface.co/google/gemma-4-31B-it', 'google/gemma-4-31B-it'],
  ['https://huggingface.co/Qwen/Qwen3-8B/tree/main?x=1', 'Qwen/Qwen3-8B'],
  ['hf.co/openai/gpt-oss-20b/', 'openai/gpt-oss-20b'],
])('normalizes %s', (raw, id) => expect(normalizeModelId(raw)).toBe(id));
it.each(['', 'gpt2-only-name', 'a/b c', '../etc/passwd'])('rejects %j', (raw) => {
  expect(() => normalizeModelId(raw)).toThrow(TokenmeterError);
  try { normalizeModelId(raw) } catch (e) { expect((e as TokenmeterError).code).toBe('invalid'); }
});
it('shortName', () => expect(shortName('google/gemma-4-31B-it')).toBe('gemma-4-31B-it'));

// test/unit/models.test.ts
it('reads the bundled list', () => {
  const list = readModelList(JSON.parse(readFileSync('models.json', 'utf8')));
  expect(list).toHaveLength(50);
  expect(new Set(list.map((m) => m.sha256)).size).toBe(32);
  expect(list.find((m) => m.id === 'google/gemma-4-31B-it')?.family).toBe('Gemma');
});
it('rejects malformed data', () => expect(() => readModelList({ models: [{ id: 1 }] })).toThrow());
```

- [ ] **Step 3: Run** `npx vitest run` → FAIL (modules missing).
- [ ] **Step 4: Implement** `errors.ts`, `modelId.ts` (same regex rules as `app/tokenizer_cache.py::normalize_model_id`: strip optional `http(s)://`, `www.`, `huggingface.co/` or `hf.co/`, drop `?`/`#` parts and trailing `/`, keep first two path segments, must match `^[A-Za-z0-9][\w.\-]*/[\w.\-]+$`; message `Invalid model name. Use the 'owner/model' format, e.g. google/gemma-4-31B-it.`), `models.ts`.
- [ ] **Step 5: Run** `npx vitest run && npx tsc --noEmit` → PASS.
- [ ] **Step 6: Commit** `feat(vscode): scaffold extension with model ids and bundled list`

---

### Task 2: Pack format (split, write, read, assemble)

**Files:**
- Create: `vscode-extension/src/core/pack.ts`
- Test: `vscode-extension/test/unit/pack.test.ts`

**Interfaces:**
- Consumes: `BundledModel` (Task 1)
- Produces:
  - `type Layout = Array<[key: string, part: string] | [key: 'model', sub: Array<[key: string, part: string]>]>` — ordered; `part` is the sha256 hex of the part's serialized JSON
  - `splitTokenizer(doc: Record<string, unknown>): { layout: Layout; parts: Map<string, string> }` — map from part hash to `JSON.stringify(value)`; the `model` key is split into its own keys when it is an object, every other top-level key is one part
  - `assemble(layout: Layout, getPart: (hash: string) => unknown): Record<string, unknown>`
  - `interface PackManifest { version: 1; files: Record<string /*file sha256*/, Layout>; models: Record<string /*model id*/, string /*file sha256*/> }`
  - `async function writePack(dir: string, entries: Array<{ fileSha256: string; doc: Record<string, unknown>; modelIds: string[] }>): Promise<{ bytes: number; parts: number }>` — writes `dir/manifest.json` and `dir/parts/<hash>.br` (brotli, quality 11, `BROTLI_PARAM_SIZE_HINT` = input length); skips parts already written
  - `class Pack { static async open(dir: string): Promise<Pack>; has(id: string): boolean; ids(): string[]; fileOf(id: string): string | undefined; async load(id: string): Promise<Record<string, unknown>> }` — `load` decompresses only the parts that model needs; case-sensitive ids

- [ ] **Step 1: Write the failing tests** (use small synthetic tokenizer docs built in the test, not real files)

```ts
it('round-trips a document exactly', async () => {
  const doc = { version: '1.0', added_tokens: [{ id: 0, content: '<s>' }], normalizer: null,
    model: { type: 'BPE', vocab: { a: 0, '1': 1, 'ğ': 2 }, merges: [['a', 'ğ']] } };
  const { layout, parts } = splitTokenizer(doc);
  expect(assemble(layout, (h) => JSON.parse(parts.get(h)!))).toEqual(doc);
});
it('shares identical parts across files', async () => {
  const a = { model: { type: 'BPE', vocab: { x: 0 } }, added_tokens: [] };
  const b = { model: { type: 'BPE', vocab: { x: 0 } }, added_tokens: [{ id: 1, content: '<eos>' }] };
  const dir = await mkdtemp(join(tmpdir(), 'pack-'));
  const r = await writePack(dir, [
    { fileSha256: 'f1', doc: a, modelIds: ['o/a'] },
    { fileSha256: 'f2', doc: b, modelIds: ['o/b', 'o/b2'] },
  ]);
  expect(r.parts).toBe(4); // type, vocab, added_tokens(a), added_tokens(b)
  const pack = await Pack.open(dir);
  expect(pack.ids().sort()).toEqual(['o/a', 'o/b', 'o/b2']);
  expect(await pack.load('o/b2')).toEqual(b);
  expect(pack.has('o/missing')).toBe(false);
});
it('load of unknown id throws', async () => { /* expect rejects with Error */ });
```

- [ ] **Step 2: Run** `npx vitest run test/unit/pack.test.ts` → FAIL.
- [ ] **Step 3: Implement** `pack.ts` (sha256 via `node:crypto`, brotli via `node:zlib` promisified).
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit` → no errors.
- [ ] **Step 5: Commit** `feat(vscode): content-addressed tokenizer pack format`

---

### Task 3: Build the real pack, golden IDs, parity test, notices

**Files:**
- Create: `vscode-extension/scripts/build-pack.ts`, `vscode-extension/scripts/make-golden.py`, `vscode-extension/test/fixtures/samples.json`, `vscode-extension/test/fixtures/golden.json` (generated, committed)
- Generated (not committed): `vscode-extension/.cache/src/<sha256>.json`, `vscode-extension/dist/pack/`
- Generated (committed): `vscode-extension/THIRD_PARTY_NOTICES.md`
- Test: `vscode-extension/test/unit/parity.test.ts`
- Modify: `vscode-extension/package.json` (script `"build:pack": "node scripts/build-pack.ts"`)

**Interfaces:**
- Consumes: `readModelList`, `writePack`, `Pack` (Tasks 1–2)
- Produces: `dist/pack/` (used by Tasks 5–8); `golden.json` shape `{ "<file sha256>": number[][] }` — one ids array per sample, in `samples.json` order, `add_special_tokens=False`

- [ ] **Step 1: `samples.json`** — an array of exactly these 6 strings:
  `"Merhaba dünya! Tokenmeter ile metnin kaç token olduğunu öğrenebilirsin.\nİkinci satır."`, `"def f(x):\n    return x**2  # 🚀 emoji 日本語テキスト"`, `"   leading spaces and\ttabs   "`, `"The quick brown fox jumps over the lazy dog. Ünlü çiçekler, ŞĞÜÖÇİ ığüşöç."`, `""`, `"<|im_start|>user\nhello<|im_end|>"`.
- [ ] **Step 2: `build-pack.ts`** — for each distinct `sha256` in `models.json`: download `https://huggingface.co/<first model id>/resolve/<revision>/tokenizer.json` into `.cache/src/<sha256>.json` unless that file exists with matching sha256; verify sha256 (mismatch → exit 1 naming the model). Before downloading, call `https://huggingface.co/api/models/<id>` for **every** model and exit 1 if `gated` is truthy or `cardData.license` is not `apache-2.0`/`mit`. Then `writePack('dist/pack', ...)`, copy `models.json` to `dist/pack/models.json`, print `pack: <MB> MB, <n> parts, 32 files, 50 models`, exit 1 if > 60 MB. Write `THIRD_PARTY_NOTICES.md`: a sentence that the bundled `tokenizer.json` files belong to their authors under the listed licenses, then a table `Model | License | Source` with `https://huggingface.co/<id>/blob/<revision>/tokenizer.json`.
- [ ] **Step 3: Run** `npm run build:pack` → prints size; expected ≤ 50 MB (measured during design: 54.4 MB with gzip, brotli should be smaller). Report the number.
- [ ] **Step 4: `make-golden.py`** — `python scripts/make-golden.py` reads `models.json`, `samples.json`, `.cache/src/*.json`, encodes each sample with Python `tokenizers.Tokenizer.from_file(...).encode(text, add_special_tokens=False).ids`, writes `golden.json`. Run with `..\.venv\Scripts\python -I scripts/make-golden.py` from `vscode-extension/`.
- [ ] **Step 5: Write `parity.test.ts`** — skipped (`describe.skipIf`) when `dist/pack/manifest.json` is missing. For every distinct file: `pack.load(<a model id of that file>)` deep-equals `JSON.parse(.cache/src/<sha256>.json)` (skip this half if the cache file is missing), and `new Tokenizer(doc, {}).encode(sample, { add_special_tokens: false }).ids` equals `golden[sha256][i]` for every sample. Timeout 10 minutes.
- [ ] **Step 6: Run** `npx vitest run test/unit/parity.test.ts` → PASS for all 32 files. If any file mismatches, stop and report which file and sample (do not change the model list).
- [ ] **Step 7: Commit** scripts, fixtures, notices, package.json — `feat(vscode): build bundled tokenizer pack with parity tests`

---

### Task 4: Download store

**Files:**
- Create: `vscode-extension/src/core/downloads.ts`
- Test: `vscode-extension/test/unit/downloads.test.ts`

**Interfaces:**
- Consumes: `TokenmeterError`, `normalizeModelId`
- Produces:
  - `type FetchLike = (url: string, init?: { headers?: Record<string, string>; redirect?: 'manual'; signal?: AbortSignal }) => Promise<Response>`
  - `class DownloadStore { constructor(dir: string, fetchImpl?: FetchLike); filePath(id: string): string; async list(): Promise<string[]>; async remove(id: string): Promise<boolean>; async ensure(id: string, token?: string): Promise<string> }` — `ensure` returns the local file path; layout `dir/<owner>--<name>/tokenizer.json`

Behavior of `ensure`: if the file exists and `JSON.parse` succeeds → return it (no network). If it exists but fails to parse → delete and download. Download `https://huggingface.co/<id>/resolve/main/tokenizer.json` with `redirect: 'manual'`, following up to 5 redirects by hand, sending `Authorization: Bearer <token>` only when the URL's host is exactly `huggingface.co`. 60 s timeout (AbortSignal). Abort with `too_large` if `content-length` or bytes read exceed 200 MB. Write to `<file>.tmp`, parse to validate, rename. On HTTP 401/403/404: GET `https://huggingface.co/api/models/<id>` (token only if set): `gated` truthy → `gated`; 200 → `no_tokenizer`; else `not_found`. Fetch throwing → `network`. Messages (exact):
- gated, no token: `'<id>' is a gated model. Add a Hugging Face token (Tokenmeter: Set Hugging Face Token) and accept the license on the model page.`
- gated, with token: `'<id>' is a gated model. Check that your Hugging Face token is valid and that you accepted the license on the model page.`
- not_found: `'<id>' was not found. Check the name; private repos need a Hugging Face token.`
- no_tokenizer: `'<id>' has no tokenizer.json (this model is not supported).`
- network: `Could not reach Hugging Face: <error message>`
- too_large: `'<id>': tokenizer.json is larger than 200 MB.`
- corrupt (downloaded file does not parse): `Could not read tokenizer.json for '<id>': <parse error>`

- [ ] **Step 1: Write the failing tests** with a fake `FetchLike` that records calls:
  - `downloads, caches, and the second ensure makes no fetch call`
  - `follows a redirect to cdn-lfs.huggingface.co without the Authorization header` (assert the recorded headers of call 1 contain `Authorization`, call 2 does not)
  - `maps 401 + api gated:true to code 'gated' with the no-token message`
  - `maps 404 + api 200 to 'no_tokenizer'`, `maps 404 + api 404 to 'not_found'`
  - `fetch rejecting maps to 'network' and the message contains the error text`
  - `a corrupt cached file is replaced by a fresh download`
  - `list() returns 'owner/name' ids; remove() deletes and returns true, false when absent`
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS + typecheck.
- [ ] **Step 5: Commit** `feat(vscode): download store for non-bundled tokenizers`

---

### Task 5: Tokenizer worker, engine and latest-only queue

**Files:**
- Create: `vscode-extension/src/core/latestOnly.ts`, `vscode-extension/src/core/pieces.ts`, `vscode-extension/src/engine/protocol.ts`, `vscode-extension/src/engine/worker.ts`, `vscode-extension/src/engine/engine.ts`, `vscode-extension/esbuild.mjs`
- Test: `vscode-extension/test/unit/latestOnly.test.ts`, `vscode-extension/test/unit/pieces.test.ts`, `vscode-extension/test/unit/engine.test.ts`
- Modify: `package.json` scripts `"build": "node esbuild.mjs"`, `"test:unit": "npm run build && vitest run"`

**Interfaces:**
- Consumes: `Pack`, `DownloadStore`, `BundledModel`, `TokenmeterError`, `normalizeModelId`
- Produces:
  - `class LatestOnly<I, O> { constructor(run: (input: I) => Promise<O>); push(input: I): Promise<O | undefined> }` — runs one at a time; while running, only the newest pushed input waits; superseded pushes resolve `undefined`
  - `tokenPieces(tok: Tokenizer, ids: number[], tokens: string[], limit: number): string[]` — port of `pieces()` in `app/static/app.js` (group up to 4 ids while the decoded text contains `�`; prefix a space when the raw token starts with `▁` or `Ġ` and the text does not start with whitespace; one piece per token)
  - `type Source = 'bundled' | 'downloaded' | 'downloaded-now'`
  - `interface CountResult { model: string; tokenCount: number; charCount: number; source: Source }`
  - `interface TokenizeResult extends CountResult { ids: number[]; pieces: string[] }` (`ids`/`pieces` cut to `limit`)
  - `class TokenEngine { constructor(opts: { packDir: string; storageDir: string; workerPath: string; getToken: () => Promise<string | undefined>; fetchImpl?: FetchLike }); bundled(): BundledModel[] /* from pack + models.json in packDir */; count(model: string, text: string, special: boolean): Promise<CountResult>; tokenize(model: string, text: string, special: boolean, limit?: number /* 4000 */): Promise<TokenizeResult>; listDownloaded(): Promise<string[]>; removeDownloaded(id: string): Promise<boolean>; dispose(): Promise<void> }`
  - Errors from the worker or downloads reject with `TokenmeterError` (code preserved across the thread boundary).

Design notes: resolution order memory → bundled → downloaded → download (download happens on the main thread through `DownloadStore`, then the worker loads the file by path). The worker owns `Pack` and the `Tokenizer` instances, keeps at most **2** tokenizers (LRU), and processes messages in order. `charCount` counts code points (`[...text].length`). `bundled()` reads `dist/pack/models.json` (copied there by `build-pack.ts`, Task 3). esbuild bundles `src/extension.ts` → `dist/extension.js` and `src/engine/worker.ts` → `dist/worker.js` (platform node, format cjs, external `vscode`); until Task 6 creates `extension.ts`, bundle only the worker.

- [ ] **Step 1: Write the failing tests**
  - `latestOnly`: push A (slow), B, C while A runs → A resolves its value, B resolves `undefined`, C resolves its value; `run` called exactly for A and C.
  - `pieces`: with the Qwen3 tokenizer from the pack, `"Merhaba dünya! 🚀 Çok güzel."` gives exactly 11 pieces (one per token), the first three are `Mer`, `hab`, `a`, pieces 6–8 each contain `🚀` (the emoji's 3 byte tokens each show the whole emoji), and no piece contains `�`.
  - `engine` (skip if `dist/pack` missing; uses the built `dist/worker.js`): `count('Qwen/Qwen3-8B', <samples[0]>, false)` → `tokenCount` 25, `source 'bundled'`, and the fake fetch was never called; `count('openai/gpt-oss-20b', …)` equals `golden[...]` length for each sample; `count('nope/missing', 'x', false)` with fake fetch returning 404s rejects with code `not_found`; `tokenize(..., 3)` returns 3 ids and 3 pieces with the full `tokenCount`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS + typecheck.
- [ ] **Step 5: Measure** — log the time of `count` on 1 MB of text for `google/gemma-4-31B-it` (first call includes load). Report the number in your task summary; no assertion.
- [ ] **Step 6: Commit** `feat(vscode): tokenizer worker and engine`

---

### Task 6: Extension — status bar, model picker, commands, token secret

**Files:**
- Create: `vscode-extension/src/extension.ts`, `vscode-extension/src/config.ts`, `vscode-extension/src/ui/statusBar.ts`, `vscode-extension/src/ui/modelPicker.ts`, `vscode-extension/src/ui/countTarget.ts`, `vscode-extension/.vscode-test.mjs`
- Modify: `vscode-extension/package.json` (`contributes`, `activationEvents: ["onStartupFinished"]`, scripts `"test:ext": "vscode-test"`)
- Test: `vscode-extension/test/unit/countTarget.test.ts`, `vscode-extension/test/ext/smoke.test.ts`

**Interfaces:**
- Consumes: `TokenEngine`, `LatestOnly`, `normalizeModelId`, `shortName`, `TokenmeterError`
- Produces (used by Task 7):
  - `getConfig(): { model: string; includeSpecialTokens: boolean; warningThreshold: number; maxDocumentSize: number }`
  - `countTarget(doc: { getText(range?): string; uri: { scheme: string } }, selections: ReadonlyArray<{ isEmpty: boolean }>): { texts: string[]; what: 'selection' | 'document' } | undefined` — `undefined` for schemes other than `file`, `untitled`, `vscode-notebook-cell`, `vscode-remote`, `vscode-userdata`; non-empty selections → their texts, else the whole document
  - Command ids: `tokenmeter.selectModel`, `tokenmeter.addModel`, `tokenmeter.showBreakdown` (registered in Task 7), `tokenmeter.setHfToken`, `tokenmeter.clearHfToken`, `tokenmeter.removeModel`, `tokenmeter.countNow`
  - HF token secret key: `tokenmeter.hfToken` (in `context.secrets`)

Behavior: status bar item, right side, priority 100, command `tokenmeter.selectModel`. Updates on `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, `onDidChangeTextDocument` (active doc only) and config change, debounced 200 ms, through one `LatestOnly`. A result is shown only if `result.model` equals the current `getConfig().model`. Multi-selection count = sum of per-selection counts. Text above `maxDocumentSize` → `$(symbol-numeric) Click to count · <short>` and clicking runs `tokenmeter.countNow` once. Tooltip (MarkdownString): model id, what was counted, characters, chars/token (2 decimals), source (`bundled`/`downloaded`), and threshold info. Over threshold: `backgroundColor = new ThemeColor('statusBarItem.warningBackground')`, tooltip line `Over the limit by N tokens (limit L)`. While loading: `$(loading~spin) …`. Error: `$(warning) Tokenmeter · <short>`, tooltip = error message, and `showErrorMessage` once per (model, code). Hidden when no text editor or `countTarget` returns `undefined`.

Model picker (`QuickPick`): items in order: `$(add) New model…` (alwaysShow), separator `In use` (current model), separator `Downloaded` (each with a trash `QuickInputButton` → `removeDownloaded`), separator `Bundled` (label = id, description = family). Choosing an id updates `tokenmeter.model` at `ConfigurationTarget.Global` unless a workspace value exists, then at `Workspace`. `New model…` / `tokenmeter.addModel` → `showInputBox` validated with `normalizeModelId` (validation message on error), then a progress notification "Downloading tokenizer for <id>…" running `engine.count(id, '', false)`, then set the model. `setHfToken` → password input box → `secrets.store`; `clearHfToken` → `secrets.delete`. `removeModel` → quick pick of downloaded ids.

- [ ] **Step 1: Write the failing unit test** `countTarget.test.ts`: `output` scheme → `undefined`; one empty selection → `{ what: 'document', texts: [full] }`; two non-empty selections → `{ what: 'selection', texts: [a, b] }`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `config.ts`, `countTarget.ts`. **Run** → PASS.
- [ ] **Step 4: Implement** `statusBar.ts`, `modelPicker.ts`, `extension.ts` and the `contributes` block (commands with titles prefixed `Tokenmeter: `, the four settings with descriptions, defaults and `"scope": "window"`). `packDir` = `context.asAbsolutePath('dist/pack')`, `storageDir` = `context.globalStorageUri.fsPath + '/tokenizers'`, `workerPath` = `context.asAbsolutePath('dist/worker.js')`. Dispose the engine on deactivate.
- [ ] **Step 5: Write `smoke.test.ts`** (mocha via `@vscode/test-cli`, `.vscode-test.mjs` pointing at `dist/test/ext/*.test.js` built by esbuild, VS Code version `stable`): open an untitled document with `samples[0]`, set `tokenmeter.model` to `Qwen/Qwen3-8B`, wait up to 20 s for the extension's exported test hook `getStatusText()` (export it from `activate`'s return value) to equal `$(symbol-numeric) 25 tokens · Qwen3-8B`; switch the setting to `openai/gpt-oss-20b` and wait for its count (golden length) with the new short name.
- [ ] **Step 6: Run** `npm run build && npm run test:ext` → PASS. `npx tsc --noEmit` → clean.
- [ ] **Step 7: Commit** `feat(vscode): status bar count, model picker and commands`

---

### Task 7: Token breakdown webview

**Files:**
- Create: `vscode-extension/src/ui/breakdown.ts`, `vscode-extension/media/breakdown.css`, `vscode-extension/media/breakdown.js`
- Modify: `vscode-extension/src/extension.ts` (register `tokenmeter.showBreakdown`), `package.json` (command contribution, `editor/context` menu entry when `editorHasSelection`)
- Test: `vscode-extension/test/ext/breakdown.test.ts`

**Interfaces:**
- Consumes: `TokenEngine.tokenize`, `getConfig`, `countTarget`
- Produces: `showBreakdown(context: vscode.ExtensionContext, engine: TokenEngine): Promise<void>`; one panel at a time (`Tokenmeter: <short>` title, `ViewColumn.Beside`, `retainContextWhenHidden: false`), re-rendered when the command runs again

Webview content: header with model id, token count, characters, chars/token; a "Show IDs" checkbox; the tokens as `<span class="tok">` with the same whitespace markers as the website (`·` for space, `→` for tab, `↵` + newline), `title="#i · id N"`; note when `tokenCount > 4000` ("Showing the first 4,000 tokens; the count covers the full text."). Six token background colors defined from VS Code theme variables (e.g. `--vscode-charts-yellow` etc. mixed with transparency) so both light and dark themes are readable. Strict CSP with a nonce; script only toggles IDs; tokens are inserted with `textContent` (never `innerHTML`). Data is passed via `postMessage`.

- [ ] **Step 1: Write the failing test** — run the command on an untitled document containing `samples[1]` with model `Qwen/Qwen3-8B`; the test hook `getLastBreakdown()` (exported from `activate`) returns `{ model, tokenCount, pieces }` where `tokenCount` equals the golden length and `pieces.length === tokenCount`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm run build && npm run test:ext` → PASS.
- [ ] **Step 5: Commit** `feat(vscode): token breakdown view`

---

### Task 8: Packaging, icon, CI, README

**Files:**
- Create: `vscode-extension/scripts/make-icon.ts`, `vscode-extension/media/icon.png` (generated, committed), `vscode-extension/.vscodeignore`, `vscode-extension/README.md`, `vscode-extension/CHANGELOG.md`, `vscode-extension/LICENSE` (copy of repo `LICENSE`), `.github/workflows/vscode-extension.yml`
- Modify: `vscode-extension/package.json` (`icon`, `galleryBanner` `{ color: "#1E1B4B", theme: "dark" }`, `categories: ["Other"]`, `keywords`, script `"package": "vsce package"`), `.github/workflows/pages.yml` (`paths-ignore: ['vscode-extension/**']` on the push trigger), root `README.md` (new "VS Code extension" section)

- [ ] **Step 1: Icon** — `make-icon.ts` renders `app/static/logo-mark.svg` to a 256×256 PNG with `@resvg/resvg-js` (devDependency) into `media/icon.png`. Run it; commit the PNG.
- [ ] **Step 2: `.vscodeignore`** — ship only `dist/**` (bundles + pack), `media/**`, `README.md`, `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `package.json`. Exclude `src/`, `test/`, `scripts/`, `.cache/`, `node_modules/` (everything is bundled by esbuild), maps.
- [ ] **Step 3: Package locally** — `npm run build:pack && npm run build && npx vsce package` → `tokenmeter-0.1.0.vsix`. Check size ≤ 60 MB and list contents with `npx vsce ls`; no `.cache` or `src` files. Install it with `code --install-extension tokenmeter-0.1.0.vsix` is **not** part of this task (the controller verifies manually).
- [ ] **Step 4: Extension README** — what it does (both uses: prompt writing with threshold, general measuring), screenshot placeholder removed (no image until the controller takes one), commands table, settings table, bundled models (link to `THIRD_PARTY_NOTICES.md`), gated models and token, offline behavior, privacy line ("your text never leaves your machine"). English.
- [ ] **Step 5: Workflow** `vscode-extension.yml`: triggers `push` to `main` with `paths: ['vscode-extension/**', '.github/workflows/vscode-extension.yml']`, `pull_request` same paths, and `push` tags `vscode-v*`. Job on `ubuntu-latest`: checkout, setup-node (Node 24, npm cache keyed on `vscode-extension/package-lock.json`), then in `vscode-extension/`: `npm ci`, `npm run build:pack`, `npm run build`, `npm run typecheck`, `npx vitest run`, `xvfb-run -a npm run test:ext`, `npx vsce package`, fail if the `.vsix` > 60 MB, upload it as an artifact; on a `vscode-v*` tag create a GitHub Release with the `.vsix` (`gh release create "$GITHUB_REF_NAME" *.vsix --generate-notes`, `permissions: contents: write`). Use `actions/checkout@v7` (as in `pages.yml`) and the latest `actions/setup-node` and `actions/upload-artifact` majors (`gh api repos/actions/<name>/releases/latest`).
- [ ] **Step 6: Root README section** "VS Code extension": two lines + link to `vscode-extension/README.md` and to Releases.
- [ ] **Step 7: Commit** `chore(vscode): packaging, icon, CI and docs`
