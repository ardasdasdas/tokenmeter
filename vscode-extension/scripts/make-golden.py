import json
from pathlib import Path

from tokenizers import Tokenizer

root = Path(__file__).resolve().parent.parent
models = json.loads((root / "models.json").read_text(encoding="utf-8"))["models"]
samples = json.loads((root / "test/fixtures/samples.json").read_text(encoding="utf-8"))

golden = {}
for sha in sorted({m["sha256"] for m in models}):
    tok = Tokenizer.from_file(str(root / ".cache/src" / f"{sha}.json"))
    golden[sha] = [tok.encode(s, add_special_tokens=False).ids for s in samples]

# The OpenAI entries stand in for OpenAI's API models, whose tokenizer is tiktoken's
# o200k_base: check the bundled file against the official library (pip install tiktoken).
import tiktoken

o200k = tiktoken.get_encoding("o200k_base")
for sha in sorted({m["sha256"] for m in models if m["family"] == "OpenAI"}):
    for s, ids in zip(samples, golden[sha]):
        assert ids == o200k.encode(s, disallowed_special=()), f"{sha[:12]} differs from tiktoken o200k_base on {s[:30]!r}"
    print(f"{sha[:12]} matches tiktoken o200k_base on all samples")

(root / "test/fixtures/golden.json").write_text(json.dumps(golden), encoding="utf-8")
print(f"golden: {len(golden)} files x {len(samples)} samples")
