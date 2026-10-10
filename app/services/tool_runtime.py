"""Sandboxed tool runtime for autonomous agent loops.

The ``/deepseek/*`` routes used to be single-shot: the model could *emit*
``tool_calls`` but nothing ever *executed* them, so harness rows like
``dsh-plugin-fs`` / ``dsh-plugin-web-search`` were reported as ``ignored``.
This module closes that gap with stdlib-only executors plus an
OpenAI-compatible tool-schema map derived from the stored harness.

Design (hackathon-small):
- ``tools_for_harness(harness)`` -> OpenAI ``tools`` list. A harness row
  only *enables* a tool family; schemas are fixed here so the model gets a
  stable contract.
- ``execute(name, args)`` -> JSON-serializable result dict. Never raises;
  failures become ``{"error": ...}`` so the agent loop can recover.
- Filesystem is sandboxed to ``./workspace`` (traversal blocked, read-only
  plus size caps). Web helpers use ``urllib`` with short timeouts and
  truncated text (protects API quota / demo budget).
"""

from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

WORKSPACE = Path("./workspace").resolve()
try:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
except OSError:
    pass
MAX_TEXT_CHARS = 4000
WEB_TIMEOUT_S = 10.0

FS_PLUGIN_NAMES = frozenset(
    {
        "@deepseek-ai/dsh-plugin-fs",
        "@deepseek-ai/dsh-fs",
        "@deepseek-ai/dsh-fs-local",
        "@deepseek-ai/dsh-fs-sandbox",
        "@deepseek-ai/dsh-tool-fs",
    }
)

WEB_PLUGIN_NAMES = frozenset(
    {
        "@deepseek-ai/dsh-plugin-web-search",
        "@deepseek-ai/dsh-tool-web",
        "@deepseek-ai/dsh-web-search-deepseek",
        "@deepseek-ai/dsh-web-search-exa",
        "@deepseek-ai/dsh-web-search-perplexity",
    }
)


def _fs_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "fs_list",
                "description": "List files under the sandboxed workspace (relative paths).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Subdir, default '.'"}
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "fs_read",
                "description": "Read a text file from the sandboxed workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        },
    ]


def _web_tools() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web (no key, best-effort summary).",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch a URL as truncated text.",
                "parameters": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            },
        },
    ]


def tools_for_harness(harness: dict[str, Any] | None) -> tuple[list[dict[str, Any]], list[str]]:
    """Derive executable tool schemas from harness plugin rows.

    Returns ``(tools, families)`` where families is e.g. ``["fs", "web"]``.
    Unknown / opaque plugins yield nothing (still stored for real-dsh replay).
    """
    if not harness or not isinstance(harness.get("dsh_plugins"), list):
        return [], []
    names = {p.get("name") for p in harness["dsh_plugins"] if isinstance(p, dict)}
    tools: list[dict[str, Any]] = []
    families: list[str] = []
    if names & FS_PLUGIN_NAMES:
        tools.extend(_fs_tools())
        families.append("fs")
    if names & WEB_PLUGIN_NAMES:
        tools.extend(_web_tools())
        families.append("web")
    return tools, families


def _sandboxed(path_str: str) -> Path | None:
    try:
        target = (WORKSPACE / (path_str or ".")).resolve()
    except Exception:
        return None
    try:
        target.relative_to(WORKSPACE)
    except ValueError:
        return None
    return target


def _fs_list(args: dict[str, Any]) -> dict[str, Any]:
    target = _sandboxed(str(args.get("path") or "."))
    if target is None:
        return {"error": "path escapes workspace"}
    if not target.exists():
        return {"error": f"not found: {args.get('path')}"}
    if target.is_file():
        return {"entries": [target.name]}
    try:
        entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir())[:100]
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    return {"path": str(args.get("path") or "."), "entries": entries}


def _fs_read(args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("path") or "")
    if not raw:
        return {"error": "path is required"}
    target = _sandboxed(raw)
    if target is None:
        return {"error": "path escapes workspace"}
    if not target.is_file():
        return {"error": f"not a file: {raw}"}
    try:
        if target.stat().st_size > 200_000:
            return {"error": "file too large (>200KB)"}
        text = target.read_text(encoding="utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}
    return {"path": raw, "content": text[:MAX_TEXT_CHARS], "truncated": len(text) > MAX_TEXT_CHARS}


def _http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "hackerdorm-domarthon/1.0"})
    with urllib.request.urlopen(req, timeout=WEB_TIMEOUT_S) as resp:  # noqa: S310
        raw = resp.read(200_000)
    return raw.decode("utf-8", errors="replace")


def _strip_html(page: str) -> str:
    page = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", page)
    text = re.sub(r"(?s)<[^>]*>", " ", page)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _web_search(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    # If the user pasted a URL, fetch it directly — most predictable demo path.
    if re.match(r"^https?://", query):
        return _web_fetch({"url": query})
    url = "https://api.duckduckgo.com/?" + urllib.parse.urlencode(
        {"q": query, "format": "json", "no_html": 1, "skip_disambig": 1}
    )
    try:
        data = json.loads(_http_get_text(url))
    except Exception as e:  # noqa: BLE001
        return {"error": f"search failed: {e}", "query": query}
    abstract = str(data.get("AbstractText") or "")
    source = str(data.get("AbstractURL") or "")
    topics = []
    for t in (data.get("RelatedTopics") or [])[:5]:
        if isinstance(t, dict) and t.get("Text"):
            topics.append({"text": t["Text"][:300], "url": t.get("FirstURL", "")})
    text = abstract or " ".join(t["text"] for t in topics)
    return {
        "query": query,
        "answer": text[:MAX_TEXT_CHARS],
        "source": source,
        "related": topics,
    }


def _web_fetch(args: dict[str, Any]) -> dict[str, Any]:
    url = str(args.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        return {"error": "url must start with http(s)://"}
    try:
        page = _http_get_text(url)
    except Exception as e:  # noqa: BLE001
        return {"error": f"fetch failed: {e}", "url": url}
    text = _strip_html(page)
    return {"url": url, "content": text[:MAX_TEXT_CHARS], "truncated": len(text) > MAX_TEXT_CHARS}


EXECUTORS = {
    "fs_list": _fs_list,
    "fs_read": _fs_read,
    "web_search": _web_search,
    "web_fetch": _web_fetch,
}


def execute(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run one tool call; never raises (errors become ``{"error": ...}``)."""
    fn = EXECUTORS.get(name)
    if fn is None:
        return {"error": f"unknown tool: {name}"}
    if not isinstance(args, dict):
        return {"error": "arguments must be an object"}
    try:
        result = fn(args)
    except Exception as e:  # noqa: BLE001 - belt and braces for the loop
        return {"error": str(e)}
    return result if isinstance(result, dict) else {"result": result}
