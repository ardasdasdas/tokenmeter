"""Hugging Face tokenizer.json dosyalarını indirip disk + bellekte önbelleğe alır."""

from __future__ import annotations

import os
import re
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from huggingface_hub import hf_hub_download
from huggingface_hub.errors import (
    EntryNotFoundError,
    GatedRepoError,
    HFValidationError,
    LocalEntryNotFoundError,
    RepositoryNotFoundError,
)
from tokenizers import Tokenizer

TOKENIZER_FILE = "tokenizer.json"
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.\-]*/[\w.\-]+$")


class TokenizerError(Exception):
    """Kullanıcıya gösterilebilir hata; `status` HTTP durum kodudur."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def normalize_model_id(raw: str) -> str:
    """'owner/name', HF URL'si veya kenarında boşluk olan girdiyi 'owner/name'e çevirir."""
    value = (raw or "").strip()
    value = re.sub(r"^(https?://)?(www\.)?(huggingface\.co|hf\.co)/", "", value)
    value = value.split("?")[0].split("#")[0].strip("/")
    parts = value.split("/")
    if len(parts) >= 2:
        value = "/".join(parts[:2])  # .../tree/main gibi ekleri at
    if not _REPO_RE.match(value):
        raise TokenizerError(
            "Invalid model name. Use the 'owner/model' format, e.g. google/gemma-4-31B-it."
        )
    return value


@dataclass
class TokenizeResult:
    model: str
    token_count: int
    char_count: int
    tokens: list[str]
    ids: list[int]
    cached: bool


Downloader = Callable[..., str]


def _http_status(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


class TokenizerCache:
    def __init__(
        self,
        cache_dir: str | Path,
        hf_token: str | None = None,
        downloader: Downloader = hf_hub_download,
    ):
        self.cache_dir = Path(cache_dir)
        self.hf_token = hf_token or None
        self._download = downloader
        self._memory: dict[str, Tokenizer] = {}
        self._lock = threading.Lock()

    # --- indirme / yükleme -------------------------------------------------
    def _fetch_file(self, model_id: str) -> tuple[str, bool]:
        """tokenizer.json yolunu döndürür; ikinci değer diskte zaten var mıydı."""
        try:
            path = self._download(
                model_id, TOKENIZER_FILE, cache_dir=self.cache_dir, local_files_only=True
            )
            return path, True
        except (LocalEntryNotFoundError, FileNotFoundError, EntryNotFoundError):
            pass

        try:
            try:
                path = self._download(
                    model_id, TOKENIZER_FILE, cache_dir=self.cache_dir, token=self.hf_token
                )
            except RepositoryNotFoundError as exc:
                # HF_TOKEN yoksa kütüphane makinedeki kayıtlı girişi (hf auth login) kullanır.
                # O anahtarın süresi dolmuşsa açık modeller bile 401 döner: anonim tekrar dene.
                if self.hf_token or _http_status(exc) != 401:
                    raise
                path = self._download(
                    model_id, TOKENIZER_FILE, cache_dir=self.cache_dir, token=False
                )
            return path, False
        except GatedRepoError as exc:  # RepositoryNotFoundError'ın alt sınıfı, önce yakala
            hint = (
                "Check that HF_TOKEN is valid and that you accepted the license on the model page."
                if self.hf_token
                else "Add HF_TOKEN to your .env file and accept the license on the model page."
            )
            raise TokenizerError(f"'{model_id}' is a gated model. {hint}", 403) from exc
        except RepositoryNotFoundError as exc:
            if self.hf_token and "expired" in str(exc).lower():
                raise TokenizerError("HF_TOKEN has expired; create a new token.", 401) from exc
            raise TokenizerError(
                f"'{model_id}' was not found. Check the name; private repos need HF_TOKEN.",
                404,
            ) from exc
        except EntryNotFoundError as exc:
            raise TokenizerError(
                f"'{model_id}' has no tokenizer.json (this model is not supported).", 404
            ) from exc
        except HFValidationError as exc:
            raise TokenizerError(f"Invalid model name: {model_id}") from exc
        except OSError as exc:
            raise TokenizerError(f"Could not reach Hugging Face: {exc}", 502) from exc

    def get(self, model_id: str) -> tuple[Tokenizer, bool]:
        """Tokenizer'ı döndürür; ikinci değer önbellekten (bellek/disk) gelip gelmediği."""
        with self._lock:
            if model_id in self._memory:
                return self._memory[model_id], True
        path, from_disk = self._fetch_file(model_id)
        try:
            tok = Tokenizer.from_file(path)
        except Exception as exc:
            raise TokenizerError(f"Could not read tokenizer.json: {exc}", 500) from exc
        with self._lock:
            self._memory[model_id] = tok
        return tok, from_disk

    # --- sayım ---------------------------------------------------------------
    def tokenize(self, raw_model: str, text: str, add_special_tokens: bool = False) -> TokenizeResult:
        model_id = normalize_model_id(raw_model)
        tok, cached = self.get(model_id)
        enc = tok.encode(text, add_special_tokens=add_special_tokens)
        return TokenizeResult(
            model=model_id,
            token_count=len(enc.ids),
            char_count=len(text),
            tokens=self._token_pieces(text, enc),
            ids=list(enc.ids),
            cached=cached,
        )

    @staticmethod
    def _token_pieces(text: str, enc) -> list[str]:
        """Her token için kaynak metindeki parçayı döndürür (görselleştirme için)."""
        pieces = []
        for token, (start, end) in zip(enc.tokens, enc.offsets):
            pieces.append(text[start:end] if end > start else token)
        return pieces

    # --- önbellek yönetimi ---------------------------------------------------
    def list_cached(self) -> list[str]:
        models = set(self._memory)
        if self.cache_dir.exists():
            for d in self.cache_dir.glob("models--*"):
                if any(d.glob(f"snapshots/*/{TOKENIZER_FILE}")):
                    models.add(d.name[len("models--"):].replace("--", "/", 1))
        return sorted(models, key=str.lower)

    def evict(self, raw_model: str) -> bool:
        model_id = normalize_model_id(raw_model)
        with self._lock:
            removed = self._memory.pop(model_id, None) is not None
        folder = self.cache_dir / ("models--" + model_id.replace("/", "--"))
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
            removed = True
        return removed


def from_env() -> TokenizerCache:
    cache_dir = os.getenv("TOKENIZER_CACHE_DIR") or Path(__file__).resolve().parent.parent / ".cache"
    return TokenizerCache(cache_dir, hf_token=os.getenv("HF_TOKEN"))
