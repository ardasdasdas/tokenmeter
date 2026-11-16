# Tokenmeter for VS Code — Design

Date: 2026-11-16 · Status: draft, awaiting approval

## Intent

Bring Tokenmeter into the editor. Two uses, both first-class:

1. **Prompt writing** — while writing a prompt/system message, see how many tokens it is for the
   target model, and get a visible warning when it passes a limit you set.
2. **General measuring** — check the token count of any file or selection, for any model.

The user's key idea: the `tokenizer.json` files of the ~50 most popular models ship **inside the
extension**, so it works offline the moment it is installed. Any other model can still be added
by name (downloaded from Hugging Face and cached), as on the website.

## Goals

- Exact counts, identical to the website and the Python server (same `tokenizer.json`, same
  library family: `@huggingface/tokenizers`).
- 50 bundled models, usable with no network.
- "+ New model" for anything else: paste `owner/model` or a `huggingface.co/...` link.
- Gated/private models via a Hugging Face token stored in VS Code SecretStorage.
- Live status bar count that follows the active editor and selection.
- Optional warning threshold for prompt writing.
- A token breakdown view (colored tokens, optional IDs), like the website's token view.

## Non-goals

- Cost/price calculation (the user explicitly said: tokens only, no money).
- Applying chat templates; raw text is counted.
- Models without a `tokenizer.json` (e.g. tiktoken/sentencepiece-only repos such as Kimi).
- Marketplace publishing in this round (needs the user's own publisher account and token;
  the build must be ready for it, see Distribution).
- Changing the website or the Python server.

## Anti-goals (would make this a failure even if it "works")

- Counts that differ from the website/server for the same model and text.
- Typing lag in large files.
- Bundling tokenizer files whose license does not allow redistribution, or files of gated repos.
- Sending the user's text anywhere. Only `tokenizer.json` downloads go over the network.

## Approaches considered

1. **Bundle the tokenizer files in the extension** — *chosen by the user.* ~45 MB extension,
   offline from install, no hosting. New bundled models need a new extension release.
2. Host the files on GitHub Releases, small extension downloads on first use. Rejected: first use
   needs network, more moving parts.
3. Download everything from Hugging Face on demand (what the website does). Rejected: the user
   wants the popular models kept by us and available offline.

## Bundled model list

Curated from Hugging Face on 2026-11-16: original repos of the major families (no quantized
re-uploads, no test models), **only ungated repos licensed Apache-2.0 or MIT**. 50 models map to
32 distinct `tokenizer.json` files (417 MB raw).

The list lives in `vscode-extension/models.json` (model id, family label, license, file sha256,
pinned HF commit). Initial list:

| Family | Models |
|---|---|
| Qwen | Qwen3.8-27B, Qwen3.6-35B-A3B, Qwen3.6-27B, Qwen3.5-9B, Qwen3.5-4B, Qwen3.5-2B, Qwen3.5-0.8B, Qwen3-0.6B, Qwen3-4B, Qwen3-8B, Qwen3-14B, Qwen3-30B-A3B, Qwen3-Coder-30B-A3B-Instruct, Qwen2.5-7B-Instruct, Qwen2.5-Coder-7B-Instruct |
| Gemma (google) | gemma-4-31B-it, gemma-4-26B-A4B-it, gemma-4-12B-it, gemma-4-E4B-it, gemma-4-E2B-it |
| gpt-oss (openai) | gpt-oss-20b, gpt-oss-120b |
| DeepSeek | DeepSeek-V4-Flash, DeepSeek-V4-Pro, DeepSeek-V3.2, DeepSeek-R1, DeepSeek-R1-Distill-Qwen-7B |
| GLM (zai-org) | GLM-5.1, GLM-5, GLM-4.7-Flash, GLM-4.5-Air, GLM-4.6 |
| Mistral | Mistral-7B-Instruct-v0.3, Ministral-3-14B-Instruct-2512, Ministral-3-8B-Instruct-2512, Devstral-Small-2-24B-Instruct-2512, Mistral-Small-3.1-24B-Instruct-2503, Mistral-Nemo-Instruct-2407 |
| Phi (microsoft) | Phi-4-mini-instruct, phi-4, Phi-3.5-mini-instruct |
| SmolLM (HuggingFaceTB) | SmolLM3-3B, SmolLM2-1.7B-Instruct |
| Granite (ibm-granite) | granite-4.1-3b, granite-4.2-8b |
| Others | allenai/Olmo-3-7B-Instruct, stepfun-ai/Step-3.5-Flash, tencent/Hy3, baidu/ERNIE-4.5-21B-A3B-Thinking, openai-community/gpt2 |

Left out on purpose: Llama 2/3 and Gemma 1–3 (gated), Nemotron, MiniMax M2+, LFM, Command
(license "other"/non-commercial). They remain available through "+ New model".

## Bundle format ("pack")

Measured on the 32 files: per-file gzip = 81.6 MB; storing shared JSON parts once = 54.4 MB
(gzip). Many files differ only in small sections (e.g. the five Gemma 4 files share the same
vocabulary), so the pack stores **content-addressed parts**:

- Each `tokenizer.json` is split into its top-level keys, and the `model` object further into its
  keys (`vocab`, `merges`, `type`, …). Each part is serialized and stored once, keyed by sha256,
  compressed with **brotli** (Node's built-in `zlib`), so no extra runtime dependency.
- A manifest maps each model id → its file → the ordered list of part hashes needed to rebuild it.
- At runtime the extension decompresses only the parts of the model being used and rebuilds the
  JSON object (no need to rebuild bytes; the tokenizer takes a parsed object).
- Target size: ≤ 50 MB for the whole `.vsix`.

Correctness gate: a build-time test rebuilds every bundled tokenizer from the pack and checks it is
deep-equal to the original `tokenizer.json`, and that encoding a fixed set of sample texts gives
identical token IDs.

The pack is **generated by a script, not committed** (it would put ~50 MB of binaries in git
history). `models.json` is committed; the script downloads the pinned revisions and builds the
pack. CI runs it before packaging.

## User experience

**Status bar** (right side): `$(symbol-numeric) 1,234 tokens · gemma-4-31B-it`

- Counts the selection(s) if any text is selected (sum across multiple selections), otherwise the
  whole active document. Tooltip shows model id, characters, chars/token, and what was counted.
- Updates on typing, selection change and editor switch, debounced (~200 ms).
- Hidden when there is no text editor. Clicking it opens the model picker.
- With a warning threshold set and exceeded, the item uses the warning background color and the
  tooltip says by how much.

**Model picker** (QuickPick, same structure as the website's dropdown):

- First item: `+ New model…` → input box accepting `owner/model` or a Hugging Face link.
- Then sections: *In use*, *Downloaded* (models fetched by the user, each with a remove button),
  *Bundled* (the 50, with family as description). Type to filter.

**Commands** (Command Palette, prefix "Tokenmeter:"):

- Select Model
- Add Model from Hugging Face…
- Show Token Breakdown — opens a webview with the colored token view for the selection/document
  (same look as the website, follows VS Code theme colors), with "show IDs" toggle.
- Set Hugging Face Token / Clear Hugging Face Token
- Remove Downloaded Model

**Settings:**

- `tokenmeter.model` (string, default `google/gemma-4-31B-it`)
- `tokenmeter.includeSpecialTokens` (boolean, default false)
- `tokenmeter.warningThreshold` (number, default 0 = off)
- `tokenmeter.maxDocumentSize` (number of characters, default 2,000,000): above this, the live
  count pauses and the status bar shows "click to count" to avoid lag.

**Errors**: same messages as the website/server (gated → "add a Hugging Face token…", not found,
no tokenizer.json, network), shown as a notification once and in the status bar tooltip.

## Architecture

New folder `vscode-extension/` in this repo (own `package.json`; the website and Python server are
untouched).

- `src/core/` — pure TypeScript, no `vscode` import, unit-testable in Node:
  - `normalizeModelId()` — same rules as the website.
  - `pack.ts` — read manifest, decompress and assemble a bundled tokenizer.
  - `downloads.ts` — fetch `tokenizer.json` from Hugging Face (optional bearer token), store under
    the extension's `globalStorageUri/tokenizers/<owner>--<name>/tokenizer.json`, list/remove.
  - `registry.ts` — resolves a model id: memory → downloaded → bundled → download.
  - `count.ts` — encode text, return count/ids/token pieces.
- `src/extension.ts` + `src/ui/` — status bar, quick pick, commands, webview, settings.
- `scripts/build-pack.mjs` — Node script: read `models.json`, download pinned files, build pack.
- Bundled with esbuild into a single `dist/extension.js`; the pack goes in `dist/pack/`.
- Tokenizer library: `@huggingface/tokenizers@0.2.0` (same as the website, verified identical IDs
  to the Python library on Qwen3, Gemma 4 and gpt-oss).
- Tokenization runs off the UI-critical path: debounce, and skip/abort stale requests. If
  measured encode time on a 1 MB document exceeds ~100 ms, move encoding to a worker thread.
- Minimum VS Code version: 1.100 (2025), so most users can install it.

## Testing

- Unit tests (vitest) for `core/`: id normalization, pack round-trip (all 50 models), download
  cache with a fake fetch, error mapping, count parity on sample texts against known IDs produced by
  the Python server.
- Extension smoke test with `@vscode/test-electron`: activates, status bar shows a count for an
  open document, model switch updates the count.
- Manual check in the Extension Development Host before release.

## Distribution

- GitHub Actions workflow `vscode-extension.yml`: build pack, test, `vsce package`, and on a
  `vscode-v*` tag attach the `.vsix` to a GitHub Release.
- README gets a "VS Code extension" section (install from `.vsix`; Marketplace later).
- Marketplace: the manifest is ready (name `tokenmeter`, display name "Tokenmeter", icon from the
  existing logo, MIT license, repository link). Publishing needs the user to create a publisher
  and a token; the `publisher` field is set to `ardasdasdas` as a placeholder until then.
- `THIRD_PARTY_NOTICES.md` in the extension lists every bundled model, its license and source URL.

## Decisions from review

Settled while reviewing the design (marked *my call* where the author decided without the user).

- **Size target** (*my call*): 50 MB is a goal, not a hard cap. The build prints the pack and
  `.vsix` sizes. Above 60 MB the build fails, so a person decides what to drop; the builder never
  removes models on their own.
- **Model list integrity**: every id in the table was checked against the Hugging Face API on
  2026-11-16 (exists, ungated, Apache-2.0/MIT, has `tokenizer.json`). `models.json` records the
  repo commit sha at curation time; the pack script downloads exactly that revision. The script
  re-checks gated status and license and **fails** on any change or missing file. No silent
  substitutions.
- **Source of truth for parity**: the Python `tokenizers` library with `add_special_tokens=False`
  (the server default). Golden token IDs for a fixed sample set are generated once with the
  Python server code and committed as test fixtures. Tests require (a) the rebuilt-from-pack
  object to be deep-equal to the parsed original and (b) JS IDs to equal the golden IDs.
- **Encoding API** (*my call*): `core` exposes an async `count()` and `tokenize()` from the
  start. The live status bar only needs the count; the breakdown view requests the full pieces.
  Whether encoding moves to a worker is still decided by measurement, without API changes.
- **Resolution order**: memory → bundled → downloaded → download. Selecting a bundled id via
  "+ New model" just selects the bundled copy.
- **Downloads** (*my call*): 60 s timeout, 200 MB size cap, write to a temp file, parse to
  validate, then rename. A cached file that fails to parse is deleted and downloaded again. The
  HF token is sent only to `huggingface.co`. Redirects are followed manually and the
  `Authorization` header is dropped on any other host.
- **Scope** (*my call*): count any text editor document, including untitled files and notebook
  cells (the active cell). Ignore output panels, the debug console and other non-`file`/
  `untitled`/`vscode-notebook-cell`/`vscode-remote` schemes. In a diff editor, count the side
  that has focus.
- **Settings scope** (*my call*): `tokenmeter.model`, `includeSpecialTokens` and
  `warningThreshold` can be set per user or per workspace (scope `window`), so a prompt
  project can pin its own model and limit.
- **CI**: the new workflow runs only on changes under `vscode-extension/**` (plus tags
  `vscode-v*`). `pages.yml` gets a `paths-ignore` for `vscode-extension/**`. GitHub runners reach
  Hugging Face without a token, since every bundled repo is ungated.

## Left to the builder

- Exact debounce timing, QuickPick button icons, webview styling details.
- Whether the token breakdown webview reuses the website's CSS or a VS Code-themed variant.
- Worker-thread split, if the performance measurement calls for it.
