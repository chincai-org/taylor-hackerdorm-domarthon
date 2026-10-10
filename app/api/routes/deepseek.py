"""DeepSeek agent API routes: REST + SSE streaming (OpenAI-compatible)."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
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


class ChatResponse(BaseModel):
    reply: str


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
    try:
        # Per-request timeout override: build a scoped client.
        client = _get_client()
        if req.timeout is not None:
            client.default_timeout = req.timeout
        reply = await client.run_prompt_single(req.prompt, timeout=req.timeout)
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
    return ChatResponse(reply=reply)


@router.post("/stream")
async def stream_with_deepseek(req: ChatRequest) -> StreamingResponse:
    """Stream DeepSeek token deltas as Server-Sent Events."""
    if not req.prompt.strip():
        raise HTTPException(status_code=422, detail="prompt must be a non-empty string")
    try:
        _get_client().check_configured()  # fail fast with 503 before streaming
    except DeepSeekNotAvailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return StreamingResponse(
        _get_client().stream_prompt(req.prompt),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
