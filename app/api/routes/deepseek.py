"""DeepSeek agent API routes: REST + SSE streaming (OpenAI-compatible).

Each POST spawns one harness instance for that call only. Pass the harness
as raw ``cordis.patch.yml`` text (``harness`` or ``harness_yml``). Per-call
``system_prompt`` / ``tools`` / ``model`` overrides still apply on top.
Omit all of them for the old bare behavior (user prompt only).
"""

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.harness.dsh import resolve_runtime, to_cordis_patch_yml
from app.harness.importer import coerce_harness
from app.services.deepseek_client import (
    DeepSeekClient,
    DeepSeekEmptyReplyError,
    DeepSeekNotAvailableError,
)

router = APIRouter(prefix="/deepseek", tags=["deepseek"])


def _get_client() -> DeepSeekClient:
    return DeepSeekClient(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url=settings.DEEPSEEK_BASE_URL,
        model=settings.DEEPSEEK_MODEL,
        default_timeout=settings.DEEPSEEK_TIMEOUT_S,
    )


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, description="Prompt to send to DeepSeek")
    timeout: float | None = Field(
        default=None,
        gt=0,
        le=600,
        description="Per-request timeout in seconds (overrides server default)",
    )
    system_prompt: str | None = Field(
        default=None, description="Per-call system prompt (beats harness persona)"
    )
    model: str | None = Field(
        default=None, description="Per-call model id (beats harness default-model)"
    )
    tools: list[dict[str, Any]] | None = Field(
        default=None, description="OpenAI-style tool schemas exposed for this call only"
    )
    harness: str | None = Field(
        default=None,
        description="Raw cordis.patch.yml text. Mutually exclusive with "
        "'harness_yml'.",
    )
    harness_yml: str | None = Field(
        default=None,
        description="Raw cordis.patch.yml text (dsh --profile <name> --dump-config "
        "output or a patch document). Validated server-side. "
        "Mutually exclusive with 'harness'.",
    )
    harness_profile: str | None = Field(
        default=None,
        description="Profile override for 'harness_yml' (else read from the "
        "document, else headless)",
    )


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[dict[str, Any]] = Field(
        default_factory=list, description="Tool calls the model made (not executed server-side)"
    )
    model: str | None = None
    applied_plugins: list[str] = Field(default_factory=list)
    ignored_plugins: list[str] = Field(default_factory=list)
    policy_notes: list[str] = Field(default_factory=list)
    harness: str | None = Field(
        default=None, description="Raw harness text actually used for this call"
    )
    patch_yml: str | None = Field(
        default=None, description="cordis.patch.yml rendering of the used harness"
    )
    harness_source: str = Field(
        default="none", description="Where the harness came from: none | json | yml"
    )
    warnings: list[str] = Field(default_factory=list)
    dropped: list[dict[str, str]] = Field(default_factory=list)


def _resolve(req: ChatRequest) -> dict[str, Any]:
    try:
        harness, meta = coerce_harness(req.harness, req.harness_yml, profile=req.harness_profile)
        rt = resolve_runtime(harness, system_prompt=req.system_prompt, model=req.model)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    patch_yml: str | None = None
    if harness is not None:
        try:
            patch_yml = to_cordis_patch_yml(harness)
        except ValueError as e:  # pragma: no cover - coerce already validated
            raise HTTPException(status_code=422, detail=str(e)) from e
    return {**rt, "harness": harness, "patch_yml": patch_yml, **meta}


@router.get("/health")
def deepseek_health() -> dict[str, str | bool]:
    """Report whether DeepSeek is configured (no API call)."""
    configured = bool((settings.DEEPSEEK_API_KEY or "").strip())
    return {
        "available": configured,
        "model": settings.DEEPSEEK_MODEL,
        "base_url": settings.DEEPSEEK_BASE_URL,
    }


@router.post("/chat", response_model=ChatResponse)
async def chat_with_deepseek(req: ChatRequest) -> ChatResponse:
    """Send a prompt to DeepSeek and return the complete reply."""
    rt = _resolve(req)
    try:
        # Per-request timeout override: build a scoped client.
        client = _get_client()
        if req.timeout is not None:
            client.default_timeout = req.timeout
        result = await client.run_prompt_single(
            req.prompt,
            timeout=req.timeout,
            system_text=rt["system_text"],
            model=rt["model"],
            tools=req.tools,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except DeepSeekNotAvailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except DeepSeekEmptyReplyError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 - surface SDK failures as 500
        raise HTTPException(status_code=500, detail=str(e)) from e
    return ChatResponse(
        reply=result["reply"],
        tool_calls=result["tool_calls"],
        model=rt["model"] or settings.DEEPSEEK_MODEL,
        applied_plugins=rt["applied_plugins"],
        ignored_plugins=rt["ignored_plugins"],
        policy_notes=rt["policy_notes"],
        harness=rt["patch_yml"],
        patch_yml=rt["patch_yml"],
        harness_source=rt.get("source", "none"),
        warnings=rt.get("warnings", []),
        dropped=rt.get("dropped", []),
    )


@router.post("/stream")
async def stream_with_deepseek(req: ChatRequest) -> StreamingResponse:
    """Stream DeepSeek token deltas as Server-Sent Events.

    First event is always ``{"harness": "..."}`` containing the per-call
    harness text and metadata, then ``{"delta"}``
    chunks, an optional ``{"tool_calls": [...]}`` event, then
    ``{"status": "done"}`` or ``{"error"}``.
    """
    import json

    if not req.prompt.strip():
        raise HTTPException(status_code=422, detail="prompt must be a non-empty string")
    rt = _resolve(req)
    try:
        _get_client().check_configured()  # fail fast with 503 before streaming
    except DeepSeekNotAvailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async def _gen():
        metadata = {
            key: rt[key]
            for key in (
                "model",
                "applied_plugins",
                "ignored_plugins",
                "policy_notes",
                "warnings",
                "dropped",
            )
        }
        yield f"data: {json.dumps({'harness': rt['patch_yml'], **metadata})}\n\n"
        async for line in _get_client().stream_prompt(
            req.prompt,
            system_text=rt["system_text"],
            model=rt["model"],
            tools=req.tools,
        ):
            yield line

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
