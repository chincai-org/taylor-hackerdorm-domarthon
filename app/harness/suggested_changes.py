"""Apply bounded, parent-relative harness suggestions.

The optimizer should describe only the changes it wants to make.  This module
turns that small change set into a validated child harness while preserving all
parent fields that were not explicitly mentioned.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any

from app.harness.dsh import validate_dsh_harness

MAX_SUGGESTED_CHANGE_LINES = 120
_ALLOWED_KEYS = {"system_prompt", "model", "plugins", "add_plugins", "remove_plugins"}
_MODEL_KEYS = {"provider", "model"}
_PLUGIN_KEYS = {"id", "config", "remove_config_keys"}


def _embedded_newline_count(value: Any) -> int:
    if isinstance(value, str):
        return value.count("\n")
    if isinstance(value, dict):
        return sum(_embedded_newline_count(item) for item in value.values())
    if isinstance(value, list):
        return sum(_embedded_newline_count(item) for item in value)
    return 0


def _suggested_change_lines(value: dict[str, Any]) -> int:
    """Count pretty-printed payload lines, including multiline text values."""
    serialized = json.dumps(value, ensure_ascii=False, indent=2)
    return serialized.count("\n") + 1 + _embedded_newline_count(value)


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _plugins_by_id(harness: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {plugin["id"]: plugin for plugin in harness["dsh_plugins"]}


def _update_existing_plugin(
    harness: dict[str, Any],
    change: dict[str, Any],
) -> None:
    plugin_id = _require_string(change.get("id"), "plugins[].id")
    unknown = set(change) - _PLUGIN_KEYS
    if unknown:
        raise ValueError(
            f"plugins[{plugin_id!r}] has unsupported keys {sorted(unknown)}; "
            "use only id, config, and remove_config_keys"
        )
    plugin = _plugins_by_id(harness).get(plugin_id)
    if plugin is None:
        raise ValueError(
            f"plugins[{plugin_id!r}] is not present in the parent; use add_plugins "
            "to introduce a new plugin"
        )
    config = change.get("config", {})
    if not isinstance(config, dict):
        raise ValueError(f"plugins[{plugin_id!r}].config must be an object")
    remove_keys = change.get("remove_config_keys", [])
    if not isinstance(remove_keys, list) or not all(isinstance(key, str) for key in remove_keys):
        raise ValueError(f"plugins[{plugin_id!r}].remove_config_keys must be a list of strings")
    plugin["config"].update(deepcopy(config))
    for key in remove_keys:
        plugin["config"].pop(key, None)


def apply_suggested_changes(
    parent_harness: dict[str, Any],
    suggested_changes: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    """Return ``(child_harness, change_lines)`` from a partial change object.

    The accepted shape is intentionally not a complete harness document::

        {
          "system_prompt": "...",
          "model": {"model": "..."},
          "plugins": [{"id": "persona", "config": {"prefix": "..."}}],
          "add_plugins": [{"id": "tools", "name": "...", "config": {}}],
          "remove_plugins": ["old-plugin"]
        }

    ``plugins`` updates existing rows by merging only the supplied config keys.
    Unmentioned parent rows and config keys are retained.  The final merged
    harness is validated using the normal dsh schema.
    """
    if not isinstance(suggested_changes, dict):
        raise ValueError("suggested_changes must be a JSON object of parent-relative changes")
    if not suggested_changes:
        raise ValueError("suggested_changes must contain at least one change")

    unknown = set(suggested_changes) - _ALLOWED_KEYS
    if unknown:
        forbidden = sorted(unknown & {"version", "kind", "profile", "dsh_plugins"})
        if forbidden:
            raise ValueError(
                "suggested_changes must be parent-relative, not a full harness; "
                f"do not provide {forbidden}"
            )
        raise ValueError(
            f"suggested_changes has unsupported keys {sorted(unknown)}; "
            f"allowed keys are {sorted(_ALLOWED_KEYS)}"
        )

    change_lines = _suggested_change_lines(suggested_changes)
    if change_lines > MAX_SUGGESTED_CHANGE_LINES:
        raise ValueError(
            f"suggested_changes contains {change_lines} lines; the maximum is "
            f"{MAX_SUGGESTED_CHANGE_LINES}"
        )

    child = deepcopy(validate_dsh_harness(parent_harness))
    plugins = _plugins_by_id(child)

    if "system_prompt" in suggested_changes:
        prompt = _require_string(suggested_changes["system_prompt"], "system_prompt")
        child["system_prompt"] = prompt
        persona = plugins.get("persona")
        if persona is None:
            child["dsh_plugins"].append(
                {
                    "id": "persona",
                    "name": "@deepseek-ai/dsh-persona",
                    "config": {"prefix": prompt},
                }
            )
        else:
            persona["config"]["prefix"] = prompt

    if "model" in suggested_changes:
        model_change = suggested_changes["model"]
        if not isinstance(model_change, dict) or not model_change:
            raise ValueError("model must be a non-empty object")
        unknown_model_keys = set(model_change) - _MODEL_KEYS
        if unknown_model_keys:
            raise ValueError(f"model has unsupported keys {sorted(unknown_model_keys)}")
        for key, value in model_change.items():
            child["model"][key] = _require_string(value, f"model.{key}")
        model_plugin = next(
            (
                plugin
                for plugin in child["dsh_plugins"]
                if plugin["name"] == "@deepseek-ai/dsh-agent-default-model"
            ),
            None,
        )
        if model_plugin is None:
            child["dsh_plugins"].append(
                {
                    "id": "agent-default-model",
                    "name": "@deepseek-ai/dsh-agent-default-model",
                    "config": deepcopy(child["model"]),
                }
            )
        else:
            model_plugin["config"].update(deepcopy(model_change))

    plugin_changes = suggested_changes.get("plugins", [])
    if not isinstance(plugin_changes, list):
        raise ValueError("plugins must be a list of partial existing-plugin changes")
    for change in plugin_changes:
        if not isinstance(change, dict):
            raise ValueError("each plugins entry must be an object")
        _update_existing_plugin(child, change)

    additions = suggested_changes.get("add_plugins", [])
    if not isinstance(additions, list):
        raise ValueError("add_plugins must be a list of complete new plugin rows")
    for index, plugin in enumerate(additions):
        if not isinstance(plugin, dict):
            raise ValueError(f"add_plugins[{index}] must be an object")
        if set(plugin) != {"id", "name", "config"}:
            raise ValueError(f"add_plugins[{index}] must contain exactly id, name, and config")
        plugin_id = _require_string(plugin.get("id"), f"add_plugins[{index}].id")
        name = _require_string(plugin.get("name"), f"add_plugins[{index}].name")
        config = plugin.get("config")
        if not isinstance(config, dict):
            raise ValueError(f"add_plugins[{index}].config must be an object")
        if plugin_id in _plugins_by_id(child):
            raise ValueError(f"add_plugins[{index}] duplicates existing plugin id {plugin_id!r}")
        child["dsh_plugins"].append(
            {"id": plugin_id, "name": name, "config": deepcopy(config)}
        )

    removals = suggested_changes.get("remove_plugins", [])
    if not isinstance(removals, list) or not all(isinstance(item, str) for item in removals):
        raise ValueError("remove_plugins must be a list of plugin id strings")
    if removals:
        remove_set = set(removals)
        child["dsh_plugins"] = [
            plugin for plugin in child["dsh_plugins"] if plugin["id"] not in remove_set
        ]

    return validate_dsh_harness(child), change_lines
