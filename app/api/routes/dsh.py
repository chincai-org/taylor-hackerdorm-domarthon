"""Launch the literal DeepSeek Harness web UI on this machine.

Local-only bridge: exports a node's harness text as ``cordis.patch.yml`` into a
temp workspace, spawns ``dsh web`` there, and hands back its URL. Disabled
unless ``ALLOW_DSH_SPAWN=1`` — a hosted server must never spawn local processes.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import llm_api_key, settings
from app.db import repository, session_scope

router = APIRouter(prefix="/dsh", tags=["dsh"])

_LAUNCHES: dict[int, dict[str, Any]] = {}
_URL_RE = re.compile(r"https?://[^\s'\"]+")


def _translate_node_patch(harness_text: str) -> str:
    """Map node harness rows onto web-profile row ids dsh --patch accepts.

    Node ids (persona, tool-filesystem, …) do not exist in the web profile, so
    a raw dump is dropped entry by entry. Only carried-over settings are
    emitted; anything without a counterpart is left to profile defaults.
    """
    import yaml

    try:
        rows = yaml.safe_load(harness_text) or []
    except yaml.YAMLError:
        return ""
    by_id = {r.get("id"): r for r in rows if isinstance(r, dict)}
    patch: list[dict[str, Any]] = []

    def _config(row_id: str) -> dict[str, Any]:
        row = by_id.get(row_id)
        if not isinstance(row, dict):
            return {}
        config = row.get("config")
        return config if isinstance(config, dict) else {}

    prefix = _config("persona").get("prefix")
    if isinstance(prefix, str) and prefix.strip():
        patch.append(
            {
                "id": "system-prompt",
                "name": "@deepseek-ai/dsh-system-prompt",
                "config": {"personaPrefix": prefix},
            }
        )
    fs_workspace = _config("tool-filesystem").get("workspace")
    if isinstance(fs_workspace, str) and fs_workspace.strip():
        patch.append(
            {
                "id": "tool-fs",
                "name": "@deepseek-ai/dsh-tool-fs",
                "config": {"workspace": fs_workspace},
            }
        )
    return yaml.safe_dump(patch, sort_keys=False) if patch else ""


def _spawn_enabled() -> bool:
    return settings.ALLOW_DSH_SPAWN


def _npx() -> str:
    path = shutil.which("npx")
    if path is None:
        raise HTTPException(status_code=503, detail="npx not found on server machine.")
    return path


class LaunchRequest(BaseModel):
    tree_id: str
    node_id: str
    port: int = Field(default=0, ge=0, le=65535)


@router.post("/launch", status_code=201)
def launch_dsh_web(request: LaunchRequest) -> dict[str, Any]:
    """Export node harness and boot ``dsh web`` on it. Returns its local URL."""
    if not _spawn_enabled():
        raise HTTPException(
            status_code=403,
            detail="Local dsh spawn disabled. Set ALLOW_DSH_SPAWN=1 on your machine.",
        )
    with session_scope() as session:
        node = repository.get_node(session, tree_id=request.tree_id, node_id=request.node_id)
    if node is None or not node.harness:
        raise HTTPException(status_code=404, detail="No harness found for node.")
    workspace = tempfile.mkdtemp(prefix="dsh-harness-")
    exported = node.harness
    # dsh-native key reference: apiKeyEnv beats the ${ENV:...} placeholder,
    # which dsh may pass through literally (→ "API key is invalid").
    if "apiKeyEnv" not in exported:
        exported = exported.replace(
            'apiKey: "${ENV:DEEPSEEK_API_KEY}"', "apiKeyEnv: DEEPSEEK_API_KEY"
        )
    # Pin the provider catalog + endpoint dsh web actually uses: without a
    # dsh-llm-deepseek row it falls back to model id "deepseek-flash", which
    # Grafilab rejects (surfaced as "API key is invalid").
    if "dsh-llm-deepseek" not in exported:
        exported = exported.rstrip() + (
            "\n- id: llm-deepseek\n"
            "  name: '@deepseek-ai/dsh-llm-deepseek'\n"
            "  config:\n"
            '    baseURL: "https://llm.grafilab.ai/v1"\n'
            "    models:\n"
            "      - id: grafilab/deepseek-v4-flash\n"
            "        name: Grafilab DeepSeek V4 Flash\n"
        )
    with open(f"{workspace}/cordis.patch.yml", "w", encoding="utf-8") as handle:
        handle.write(exported)
    # The node harness must be TRANSLATED to profile row ids: dsh web loads its
    # own profile and --patch only overrides existing row ids (unknown ids are
    # dropped with "entry not found"). Verified via `dsh --dump-config`.
    node_patch_path = f"{workspace}/node.patch.yml"
    with open(node_patch_path, "w", encoding="utf-8") as handle:
        handle.write(_translate_node_patch(exported))
    # Provider overlay: registers Grafilab (OpenAI-compatible) as a selectable
    # provider with the working model id, and makes it the default. Without
    # this dsh falls back to catalog id "deepseek-flash", which Grafilab 404s
    # (surfaced as "API key is invalid"). Verified via `dsh --dump-config`.
    patch_path = f"{workspace}/grafilab-provider.patch.yml"
    with open(patch_path, "w", encoding="utf-8") as handle:
        handle.write(
            "- id: llm-pi-ai\n"
            "  name: '@deepseek-ai/dsh-llm-pi-ai'\n"
            "  config:\n"
            "    providers:\n"
            "      grafilab:\n"
            "        displayName: Grafilab\n"
            "        api: openai-completions\n"
            '        baseURL: "https://llm.grafilab.ai/v1"\n'
            "        apiKeyEnv: DEEPSEEK_API_KEY\n"
            "        models:\n"
            "          - id: grafilab/deepseek-v4-flash\n"
            "- id: agent-default-model\n"
            "  name: '@deepseek-ai/dsh-agent-default-model'\n"
            "  config:\n"
            "    provider: grafilab\n"
            "    model: grafilab/deepseek-v4-flash\n"
        )
    # The exported yml points at the Grafilab OpenAI-compatible endpoint with
    # apiKey ${ENV:DEEPSEEK_API_KEY}: inherit the server's model key so dsh web
    # works without manual key entry. Explicit user env always wins.
    env = dict(os.environ)
    if llm_api_key():
        env.setdefault("DEEPSEEK_API_KEY", llm_api_key())
    env.setdefault("DEEPSEEK_BASE_URL", settings.GRAFFILAB_BASE_URL)
    try:
        proc = subprocess.Popen(
            [
                _npx(),
                "-y",
                "@deepseek-ai/dsh",
                "--profile",
                "web",
                "--patch",
                node_patch_path,
                "--patch",
                patch_path,
                "--no-open",
                "--port",
                str(request.port),
            ],
            cwd=workspace,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not start dsh: {exc}") from exc
    url: str | None = None
    output: list[str] = []
    assert proc.stdout is not None
    started = time.monotonic()
    while time.monotonic() - started < 45 and proc.poll() is None and url is None:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.2)
            continue
        output.append(line)
        match = _URL_RE.search(line)
        if match:
            url = match.group(0)
    if url is None:
        proc.kill()
        tail = "".join(output[-10:])
        raise HTTPException(
            status_code=500, detail=f"dsh web produced no URL. Output: {tail[:500]}"
        )
    _LAUNCHES[proc.pid] = {
        "pid": proc.pid,
        "url": url,
        "workspace": workspace,
        "tree_id": request.tree_id,
        "node_id": request.node_id,
        "proc": proc,
    }
    return {"url": url, "pid": proc.pid, "workspace": workspace}


@router.get("/launches")
def list_launches() -> dict[str, Any]:
    return {
        "launches": [
            {k: v for k, v in info.items() if k != "proc"}
            for info in _LAUNCHES.values()
            if info["proc"].poll() is None
        ]
    }


@router.delete("/launches/{pid}")
def kill_launch(pid: int) -> dict[str, Any]:
    info = _LAUNCHES.pop(pid, None)
    if info is None:
        raise HTTPException(status_code=404, detail="Unknown launch.")
    info["proc"].kill()
    # Temp workspaces must not litter /tmp forever: remove only what we made.
    workspace = str(info.get("workspace") or "")
    if workspace.startswith(f"{tempfile.gettempdir()}/dsh-harness-"):
        shutil.rmtree(workspace, ignore_errors=True)
    return {"killed": pid}
