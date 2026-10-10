"""Headless RPC client for the Pi agent binary.

Wraps ``pi --mode rpc`` (stdin/stdout JSON Lines) so the FastAPI app and
other services can call Pi programmatically.

Protocol (per Pi docs):
    stdin  <- {"id": "<req-id>", "type": "prompt", "message": "<prompt>"}
    stdout -> JSONL event records, e.g.::
        {"id": "<req-id>", "type": "response", "command": "prompt",
         "success": true, "data": {"disposition": "started"}}
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", ...}}
        {"type": "message_end", "message": {"role": "assistant", "content": [...]}}
        {"type": "agent_settled"}

Text arrives incrementally as ``text_delta`` events, but the authoritative
content is ``text_end.content`` / ``message_end.message`` — short replies may
arrive with few or no deltas. Always treat ``message_end`` as authoritative.

Run ``pi --mode rpc --no-session`` for a one-off headless call, optionally
with ``--model <model>``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


class PiNotAvailableError(RuntimeError):
    """Raised when the `pi` binary cannot be found or started."""


class PiEmptyReplyError(RuntimeError):
    """Raised when Pi settles without producing any assistant text."""


@dataclass
class _RunState:
    """Incremental text assembly for one RPC prompt."""

    request_id: str
    # Per-content-block buffers keyed by contentIndex. text_delta appends;
    # text_end replaces (authoritative). Joined in index order at the end.
    blocks: dict[int, str] = field(default_factory=dict)
    # Authoritative fallback from the final assistant message_end.
    final_text: str = ""
    final_stop: str | None = None
    final_error: str | None = None
    # Last assistantMessageEvent of type "error" (provider failure).
    stream_error: str | None = None
    # Disposition from the prompt `response` record ("started"/"queued"/"handled").
    disposition: str | None = None

    def apply_update(self, record: dict) -> str | None:
        """Fold a message_update record; return newly arrived text, if any."""
        event = record.get("assistantMessageEvent")
        if not isinstance(event, dict):
            return None
        etype = event.get("type")
        idx = event.get("contentIndex", 0)
        if not isinstance(idx, int):
            idx = 0
        if etype == "text_delta":
            delta = event.get("delta")
            if isinstance(delta, str) and delta:
                self.blocks[idx] = self.blocks.get(idx, "") + delta
                return delta
        elif etype == "text_end":
            # Authoritative block content: replaces whatever deltas arrived.
            content = event.get("content")
            if isinstance(content, str):
                old = self.blocks.get(idx, "")
                self.blocks[idx] = content
                return content[len(old) :] if content.startswith(old) else content
        elif etype == "error":
            err = event.get("error") or event.get("reason")
            if err is not None:
                self.stream_error = str(err)
        return None

    def apply_message_end(self, record: dict) -> None:
        """Capture the authoritative assistant message, if this is one."""
        message = record.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            return
        self.final_stop = message.get("stopReason")
        if message.get("errorMessage"):
            self.final_error = str(message["errorMessage"])
        texts: list[str] = []
        for block in message.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    texts.append(text)
        if texts:
            self.final_text = "".join(texts)

    def combined_text(self) -> str:
        streamed = "".join(self.blocks[i] for i in sorted(self.blocks) if self.blocks[i])
        # message_end is authoritative: prefer it when streaming is empty,
        # otherwise keep the streamed reconstruction (identical in practice).
        return streamed or self.final_text


class PiRpcWrapper:
    """Manage short-lived ``pi --mode rpc`` subprocess calls."""

    def __init__(
        self,
        pi_binary: str = "pi",
        model: str | None = None,
        default_timeout: float = 120.0,
    ) -> None:
        self.pi_binary = pi_binary
        self.model = model
        self.default_timeout = default_timeout

    def _base_cmd(self) -> list[str]:
        cmd = [self.pi_binary, "--mode", "rpc", "--no-session"]
        if self.model:
            cmd.extend(["--model", self.model])
        return cmd

    def check_binary(self) -> None:
        if shutil.which(self.pi_binary) is None:
            raise PiNotAvailableError(
                f"Pi binary '{self.pi_binary}' not found on PATH. "
                "Install Pi (https://github.com/badlogic/pi-mono) or set PI_BINARY."
            )

    async def _spawn(self) -> asyncio.subprocess.Process:
        self.check_binary()
        logger.info("spawning Pi RPC: %s", " ".join(self._base_cmd()))
        try:
            return await asyncio.create_subprocess_exec(
                *self._base_cmd(),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            raise PiNotAvailableError(f"Could not start '{self.pi_binary}': {e}") from e

    @staticmethod
    def _parse_line(line: bytes) -> dict | None:
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return None
        try:
            record = json.loads(text)
        except json.JSONDecodeError:
            logger.warning("ignoring non-JSON Pi stdout line: %.120r", text)
            return None
        return record if isinstance(record, dict) else None

    @staticmethod
    def _is_settled(record: dict) -> bool:
        return record.get("type") in ("agent_settled", "agent_error", "error")

    def _check_response(self, record: dict, state: _RunState) -> None:
        """Raise on prompt rejection; record disposition for handled prompts."""
        if record.get("type") != "response" or record.get("id") != state.request_id:
            return
        if not record.get("success", False):
            raise RuntimeError(f"Pi rejected prompt: {record}")
        data = record.get("data")
        if isinstance(data, dict) and data.get("disposition"):
            state.disposition = str(data["disposition"])
            logger.info("Pi prompt disposition: %s", state.disposition)

    @staticmethod
    async def _close_quietly(proc: asyncio.subprocess.Process) -> bytes:
        """Close stdin, wait for exit, and return captured stderr."""
        stderr_bytes = b""
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except (BrokenPipeError, AttributeError):
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except TimeoutError:
            proc.kill()
            await proc.wait()
        try:
            if proc.stderr is not None:
                stderr_bytes = await asyncio.wait_for(proc.stderr.read(), timeout=5)
        except TimeoutError:
            pass
        return stderr_bytes

    def _empty_reply_error(self, state: _RunState, stderr_tail: str) -> PiEmptyReplyError:
        detail = (
            f"Pi settled with no assistant text "
            f"(disposition={state.disposition} stop={state.final_stop} "
            f"stream_error={state.stream_error} message_error={state.final_error}). "
            "Likely causes: no usable model in ~/.pi/agent/models.json "
            "(provider needs a 'models' list + valid apiKey), or wrong --model. "
            f"Pi stderr: {stderr_tail or '<empty>'}"
        )
        return PiEmptyReplyError(detail)

    async def run_prompt_single(
        self,
        prompt: str,
        timeout: float | None = None,
    ) -> str:
        """Run a one-off headless RPC prompt, return the complete text."""
        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")
        timeout = self.default_timeout if timeout is None else timeout

        proc = await self._spawn()
        assert proc.stdin is not None and proc.stdout is not None
        state = _RunState(request_id=f"req-{uuid.uuid4().hex[:8]}")
        command = {"id": state.request_id, "type": "prompt", "message": prompt}
        proc.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
        await proc.stdin.drain()

        try:
            while True:
                try:
                    line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
                except TimeoutError as e:
                    proc.kill()
                    raise TimeoutError(
                        f"Pi RPC timed out after {timeout}s waiting for output"
                    ) from e
                if not line:
                    break
                record = self._parse_line(line)
                if record is None:
                    continue
                rtype = record.get("type")
                if rtype == "error":
                    raise RuntimeError(f"Pi RPC error: {record}")
                if rtype == "response":
                    self._check_response(record, state)
                    continue
                if rtype == "message_update":
                    state.apply_update(record)
                elif rtype == "message_end":
                    state.apply_message_end(record)
                elif self._is_settled(record):
                    break
        finally:
            stderr_bytes = await self._close_quietly(proc)

        text = state.combined_text().strip()
        if text:
            return text
        stderr_tail = stderr_bytes.decode("utf-8", errors="replace").strip()[-2000:]
        logger.error("Pi empty reply; stderr tail: %r", stderr_tail)
        raise self._empty_reply_error(state, stderr_tail)

async def stream_prompt(self, prompt: str) -> AsyncGenerator[str, None]:
        """Yield Server-Sent Event lines streaming Pi token deltas."""
        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")

        proc = await self._spawn()
        assert proc.stdin is not None and proc.stdout is not None
        state = _RunState(request_id=f"stream-{uuid.uuid4().hex[:8]}")
        command = {"id": state.request_id, "type": "prompt", "message": prompt}
        proc.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
        await proc.stdin.drain()
        
        # FIX 1: Close stdin so the Pi CLI knows no more commands are coming
        proc.stdin.close()

        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                record = self._parse_line(line)
                if record is None:
                    continue
                rtype = record.get("type")
                if rtype == "error":
                    yield f"data: {json.dumps({'error': str(record)})}\n\n"
                    break
                if rtype == "response":
                    try:
                        self._check_response(record, state)
                    except RuntimeError as e:
                        yield f"data: {json.dumps({'error': str(e)})}\n\n"
                        break
                    continue
                if rtype == "message_update":
                    new_text = state.apply_update(record)
                    if new_text:
                        yield f"data: {json.dumps({'delta': new_text})}\n\n"
                elif rtype == "message_end":
                    before = state.combined_text()
                    state.apply_message_end(record)
                    # If no deltas ever streamed, emit the authoritative text.
                    if not before and state.final_text:
                        yield f"data: {json.dumps({'delta': state.final_text})}\n\n"
                    
                    # FIX 2: Force break the loop as soon as the assistant's message ends
                    break
                    
                elif self._is_settled(record):
                    break
            
            if not state.combined_text().strip():
                err = self._empty_reply_error(state, "")
                yield f"data: {json.dumps({'error': str(err)})}\n\n"
            else:
                yield f"data: {json.dumps({'status': 'done'})}\n\n"
        finally:
            await self._close_quietly(proc)
