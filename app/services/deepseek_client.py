"""DeepSeek chat client (OpenAI-compatible).

Uses the ``openai`` SDK against ``https://api.deepseek.com/v1`` by default.
API key comes from ``DEEPSEEK_API_KEY`` (see ``app/core/config.py``).

Each call spawns one "harness instance": the caller may pass per-request
plugins via ``harness`` (validated dsh patch-layer JSON, see
``app/harness/dsh.py``) plus ``system_prompt`` / ``tools`` / ``model``
overrides. Bare calls (all omitted) keep the old behavior: just the user
prompt, no system text, no tools.

Interface:
- ``run_prompt_single(prompt, ...)`` -> complete reply text
- ``stream_prompt(prompt, ...)`` -> SSE ``data:`` lines with ``{"delta": ...}``
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-chat"


class DeepSeekNotAvailableError(RuntimeError):
    """Raised when no DeepSeek API key is configured."""


class DeepSeekEmptyReplyError(RuntimeError):
    """Raised when DeepSeek returns no assistant text."""


class DeepSeekClient:
    """Thin async wrapper around DeepSeek chat completions."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        default_timeout: float = 120.0,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.default_timeout = default_timeout

    def check_configured(self) -> None:
        if not self.api_key:
            raise DeepSeekNotAvailableError(
                "DEEPSEEK_API_KEY is not set. Export it locally or set it on Railway/Vercel."
            )

    def _client(self, timeout: float | None):
        from openai import AsyncOpenAI

        self.check_configured()
        return AsyncOpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=timeout or self.default_timeout,
        )

    @staticmethod
    def _messages(prompt: str, system_text: str | None) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if system_text and system_text.strip():
            messages.append({"role": "system", "content": system_text.strip()})
        messages.append({"role": "user", "content": prompt})
        return messages

    async def run_prompt_single(
        self,
        prompt: str,
        timeout: float | None = None,
        *,
        system_text: str | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> str:
        """Send one prompt, return the complete assistant reply."""
        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        messages = self._messages(prompt, system_text)
        create_kwargs: dict[str, Any] = {"model": model or self.model, "messages": messages}
        if tools:
            create_kwargs["tools"] = tools
        client = self._client(timeout)
        try:
            resp = await client.chat.completions.create(stream=False, **create_kwargs)
        finally:
            await client.close()
        text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
        if text:
            return text
        raise DeepSeekEmptyReplyError(f"DeepSeek model '{self.model}' returned no assistant text.")

    async def stream_prompt(
        self,
        prompt: str,
        *,
        system_text: str | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncGenerator[str, None]:
        """Yield SSE lines streaming DeepSeek token deltas.

        Event shape:
        ``{"delta": ...}`` chunks, then ``{"status": "done"}`` or ``{"error": ...}``.
        """
        import json

        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        try:
            client = self._client(None)
        except DeepSeekNotAvailableError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return
        try:
            create_kwargs: dict[str, Any] = {
                "model": model or self.model,
                "messages": self._messages(prompt, system_text),
                "stream": True,
            }
            if tools:
                create_kwargs["tools"] = tools
            stream = await client.chat.completions.create(**create_kwargs)
            got_text = False
            try:
                async for chunk in stream:
                    for choice in chunk.choices or []:
                        delta = getattr(choice.delta, "content", None)
                        if delta:
                            got_text = True
                            yield f"data: {json.dumps({'delta': delta})}\n\n"
            finally:
                await stream.close()
            if not got_text:
                yield f"data: {json.dumps({'error': 'DeepSeek returned no text'})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'done'})}\n\n"
        except Exception as e:  # noqa: BLE001 - streamed to client as SSE error
            logger.exception("DeepSeek stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            await client.close()
