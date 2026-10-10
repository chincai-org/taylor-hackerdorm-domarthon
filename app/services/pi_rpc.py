"""Headless RPC client for the Pi agent binary.

Wraps ``pi --mode rpc`` (stdin/stdout JSON Lines) so the FastAPI app and
other services can call Pi programmatically.

Protocol (per Pi docs):
    stdin  <- {"id": "<req-id>", "type": "prompt", "message": "<prompt>"}
    stdout -> JSONL event records, e.g.::
        {"id": "<req-id>", "type": "response", "command": "prompt", ...}
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "..."}}
        {"type": "agent_settled"}

Run ``pi --mode rpc --no-session`` for a one-off headless call, optionally
with ``--model <model>``.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from collections.abc import AsyncGenerator


class PiNotAvailableError(RuntimeError):
    """Raised when the `pi` binary cannot be found or started."""


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
            return None
        return record if isinstance(record, dict) else None

    @staticmethod
    def _extract_delta(record: dict) -> str | None:
        """Return text delta from a message_update record, if present."""
        if record.get("type") != "message_update":
            return None
        event = record.get("assistantMessageEvent", {})
        if not isinstance(event, dict):
            return None
        # Primary shape: {"type": "text_delta", "delta": "..."}
        if event.get("type") == "text_delta" and isinstance(event.get("delta"), str):
            return event["delta"]
        # Tolerate alternate shapes from future Pi versions.
        for key in ("delta", "text"):
            value = event.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    @staticmethod
    def _is_settled(record: dict) -> bool:
        return record.get("type") in ("agent_settled", "agent_error", "error")

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
        request_id = f"req-{uuid.uuid4().hex[:8]}"
        command = {"id": request_id, "type": "prompt", "message": prompt}
        proc.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
        await proc.stdin.drain()

        chunks: list[str] = []
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
                if record.get("type") == "error":
                    raise RuntimeError(f"Pi RPC error: {record}")
                delta = self._extract_delta(record)
                if delta:
                    chunks.append(delta)
                elif self._is_settled(record):
                    break
        finally:
            try:
                proc.stdin.close()
            except (BrokenPipeError, AttributeError):
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except TimeoutError:
                proc.kill()
                await proc.wait()

        return "".join(chunks).strip()

    async def stream_prompt(self, prompt: str) -> AsyncGenerator[str, None]:
        """Yield Server-Sent Event lines streaming Pi token deltas."""
        if not prompt or not prompt.strip():
            raise ValueError("prompt must be a non-empty string")

        proc = await self._spawn()
        assert proc.stdin is not None and proc.stdout is not None
        request_id = f"stream-{uuid.uuid4().hex[:8]}"
        command = {"id": request_id, "type": "prompt", "message": prompt}
        proc.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
        await proc.stdin.drain()

        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                record = self._parse_line(line)
                if record is None:
                    continue
                if record.get("type") == "error":
                    yield f"data: {json.dumps({'error': str(record)})}\n\n"
                    break
                delta = self._extract_delta(record)
                if delta:
                    yield f"data: {json.dumps({'delta': delta})}\n\n"
                elif self._is_settled(record):
                    break
            yield f"data: {json.dumps({'status': 'done'})}\n\n"
        finally:
            try:
                proc.stdin.close()
            except (BrokenPipeError, AttributeError):
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except TimeoutError:
                proc.kill()
                await proc.wait()
