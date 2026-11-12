from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .tokenizer_cache import TokenizerCache, TokenizerError, from_env

load_dotenv()

STATIC_DIR = Path(__file__).resolve().parent / "static"
MAX_TEXT_CHARS = 2_000_000


class TokenizeRequest(BaseModel):
    model: str = Field(..., max_length=300)
    text: str = Field("", max_length=MAX_TEXT_CHARS)
    add_special_tokens: bool = False


def create_app(cache: TokenizerCache | None = None) -> FastAPI:
    app = FastAPI(title="Tokenmeter")
    app.state.cache = cache or from_env()

    @app.exception_handler(TokenizerError)
    async def _tok_error(_: Request, exc: TokenizerError):
        return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.post("/api/tokenize")
    def tokenize(req: TokenizeRequest):
        result = app.state.cache.tokenize(req.model, req.text, req.add_special_tokens)
        return asdict(result)

    @app.get("/api/cache")
    def list_cache():
        return {"models": app.state.cache.list_cached()}

    @app.delete("/api/cache/{model_id:path}")
    def evict(model_id: str):
        return {"removed": app.state.cache.evict(model_id)}

    # The static site is served from the root so the same files work on GitHub Pages.
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="site")
    return app


app = create_app()
