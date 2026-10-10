"""Pi agent API routes: REST + SSE streaming over ``pi --mode rpc``."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.pi_rpc import PiNotAvailableError, PiRpcWrapper

router = APIRouter(prefix="/pi", tags=["pi"])


def _get_client() -> PiRpcWrapper:
    return PiRpcWrapper(
        pi_binary=settings.PI_BINARY,
        model=settings.PI_MODEL,
        default_timeout=settings.PI_TIMEOUT_S,
    )


class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, description="Prompt to send to the Pi agent")
    timeout: float | None = Field(
        default=None,
        gt=0,
        le=600,
        description="Per-request timeout in seconds (overrides server default)",
    )


class ChatResponse(BaseModel):
    reply: str


@router.get("/health")
def pi_health() -> dict[str, str | bool]:
    """Report whether the Pi binary is reachable (no agent run)."""
    import shutil

    available = shutil.which(settings.PI_BINARY) is not None
    return {
        "available": available,
        "binary": settings.PI_BINARY,
        "model": settings.PI_MODEL or "default",
    }


@router.post("/chat", response_model=ChatResponse)
async def chat_with_pi(req: ChatRequest) -> ChatResponse:
    """Send a prompt to Pi headless RPC and return the complete reply."""
    try:
        reply = await _get_client().run_prompt_single(req.prompt, timeout=req.timeout)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except PiNotAvailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001 - surface subprocess failures as 500
        raise HTTPException(status_code=500, detail=str(e)) from e
    return ChatResponse(reply=reply)


@router.post("/stream")
async def stream_with_pi(req: ChatRequest) -> StreamingResponse:
    """Stream Pi token deltas as Server-Sent Events."""
    if not req.prompt.strip():
        raise HTTPException(status_code=422, detail="prompt must be a non-empty string")
    try:
        _get_client().check_binary()  # fail fast with 503 before streaming
    except PiNotAvailableError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return StreamingResponse(
        _get_client().stream_prompt(req.prompt),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
