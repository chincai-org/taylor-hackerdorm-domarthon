"""DeepSeek chat client (OpenAI-compatible).

Uses the ``openai`` SDK against ``https://api.deepseek.com/v1`` by default.
API key comes from ``DEEPSEEK_API_KEY`` (see ``app/core/config.py``).

Each call spawns one "harness instance": the caller may pass per-request
plugins via ``harness`` (validated dsh patch-layer text, see
``app/harness/dsh.py``) plus ``system_prompt`` / ``tools`` / ``model``
overrides. Raw ``cordis.patch.yml`` text is accepted at the route layer
(``POST /deepseek/chat`` and ``POST /deepseek/stream`` via ``harness_yml``,
or ``app/harness/importer.coerce_harness``) and converted to the same internal
before reaching this client. Bare calls (all omitted) keep the old behavior:
just the user prompt, no system text, no tools.

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

    @staticmethod
    def _parse_tool_calls(message: Any) -> list[dict[str, Any]]:
        """Extract OpenAI-style tool calls from a chat message (lenient)."""
        import json

        calls: list[dict[str, Any]] = []
        for tc in getattr(message, "tool_calls", None) or []:
            fn = getattr(tc, "function", None)
            raw_args = getattr(fn, "arguments", "") or ""
            try:
                args = json.loads(raw_args) if raw_args else {}
            except (json.JSONDecodeError, ValueError):
                args = {"_raw": raw_args}
            calls.append(
                {
                    "id": getattr(tc, "id", ""),
                    "name": getattr(fn, "name", ""),
                    "arguments": args,
                }
            )
        return calls

    async def run_prompt_single(
        self,
        prompt: str,
        timeout: float | None = None,
        *,
        system_text: str | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Send one prompt, return ``{"reply": str, "tool_calls": [...]}``.

        ``reply`` is ``""`` when the model only made tool calls (no assistant
        text yet) — that is a working tool call, not an error. Raises only
        when there is neither text nor any tool call.
        """
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
        message = resp.choices[0].message if resp.choices else None
        text = (message.content or "").strip() if message and message.content else ""
        tool_calls = self._parse_tool_calls(message) if message is not None else []
        if text or tool_calls:
            return {"reply": text, "tool_calls": tool_calls}
        raise DeepSeekEmptyReplyError(
            f"DeepSeek model '{self.model}' returned no text or tool call."
        )

    async def run_prompt_agent(
        self,
        prompt: str,
        timeout: float | None = None,
        *,
        system_text: str | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_steps: int = 5,
    ) -> dict[str, Any]:
        """Run an autonomous tool loop: model -> execute -> feed back, up to max_steps.

        Each iteration that returns ``tool_calls`` executes them locally via
        ``app.services.tool_runtime`` (sandboxed, never raises) and appends
        ``{"role": "tool", ...}`` results before calling the model again.
        Returns ``{"reply", "tool_calls" (all), "steps": [...]}`` where each
        step is ``{"tool_calls": [...], "tool_results": [...]}``.
        ``max_steps=1`` behaves like :meth:`run_prompt_single`.
        """
        import json as _json

        from app.services.tool_runtime import execute as _execute

        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        max_steps = max(1, min(int(max_steps or 1), 10))
        messages: list[dict[str, Any]] = []
        if system_text and system_text.strip():
            messages.append({"role": "system", "content": system_text.strip()})
        messages.append({"role": "user", "content": prompt})
        create_kwargs_base: dict[str, Any] = {"model": model or self.model}
        if tools:
            create_kwargs_base["tools"] = tools
            create_kwargs_base["tool_choice"] = "auto"
        client = self._client(timeout)
        all_calls: list[dict[str, Any]] = []
        steps: list[dict[str, Any]] = []
        try:
            for _ in range(max_steps):
                resp = await client.chat.completions.create(messages=messages, **create_kwargs_base)
                message = resp.choices[0].message if resp.choices else None
                text = (message.content or "").strip() if message and message.content else ""
                tool_calls = self._parse_tool_calls(message) if message is not None else []
                if not tool_calls:
                    if text or all_calls:
                        return {"reply": text, "tool_calls": all_calls, "steps": steps}
                    raise DeepSeekEmptyReplyError(
                        f"DeepSeek model '{self.model}' returned no text or tool call."
                    )
                all_calls.extend(tool_calls)
                results: list[dict[str, Any]] = []
                for tc in tool_calls:
                    out = _execute(tc.get("name", ""), tc.get("arguments", {}))
                    results.append(
                        {
                            "tool_call_id": tc.get("id", ""),
                            "name": tc.get("name", ""),
                            "result": out,
                        }
                    )
                steps.append({"tool_calls": tool_calls, "tool_results": results})
                messages.append(
                    {
                        "role": "assistant",
                        "content": text or None,
                        "tool_calls": [
                            {
                                "id": tc.get("id", ""),
                                "type": "function",
                                "function": {
                                    "name": tc.get("name", ""),
                                    "arguments": _json.dumps(tc.get("arguments", {})),
                                },
                            }
                            for tc in tool_calls
                        ],
                    }
                )
                for tc, res in zip(tool_calls, results):
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.get("id", ""),
                            "content": _json.dumps(res["result"]),
                        }
                    )
            # Out of steps: ask once more for a final text-only summary.
            resp = await client.chat.completions.create(
                model=create_kwargs_base["model"], messages=messages
            )
            message = resp.choices[0].message if resp.choices else None
            text = (message.content or "").strip() if message and message.content else ""
            return {"reply": text, "tool_calls": all_calls, "steps": steps}
        finally:
            await client.close()

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
        ``{"delta": ...}`` chunks, optional ``{"tool_calls": [...]}`` event
        when the model invoked tools, then ``{"status": "done"}`` or ``{"error": ...}``.
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
            tool_accum: dict[int, dict[str, str]] = {}
            try:
                async for chunk in stream:
                    for choice in chunk.choices or []:
                        delta = getattr(choice.delta, "content", None)
                        if delta:
                            got_text = True
                            yield f"data: {json.dumps({'delta': delta})}\n\n"
                        for tc in getattr(choice.delta, "tool_calls", None) or []:
                            slot = tool_accum.setdefault(
                                getattr(tc, "index", 0),
                                {"id": "", "name": "", "arguments": ""},
                            )
                            if getattr(tc, "id", None):
                                slot["id"] += tc.id
                            fn = getattr(tc, "function", None)
                            if fn is not None:
                                if getattr(fn, "name", None):
                                    slot["name"] += fn.name
                                if getattr(fn, "arguments", None):
                                    slot["arguments"] += fn.arguments
            finally:
                await stream.close()
            tool_calls: list[dict[str, Any]] = []
            for slot in tool_accum.values():
                try:
                    args = json.loads(slot["arguments"]) if slot["arguments"] else {}
                except ValueError:
                    args = {"_raw": slot["arguments"]}
                tool_calls.append({"id": slot["id"], "name": slot["name"], "arguments": args})
            if tool_calls:
                yield f"data: {json.dumps({'tool_calls': tool_calls})}\n\n"
            if not got_text and not tool_calls:
                yield f"data: {json.dumps({'error': 'DeepSeek returned no text'})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'done'})}\n\n"
        except Exception as e:  # noqa: BLE001 - streamed to client as SSE error
            logger.exception("DeepSeek stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            await client.close()

    async def stream_prompt_agent(
        self,
        prompt: str,
        *,
        system_text: str | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        max_steps: int = 5,
    ) -> AsyncGenerator[str, None]:
        """Stream an autonomous tool loop as SSE.

        Reuses :meth:`run_prompt_agent` (non-streaming per step for
        reliability) but yields incremental events so the existing stream
        contract keeps working: ``{"step"}`` / ``{"tool_calls"}`` /
        ``{"tool_result"}`` per iteration, then ``{"delta"}`` for the final
        reply and ``{"status": "done"}``.
        """
        import json

        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        try:
            self.check_configured()
        except DeepSeekNotAvailableError as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return
        try:
            result = await self.run_prompt_agent(
                prompt,
                system_text=system_text,
                model=model,
                tools=tools,
                max_steps=max_steps,
            )
        except Exception as e:  # noqa: BLE001 - streamed to client as SSE error
            logger.exception("DeepSeek agent loop failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            return
        for i, step in enumerate(result.get("steps", []), start=1):
            yield f"data: {json.dumps({'step': i, 'tool_calls': step['tool_calls']})}\n\n"
            for tr in step.get("tool_results", []):
                yield f"data: {json.dumps({'tool_result': tr})}\n\n"
        if result.get("tool_calls"):
            yield f"data: {json.dumps({'tool_calls': result['tool_calls']})}\n\n"
        reply = result.get("reply", "")
        if reply:
            yield f"data: {json.dumps({'delta': reply})}\n\n"
        if not reply and not result.get("tool_calls"):
            yield f"data: {json.dumps({'error': 'DeepSeek returned no text'})}\n\n"
        else:
            yield f"data: {json.dumps({'status': 'done'})}\n\n"
