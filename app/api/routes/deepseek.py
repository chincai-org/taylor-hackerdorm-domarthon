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

from app.core.config import llm_base_url, llm_model, llm_provider
from app.harness.dsh import resolve_runtime, to_cordis_patch_yml
from app.harness.importer import coerce_harness
from app.services.deepseek_client import (
    DeepSeekClient,
    DeepSeekEmptyReplyError,
    DeepSeekNotAvailableError,
    build_llm_client,
)

router = APIRouter(prefix="/deepseek", tags=["deepseek"])


def _get_client() -> DeepSeekClient:
    return build_llm_client()


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
        description="Raw cordis.patch.yml text. Mutually exclusive with 'harness_yml'.",
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
    max_steps: int = Field(
        default=5,
        ge=1,
        le=10,
        description="Agent loop cap (model -> execute -> feed back). 1 = single-shot.",
    )
    auto_tools: bool = Field(
        default=True,
        description="Derive executable tools from harness rows (fs/web).",
    )


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Tool calls made (executed server-side when steps present)",
    )
    steps: list[dict[str, Any]] = Field(
        default_factory=list, description="Agent loop trace: [{tool_calls, tool_results}] per step"
    )
    executed_tools: list[str] = Field(
        default_factory=list, description="Tool families executed from harness (e.g. ['fs', 'web'])"
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
    # Merge harness-derived executable tools (fs/web families) under explicit tools.
    from app.services.tool_runtime import tools_for_harness

    auto_tools_list, families = tools_for_harness(harness) if req.auto_tools else ([], [])
    seen = {t.get("function", {}).get("name") for t in (req.tools or [])}
    merged = list(req.tools or []) + [
        t for t in auto_tools_list if t.get("function", {}).get("name") not in seen
    ]
    # A harness row that now executes is no longer "ignored" — surface it.
    applied = list(rt.get("applied_plugins", []))
    ignored = [
        p
        for p in rt.get("ignored_plugins", [])
        if p not in ("dsh-plugin-fs", "dsh-plugin-web-search")
    ]
    for fam in families:
        applied.append(f"auto-tools:{fam}")
    policy = list(rt.get("policy_notes", []))
    if families:
        policy.append(f"auto-tools={','.join(families)} max_steps={req.max_steps}")
    resolved = {**rt, "harness": harness, "patch_yml": patch_yml, **meta}
    resolved.update(
        {
            "applied_plugins": applied,
            "ignored_plugins": ignored,
            "policy_notes": policy,
            "effective_tools": merged or None,
            "executed_tools": families,
        }
    )
    return resolved


@router.get("/health")
def deepseek_health() -> dict[str, str | bool]:
    """Report whether a model API is configured (no API call)."""
    provider = llm_provider()
    return {
        "available": provider is not None,
        "provider": provider or "none",
        "model": llm_model(),
        "base_url": llm_base_url(),
    }


@router.post("/chat", response_model=ChatResponse)
async def chat_with_deepseek(req: ChatRequest) -> ChatResponse:
    """Send a prompt to DeepSeek; autonomous tool loop up to max_steps."""
    rt = _resolve(req)
    try:
        # Per-request timeout override: build a scoped client.
        client = _get_client()
        if req.timeout is not None:
            client.default_timeout = req.timeout
        result = await client.run_prompt_agent(
            req.prompt,
            timeout=req.timeout,
            system_text=rt["system_text"],
            model=rt["model"],
            tools=rt.get("effective_tools"),
            max_steps=req.max_steps,
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
        steps=result.get("steps", []),
        executed_tools=rt.get("executed_tools", []),
        model=rt["model"] or llm_model(),
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
    """Stream an autonomous agent loop as Server-Sent Events.

    First event is always ``{"harness": "..."}`` containing the per-call
    harness text and metadata, then per-step ``{"step"}`` / ``{"tool_calls"}``
    / ``{"tool_result"}`` events, ``{"delta"}`` for the final reply, then
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
        async for line in _get_client().stream_prompt_agent(
            req.prompt,
            system_text=rt["system_text"],
            model=rt["model"],
            tools=rt.get("effective_tools"),
            max_steps=req.max_steps,
        ):
            yield line

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
