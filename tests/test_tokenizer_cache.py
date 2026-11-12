import pytest
from fastapi.testclient import TestClient
from huggingface_hub.errors import (
    EntryNotFoundError,
    GatedRepoError,
    LocalEntryNotFoundError,
    RepositoryNotFoundError,
)
from tokenizers import Tokenizer, models, pre_tokenizers

from app.main import create_app
from app.tokenizer_cache import TokenizerCache, TokenizerError, normalize_model_id


@pytest.fixture
def tokenizer_file(tmp_path):
    vocab = {"[UNK]": 0, "merhaba": 1, "dünya": 2, "!": 3}
    tok = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    tok.pre_tokenizer = pre_tokenizers.Whitespace()
    path = tmp_path / "tokenizer.json"
    tok.save(str(path))
    return str(path)


class FakeHub:
    """hf_hub_download yerine geçer: yerel önbelleği ve uzak hataları taklit eder."""

    def __init__(self, path, remote_error=None):
        self.path = path
        self.remote_error = remote_error
        self.local = set()
        self.remote_calls = 0

    def __call__(self, repo_id, filename, *, cache_dir=None, local_files_only=False, token=None):
        if local_files_only:
            if repo_id in self.local:
                return self.path
            raise LocalEntryNotFoundError("yok")
        self.remote_calls += 1
        if self.remote_error:
            raise self.remote_error
        self.local.add(repo_id)
        return self.path


def make_err(cls):
    return cls.__new__(cls)  # HTTP yanıtı gerektiren kurucuyu atla


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("google/gemma-4-31B-it", "google/gemma-4-31B-it"),
        ("  google/gemma-4-31B-it \n", "google/gemma-4-31B-it"),
        ("https://huggingface.co/google/gemma-4-31B-it", "google/gemma-4-31B-it"),
        ("https://huggingface.co/Qwen/Qwen3-8B/tree/main?x=1", "Qwen/Qwen3-8B"),
        ("hf.co/openai/gpt-oss-20b/", "openai/gpt-oss-20b"),
    ],
)
def test_normalize(raw, expected):
    assert normalize_model_id(raw) == expected


@pytest.mark.parametrize("raw", ["", "gpt2-sadece-ad", "a/b c", "../etc/passwd"])
def test_normalize_rejects(raw):
    with pytest.raises(TokenizerError):
        normalize_model_id(raw)


def test_counts_tokens_and_caches(tmp_path, tokenizer_file):
    hub = FakeHub(tokenizer_file)
    cache = TokenizerCache(tmp_path / "c", downloader=hub)

    r1 = cache.tokenize("acme/model", "merhaba dünya !")
    assert r1.token_count == 3
    assert r1.tokens == ["merhaba", "dünya", "!"]
    assert r1.cached is False

    r2 = cache.tokenize("acme/model", "merhaba")
    assert r2.token_count == 1 and r2.cached is True
    assert hub.remote_calls == 1

    # Yeni süreç: bellek boş, disk dolu -> ağa çıkmamalı
    fresh = TokenizerCache(tmp_path / "c", downloader=hub)
    assert fresh.tokenize("acme/model", "dünya").cached is True
    assert hub.remote_calls == 1


@pytest.mark.parametrize(
    "error_cls, status, fragment",
    [
        (GatedRepoError, 403, "gated"),
        (RepositoryNotFoundError, 404, "not found"),
        (EntryNotFoundError, 404, "no tokenizer.json"),
    ],
)
def test_errors_are_explained(tmp_path, tokenizer_file, error_cls, status, fragment):
    cache = TokenizerCache(tmp_path, downloader=FakeHub(tokenizer_file, make_err(error_cls)))
    with pytest.raises(TokenizerError) as exc:
        cache.tokenize("acme/model", "x")
    assert exc.value.status == status
    assert fragment in exc.value.message


def test_expired_stored_login_falls_back_to_anonymous(tmp_path, tokenizer_file):
    err = make_err(RepositoryNotFoundError)
    err.response = type("R", (), {"status_code": 401})()
    tokens_seen = []

    def hub(repo_id, filename, *, cache_dir=None, local_files_only=False, token=None):
        if local_files_only:
            raise LocalEntryNotFoundError("yok")
        tokens_seen.append(token)
        if token is None:  # kayıtlı (süresi dolmuş) giriş
            raise err
        return tokenizer_file

    cache = TokenizerCache(tmp_path, downloader=hub)
    assert cache.tokenize("Qwen/Qwen3-8B", "merhaba").token_count == 1
    assert tokens_seen == [None, False]


def test_api_roundtrip(tmp_path, tokenizer_file):
    cache = TokenizerCache(tmp_path, downloader=FakeHub(tokenizer_file))
    client = TestClient(create_app(cache))

    r = client.post("/api/tokenize", json={"model": "acme/model", "text": "merhaba dünya"})
    assert r.status_code == 200
    assert r.json()["token_count"] == 2

    assert client.get("/api/cache").json()["models"] == ["acme/model"]
    assert client.delete("/api/cache/acme/model").json()["removed"] is True

    bad = client.post("/api/tokenize", json={"model": "gecersiz", "text": "x"})
    assert bad.status_code == 400 and "error" in bad.json()

    assert client.get("/").status_code == 200
