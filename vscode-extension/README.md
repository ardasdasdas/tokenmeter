# Tokenmeter for VS Code

Exact token counts for Hugging Face models, right in the status bar.

Tokenmeter uses each model's own `tokenizer.json`, so the number is what the model really sees, not an estimate. It is useful in two ways:

- **Writing prompts.** Set a token limit and the status bar turns yellow when your prompt goes over it.
- **Measuring anything.** Open any file or select some text and see its token count for the model you pick.

## Features

- **Live count** in the status bar for the active document or the current selection. With several selections the counts are added up.
- **50 popular open models built in**: Qwen, Gemma, gpt-oss, DeepSeek, GLM, Mistral, Phi, SmolLM, Granite, OLMo and more. They work offline with nothing to download.
- **Any other Hugging Face model** can be added by name, for example `owner/model` or a `huggingface.co/...` link. Its `tokenizer.json` is downloaded once and cached.
- **Token breakdown**: every token in color, with optional token IDs (**Tokenmeter: Show Token Breakdown**, also in the editor's right-click menu when text is selected).
- **Never blocks the editor.** Tokenizing runs in a background thread, and large documents (over `tokenmeter.maxDocumentSize` characters) are only counted when you click.

## Usage

Click the count in the status bar to pick a model. The list shows the model in use, your downloaded models and the bundled ones. Choose **New model…** to add another model by name.

## Commands

| Command | What it does |
|---|---|
| `Tokenmeter: Select Model` | Pick the model used for counting. |
| `Tokenmeter: Add Model` | Download a model's tokenizer by name and switch to it. |
| `Tokenmeter: Show Token Breakdown` | Show the tokens of the selection or document. |
| `Tokenmeter: Count Now` | Count a document that is larger than `maxDocumentSize`. |
| `Tokenmeter: Remove Downloaded Model` | Delete a downloaded tokenizer. |
| `Tokenmeter: Set Hugging Face Token` | Store a token for gated or private models. |
| `Tokenmeter: Clear Hugging Face Token` | Delete the stored token. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `tokenmeter.model` | `google/gemma-4-31B-it` | Model whose tokenizer is used. |
| `tokenmeter.includeSpecialTokens` | `false` | Also count special tokens such as BOS/EOS that the tokenizer adds. |
| `tokenmeter.warningThreshold` | `0` | Highlight the count when it is above this number. `0` turns it off. |
| `tokenmeter.maxDocumentSize` | `500000` | Larger documents are counted only when you click. |

## Bundled models

The tokenizers of 50 models are shipped inside the extension, each pinned to a fixed revision and checked by its SHA-256. All of them come from the model makers' official Hugging Face accounts and are licensed Apache-2.0 or MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full list.

## Gated and private models

Some models (for example `meta-llama/*`) need a Hugging Face access token. Run **Tokenmeter: Set Hugging Face Token**. The token is kept in VS Code's secret storage and is sent only to `huggingface.co`, never to other hosts.

## Offline

Bundled models always work offline. A downloaded model works offline once it is cached. If a model is not cached and there is no network, the status bar shows a warning and the rest of the extension keeps working.

## Privacy

Your text never leaves your machine. The network is used only to download `tokenizer.json` files from Hugging Face.

## License

MIT. This extension is part of [Tokenmeter](https://github.com/ardasdasdas/tokenmeter), which also has a [web version](https://ardasdasdas.github.io/tokenmeter/).
