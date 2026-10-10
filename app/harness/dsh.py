"""DeepSeek Harness (dsh) plugin configs as our Node.harness JSON.

dsh advertises every tunable plugin through:
- ``dsh --profile <name> --dump-config`` (local ground truth for rows)
- the generated Plugin Config Catalog
  (https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog)
- the Tool Catalog for model-facing tool schemas.

A running ``dsh`` is a Cordis plugin tree composed from ordered layers:
bundles (``dsh-base`` + profile bundle) -> profile ``cordis.patch.yml``
-> home ``cordis.patch.yml`` -> ``--patch`` overlay. Each row is
``{id, name, config}`` and a patch replaces the whole ``config`` by ``id``.

This module stores ONLY the patch layer in ``Node.harness`` so a Workbuddy
proposal can be applied verbatim with::

    dsh --profile headless --patch ./node-<id>.patch.yml

Harness JSON (v1)::

    {
      "version": 1,
      "kind": "dsh-customer-support",
      "profile": "headless",          # base composition we patch against
      "system_prompt": "...",         # convenience mirror of dsh-persona prefix
      "model": {"provider": ..., "model": ...},
      "dsh_plugins": [
        {"id": "persona", "name": "@deepseek-ai/dsh-persona",
         "config": {"prefix": "..."}},
        ...
      ]
    }

Only plugins in ``SUPPORTED_DSH_PLUGINS`` are accepted, and each ``config``
is checked against the allowlist extracted from the official config catalog.
Unknown keys fail with an actionable error (what was wrong + allowed keys)
so Workbuddy never hallucinates fields like runtime-only seams (e.g. the
``stream`` field on ``dsh-acp`` which the runtime schema deliberately
excludes from ``cordis.yml``).
"""

from __future__ import annotations

from difflib import get_close_matches
from typing import Any

# Plugin name -> metadata. ``allowed_config_keys`` is the settable subset from
# the official config catalog (verbatim field names). ``required`` lists keys
# dsh fails plugin load without. Keep this list customer-support-scoped:
# prompt/model/tools/policy/safety/context — not browsers, desktops, or IDEs.
# Source revisions: config-catalog.md @ deepseek-ai/deepseek-harness master.
SUPPORTED_DSH_PLUGINS: dict[str, dict[str, Any]] = {
    "@deepseek-ai/dsh-persona": {
        "description": "Customer-support persona text (deployment:persona-prefix).",
        "allowed_config_keys": {"prefix", "suffix", "complete", "includeRuntimeContext"},
        "required": {"prefix"},
    },
    "@deepseek-ai/dsh-system-prompt": {
        "description": "Deployment-authored system-prompt fragment + tool order.",
        "allowed_config_keys": {
            "includeHarnessIdentity",
            "includeRuntimeContext",
            "personaPrefix",
            "personaSuffix",
            "toolOrder",
        },
        "required": set(),
    },
    "@deepseek-ai/dsh-agent-default-model": {
        "description": "Default provider route + model for new agents.",
        "allowed_config_keys": {"provider", "model", "reasoningEffort"},
        "required": {"provider", "model"},
    },
    "@deepseek-ai/dsh-agent-loop": {
        "description": "Agent driver: parallelism cap + startup agents.",
        "allowed_config_keys": {"maxParallelToolCalls", "agents"},
        "required": set(),
    },
    "@deepseek-ai/dsh-tools": {
        "description": "Tool registry presentation (native vs ptc run_code).",
        "allowed_config_keys": {"mode", "maxParallelSubCalls"},
        "required": set(),
    },
    "@deepseek-ai/dsh-agent-tool-presentation": {
        "description": "Form the model sees: native | ptc | both.",
        "allowed_config_keys": {"mode"},
        "required": {"mode"},
    },
    "@deepseek-ai/dsh-llm-deepseek-api-key": {
        "description": "DeepSeek messages adapter (per-request API-key ref).",
        "allowed_config_keys": {
            "apiKeyEnv",
            "thinking",
            "reasoningEffort",
            "maxTokens",
            "models",
            "baseURL",
            "retryPolicy",
            "defaultContextWindow",
            "streamIdleTimeoutMs",
        },
        "required": set(),
    },
    "@deepseek-ai/dsh-llm-retry": {
        "description": "Retry policy wrapper around the LLM adapter.",
        "allowed_config_keys": {"mode", "backoff", "maxAttempts"},
        "required": set(),
    },
    "@deepseek-ai/dsh-user-approval": {
        "description": "Approval default: ask (interactive) | never (headless/CI).",
        "allowed_config_keys": {"policy"},
        "required": set(),
    },
    "@deepseek-ai/dsh-sandbox-policy": {
        "description": "File-sandbox default mode + fallback workspace root.",
        "allowed_config_keys": {"mode", "workspaceRoot"},
        "required": set(),
    },
    "@deepseek-ai/dsh-permission-presets": {
        "description": "Named sandbox+approval bundles (workspace-write, ...).",
        "allowed_config_keys": {"presets", "defaultPreset"},
        "required": {"presets"},
    },
    "@deepseek-ai/dsh-agent-preset": {
        "description": "One named agent composition submitted to the preset registry.",
        "allowed_config_keys": {
            "name",
            "description",
            "plugins",
            "model",
            "tools",
            "persona",
            "permissions",
        },
        "required": set(),
    },
    "@deepseek-ai/dsh-agent-preset-registry": {
        "description": "Which preset new sessions use by default.",
        "allowed_config_keys": {"default", "selectedDefault"},
        "required": {"default"},
    },
    "@deepseek-ai/dsh-subagent": {
        "description": "Subagent delegation policy (escalation/continuation).",
        "allowed_config_keys": {"maxDepth", "maxSubagents", "timeoutMs", "allowedPlugins"},
        "required": set(),
    },
    "@deepseek-ai/dsh-skill": {
        "description": "Skill registry + model-facing skill tool.",
        "allowed_config_keys": {"enabled", "registry", "tool"},
        "required": set(),
    },
    "@deepseek-ai/dsh-skill-filesystem": {
        "description": "Local filesystem skill provider (dirs, cache).",
        "allowed_config_keys": {"dirs", "dshHome", "cache"},
        "required": set(),
    },
    "@deepseek-ai/dsh-compaction-basic": {
        "description": "Context compaction thresholds + summarizer model.",
        "allowed_config_keys": {
            "thresholdRatio",
            "headroomTokens",
            "retainRatio",
            "retainTokens",
            "summarizationProvider",
            "summarizationModel",
            "maxTokens",
            "compactionRetries",
            "maxOverflowRetries",
            "modelPolicies",
            "auto",
        },
        "required": set(),
    },
    "@deepseek-ai/dsh-compaction-tool-result-pruner": {
        "description": "Deterministic char-budget pruning of tool results.",
        "allowed_config_keys": {"thresholdChars", "headChars", "tailChars"},
        "required": set(),
    },
    "@deepseek-ai/dsh-mcp-client": {
        "description": "Attach external MCP servers (support KB, orders, CRM).",
        "allowed_config_keys": {"servers", "toolCallTimeoutMs", "reconnect"},
        "required": set(),
    },
    "@deepseek-ai/dsh-tool-workflow": {
        "description": "Model-facing guided workflows (refund, triage, escalation).",
        "allowed_config_keys": {"workflows", "enabled"},
        "required": set(),
    },
    "@deepseek-ai/dsh-plan-mode": {
        "description": "Plan-before-act mode for high-stakes actions.",
        "allowed_config_keys": {"enabled", "requireApproval", "maxPlanSteps"},
        "required": set(),
    },
    "@deepseek-ai/dsh-session-title": {
        "description": "Session title generation policy.",
        "allowed_config_keys": {"enabled", "model", "maxLength"},
        "required": set(),
    },
    "@deepseek-ai/dsh-repeat-tool-reminder": {
        "description": "Nudge the model when it repeats a failing tool call.",
        "allowed_config_keys": {"enabled", "maxRepeats", "message"},
        "required": set(),
    },
    "@deepseek-ai/dsh-agent-instructions": {
        "description": "Workspace instruction loader (AGENTS.md-style) budgets.",
        "allowed_config_keys": {
            "maxBytes",
            "maxSourceBytes",
            "projectRootMarkers",
            "instructionFileCandidates",
            "localInstructionFileCandidates",
        },
        "required": {"maxBytes"},
    },
}

SUPPORTED_PROFILES = {"headless", "web", "sdk", "sdk-minimal", "acp"}
BASE_BUNDLES = ("dsh-base",)

HARNESS_VERSION = 1
HARNESS_KIND = "dsh-customer-support"


def list_supported_plugins() -> list[dict[str, Any]]:
    """Concise catalog for MCP/Workbuddy prompts (name + description + keys)."""
    return [
        {
            "name": name,
            "description": meta["description"],
            "allowed_config_keys": sorted(meta["allowed_config_keys"]),
            "required": sorted(meta["required"]),
        }
        for name, meta in sorted(SUPPORTED_DSH_PLUGINS.items())
    ]


def _fail(msg: str) -> ValueError:
    return ValueError(msg)


def validate_dsh_harness(data: dict[str, Any]) -> dict[str, Any]:
    """Validate a harness dict; return a normalized copy or raise ValueError."""
    if not isinstance(data, dict):
        raise _fail("harness must be a JSON object")
    if data.get("version") != HARNESS_VERSION:
        raise _fail(f"harness.version must be {HARNESS_VERSION}")
    if data.get("kind") != HARNESS_KIND:
        raise _fail(f"harness.kind must be {HARNESS_KIND!r}")

    profile = data.get("profile", "headless")
    if profile not in SUPPORTED_PROFILES:
        raise _fail(
            f"harness.profile {profile!r} unknown; choose one of {sorted(SUPPORTED_PROFILES)}"
        )

    plugins = data.get("dsh_plugins")
    if not isinstance(plugins, list):
        raise _fail("harness.dsh_plugins must be a list of {id, name, config}")

    seen_ids: set[str] = set()
    normalized_plugins: list[dict[str, Any]] = []
    for i, entry in enumerate(plugins):
        where = f"dsh_plugins[{i}]"
        if not isinstance(entry, dict):
            raise _fail(f"{where} must be an object with id/name/config")
        pid = entry.get("id")
        name = entry.get("name")
        config = entry.get("config", {})
        if not pid or not isinstance(pid, str):
            raise _fail(f"{where}.id must be a non-empty string (cordis row id)")
        if pid in seen_ids:
            raise _fail(f"{where}.id {pid!r} is duplicated; patch rows replace by id")
        seen_ids.add(pid)
        if name not in SUPPORTED_DSH_PLUGINS:
            hint = get_close_matches(str(name), SUPPORTED_DSH_PLUGINS.keys(), n=3)
            raise _fail(
                f"{where}.name {name!r} is not an advertised dsh plugin. "
                f"Did you mean {hint}? "
                f"See list_supported_plugins() / config-catalog; base bundles stay "
                f"{list(BASE_BUNDLES)} and only the patch layer lives here."
            )
        if not isinstance(config, dict):
            raise _fail(f"{where}.config must be an object")
        meta = SUPPORTED_DSH_PLUGINS[name]
        allowed: set[str] = meta["allowed_config_keys"]
        unknown = set(config) - allowed
        if unknown:
            raise _fail(
                f"{where} ({name}) has unknown config keys {sorted(unknown)}; "
                f"allowed: {sorted(allowed)}. "
                f"Check the Plugin Config Catalog — runtime-only seams are not settable."
            )
        missing = set(meta["required"]) - set(config)
        if missing:
            raise _fail(f"{where} ({name}) is missing required keys {sorted(missing)}")
        normalized_plugins.append({"id": pid, "name": name, "config": dict(config)})

    out = dict(data)
    out["profile"] = profile
    out["dsh_plugins"] = normalized_plugins
    return out


def default_customer_support_harness() -> dict[str, Any]:
    """Bare seed harness: no default plugins.

    Every call starts with an empty patch layer — plugins are added per call
    via the ``harness`` field on ``POST /deepseek/chat`` and
    ``POST /deepseek/stream``. This returns the minimal valid harness so
    callers have a starting document to append ``dsh_plugins`` entries to.
    """
    return {
        "version": HARNESS_VERSION,
        "kind": HARNESS_KIND,
        "profile": "headless",
        "system_prompt": "",
        "model": {"provider": "deepseek-official", "model": "deepseek-chat"},
        "dsh_plugins": [],
    }


def example_verifiable_harness() -> dict[str, Any]:
    """Minimal harness with one plugin whose effect is checkable via the API.

    The ``dsh-persona`` prefix instructs a distinctive, observable behavior
    (every reply starts with the literal word ``VERIFIED``). Call
    ``GET /harness/example`` to fetch it, pass it as ``harness`` to
    ``POST /deepseek/chat``, and check the reply — no mocks, no guessing.
    Opt-in only; the default harness stays bare.
    """
    return {
        "version": HARNESS_VERSION,
        "kind": HARNESS_KIND,
        "profile": "headless",
        "system_prompt": "",
        "model": {"provider": "deepseek-official", "model": "deepseek-chat"},
        "dsh_plugins": [
            {
                "id": "persona",
                "name": "@deepseek-ai/dsh-persona",
                "config": {
                    "prefix": (
                        "You are a customer-support agent. Start every reply "
                        "with the literal word VERIFIED on its own line, "
                        "then answer the customer normally."
                    ),
                },
            },
        ],
    }


def _yaml_scalar(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value)
    if any(c in s for c in ":#{}[]&*?|>-<=!%@`,\"'\n"):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if s == "" or s.strip() != s:
        return '"' + s.replace('"', '\\"') + '"'
    return s


def _yaml_block(value: Any, indent: int) -> list[str]:
    pad = " " * indent
    if isinstance(value, dict):
        if not value:
            return [pad + "{}"]
        lines: list[str] = []
        for k, v in value.items():
            if isinstance(v, (dict, list)):
                lines.append(f"{pad}{k}:")
                lines.extend(_yaml_block(v, indent + 2))
            else:
                lines.append(f"{pad}{k}: {_yaml_scalar(v)}")
        return lines
    if isinstance(value, list):
        if not value:
            return [pad + "[]"]
        lines = []
        for item in value:
            if isinstance(item, (dict, list)):
                lines.append(pad + "-")
                lines.extend(_yaml_block(item, indent + 2))
            else:
                lines.append(f"{pad}- {_yaml_scalar(item)}")
        return lines
    return [pad + _yaml_scalar(value)]


def to_cordis_patch_yml(harness: dict[str, Any]) -> str:
    """Render the harness patch layer as a ``cordis.patch.yml`` document.

    Apply with ``dsh --profile <profile> --patch <file>`` or
    ``dsh --profile <profile> --dump-config`` to verify. Full-row replace
    semantics: each entry replaces the whole ``config`` of the row ``id``.
    """
    h = validate_dsh_harness(harness)
    lines = [
        "# Generated from Node.harness — do not hand-edit.",
        f"# profile: {h['profile']} (base: {', '.join(BASE_BUNDLES)} + dsh-{h['profile']})",
    ]
    for entry in h["dsh_plugins"]:
        lines.append(f"- id: {entry['id']}")
        lines.append(f"  name: '{entry['name']}'")
        lines.append("  config:")
        lines.extend(_yaml_block(entry["config"], 4))
    return "\n".join(lines) + "\n"


def harness_diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Small structural diff so get_children can show what changed.

    Returns ``{added, removed, changed}`` keyed by plugin ``id`` with
    per-key ``{from, to}`` for changed configs.
    """

    def by_id(h: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {p["id"]: p for p in h.get("dsh_plugins", [])}

    a, b = by_id(old), by_id(new)
    added = [p for pid, p in b.items() if pid not in a]
    removed = [p for pid, p in a.items() if pid not in b]
    changed: dict[str, Any] = {}
    for pid in a.keys() & b.keys():
        if a[pid]["name"] != b[pid]["name"]:
            changed[pid] = {"name": {"from": a[pid]["name"], "to": b[pid]["name"]}}
            continue
        ca, cb = a[pid].get("config", {}), b[pid].get("config", {})
        keys = set(ca) | set(cb)
        delta = {
            k: {"from": ca.get(k), "to": cb.get(k)} for k in sorted(keys) if ca.get(k) != cb.get(k)
        }
        if delta:
            changed[pid] = delta
    top = {}
    for k in ("system_prompt", "profile", "model"):
        if old.get(k) != new.get(k):
            top[k] = {"from": old.get(k), "to": new.get(k)}
    if top:
        changed["_top"] = top
    return {"added": added, "removed": removed, "changed": changed}


def resolve_runtime(
    harness: dict[str, Any] | None,
    *,
    system_prompt: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Translate a stored harness patch-layer into per-request OpenAI params.

    Our server does NOT spawn a dsh Node process per call — it calls the
    DeepSeek OpenAI-compatible HTTP API directly. So only the subset of
    plugins that maps to a chat-completions request takes effect per call;
    the rest is reported as ``ignored`` (still stored on the Node for
    optimizer signal / future real-dsh replay via ``to_cordis_patch_yml``).

    Effective mapping:
    - system text = explicit ``system_prompt`` arg > ``harness.system_prompt``
      > ``dsh-persona.prefix`` (+ suffix) > ``dsh-system-prompt`` prefix/suffix
    - model = explicit ``model`` arg > ``dsh-agent-default-model.model`` >
      ``harness.model.model`` > server default (caller fills in)
    - tools presentation / approval / sandbox / compaction / presets are
      returned as ``policy_notes`` + ``ignored``: they shape the prompt text
      only via the persona, they do not change the HTTP call.
    """

    def plugin_config(h: dict[str, Any], name: str) -> dict[str, Any]:
        for p in h.get("dsh_plugins", []):
            if p.get("name") == name:
                return p.get("config", {})
        return {}

    applied: list[str] = []
    ignored: list[str] = []
    policy_notes: list[str] = []
    system_parts: list[str] = []
    resolved_model = model

    if harness is None:
        if system_prompt:
            system_parts.append(system_prompt)
        return {
            "system_text": "\n\n".join(system_parts) if system_parts else None,
            "model": resolved_model,
            "applied_plugins": applied,
            "ignored_plugins": ignored,
            "policy_notes": policy_notes,
        }

    h = validate_dsh_harness(harness)
    if system_prompt:
        system_parts.append(system_prompt)
        applied.append("request.system_prompt")
    elif h.get("system_prompt"):
        system_parts.append(str(h["system_prompt"]))
        applied.append("harness.system_prompt")

    persona = plugin_config(h, "@deepseek-ai/dsh-persona")
    if persona:
        applied.append("dsh-persona")
        if not system_prompt and not h.get("system_prompt") and persona.get("prefix"):
            system_parts.append(str(persona["prefix"]))
        if persona.get("suffix"):
            system_parts.append(str(persona["suffix"]))
    sys_cfg = plugin_config(h, "@deepseek-ai/dsh-system-prompt")
    if sys_cfg:
        applied.append("dsh-system-prompt")
        if sys_cfg.get("personaPrefix"):
            system_parts.append(str(sys_cfg["personaPrefix"]))
        if sys_cfg.get("personaSuffix"):
            system_parts.append(str(sys_cfg["personaSuffix"]))

    model_cfg = plugin_config(h, "@deepseek-ai/dsh-agent-default-model")
    if model_cfg:
        applied.append("dsh-agent-default-model")
        if resolved_model is None:
            resolved_model = str(model_cfg.get("model") or "")
        if model_cfg.get("reasoningEffort"):
            policy_notes.append(f"reasoningEffort={model_cfg['reasoningEffort']}")
    if resolved_model is None and isinstance(h.get("model"), dict):
        resolved_model = h["model"].get("model")  # type: ignore[union-attr]
        if resolved_model:
            applied.append("harness.model")

    # These are stored signal but have no per-HTTP-call effect in this server.
    for name in (
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-agent-tool-presentation",
        "@deepseek-ai/dsh-user-approval",
        "@deepseek-ai/dsh-sandbox-policy",
        "@deepseek-ai/dsh-permission-presets",
        "@deepseek-ai/dsh-compaction-basic",
        "@deepseek-ai/dsh-compaction-tool-result-pruner",
        "@deepseek-ai/dsh-agent-loop",
        "@deepseek-ai/dsh-llm-retry",
        "@deepseek-ai/dsh-llm-deepseek-api-key",
        "@deepseek-ai/dsh-subagent",
        "@deepseek-ai/dsh-skill",
        "@deepseek-ai/dsh-skill-filesystem",
        "@deepseek-ai/dsh-mcp-client",
        "@deepseek-ai/dsh-tool-workflow",
        "@deepseek-ai/dsh-plan-mode",
        "@deepseek-ai/dsh-session-title",
        "@deepseek-ai/dsh-repeat-tool-reminder",
        "@deepseek-ai/dsh-agent-instructions",
        "@deepseek-ai/dsh-agent-preset",
        "@deepseek-ai/dsh-agent-preset-registry",
    ):
        cfg = plugin_config(h, name)
        if cfg:
            short = name.replace("@deepseek-ai/", "")
            ignored.append(short)
            # Keep the two safety-critical ones visible as prompt policy.
            if name == "@deepseek-ai/dsh-user-approval" and cfg.get("policy"):
                policy_notes.append(f"approval={cfg['policy']}")
            if name == "@deepseek-ai/dsh-sandbox-policy" and cfg.get("mode"):
                policy_notes.append(f"sandbox={cfg['mode']}")

    return {
        "system_text": "\n\n".join(system_parts) if system_parts else None,
        "model": resolved_model or None,
        "applied_plugins": applied,
        "ignored_plugins": sorted(set(ignored)),
        "policy_notes": policy_notes,
    }
