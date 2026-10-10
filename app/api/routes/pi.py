"""Backwards-compat alias: ``/pi/*`` now runs on DeepSeek.

The Pi binary (``pi --mode rpc``) has been removed. These routes keep the
old paths working by delegating to the DeepSeek client. Prefer ``/deepseek/*``.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.api.routes.deepseek import (
    ChatRequest,
    ChatResponse,
    chat_with_deepseek,
    stream_with_deepseek,
)

router = APIRouter(prefix="/pi", tags=["pi"])


@router.get("/health")
def pi_health() -> dict[str, str | bool]:
    """Legacy health shape + DeepSeek fields. No agent run."""
    from app.core.config import settings

    configured = bool((settings.DEEPSEEK_API_KEY or "").strip())
    return {
        "available": configured,
        "binary": "deepseek (pi removed)",
        "model": settings.DEEPSEEK_MODEL or "default",
    }


@router.post("/chat", response_model=ChatResponse)
async def chat_with_pi(req: ChatRequest) -> ChatResponse:
    """Legacy path; forwards to DeepSeek."""
    try:
        return await chat_with_deepseek(req)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/stream")
async def stream_with_pi(req: ChatRequest) -> StreamingResponse:
    """Legacy path; forwards to DeepSeek SSE."""
    return await stream_with_deepseek(req)
