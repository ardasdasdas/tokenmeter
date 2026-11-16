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

(root / "test/fixtures/golden.json").write_text(json.dumps(golden), encoding="utf-8")
print(f"golden: {len(golden)} files x {len(samples)} samples")
