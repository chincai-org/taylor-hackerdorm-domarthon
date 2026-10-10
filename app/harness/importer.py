"""Import real dsh material into a stored harness.

Upload either of these as raw text and get back normalized harness data ready for
``POST /deepseek/chat`` / ``POST /deepseek/stream`` and for Node storage:

- ``dsh --profile <name> --dump-config`` output (JSON or YAML)
- a ``cordis.yml`` / ``cordis.patch.yml`` document (a list of rows)

Row shape accepted per entry (keys are lenient — dumps vary)::

    {id, name, config}  (``name`` also accepted as ``package``/``plugin``,
    ``config`` also accepted as ``options``, defaults to ``{}``)

Only plugins in ``SUPPORTED_DSH_PLUGINS`` are kept; everything else is
reported in ``dropped`` with a reason (not an error — a real dump contains
~100 rows of client UI / desktop / IDE stuff irrelevant here). Config keys
outside our allowlist are dropped per key and reported, so the returned
harness always passes ``validate_dsh_harness``.
"""

from __future__ import annotations

import json
from typing import Any

from app.harness.dsh import (
    HARNESS_KIND,
    HARNESS_VERSION,
    SUPPORTED_DSH_PLUGINS,
    is_generic_plugin,
    validate_dsh_harness,
)

_ROW_LIST_KEYS = ("entries", "rows", "plugins", "patch")


def _lenient_loader() -> Any:
    """SafeLoader that keeps unknown tags (e.g. dsh ``!!js`` expressions).

    Dump output renders ``!!js`` expressions verbatim; a plain SafeLoader
    chokes on them. We keep them as opaque strings — stored, never executed.
    """
    import yaml

    class LenientLoader(yaml.SafeLoader):
        pass

    def _unknown_tag(loader: Any, _suffix: str, node: Any) -> Any:
        if isinstance(node, yaml.ScalarNode):
            return loader.construct_scalar(node)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node)
        return loader.construct_mapping(node)

    LenientLoader.add_multi_constructor("", _unknown_tag)
    return LenientLoader


def _load_document(content: str) -> Any:
    """Parse raw text as JSON first, then YAML. Raises ValueError."""
    if not content or not content.strip():
        raise ValueError("content must be non-empty text (dump-config output or cordis yml)")
    text = content.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    try:
        import yaml
    except ImportError as e:  # pragma: no cover
        raise ValueError("YAML support not installed") from e
    try:
        return yaml.load(text, Loader=_lenient_loader())
    except yaml.YAMLError as e:
        raise ValueError(f"content is neither valid JSON nor valid YAML: {e}") from e


def _extract_rows(doc: Any) -> tuple[list[Any], str | None]:
    """Return (raw rows, profile hint) from a parsed dump/patch document."""
    profile: str | None = None
    if isinstance(doc, list):
        return doc, None
    if isinstance(doc, dict):
        for key in ("profile", "profileName"):
            if isinstance(doc.get(key), str):
                profile = doc[key]
                break
        for key in _ROW_LIST_KEYS:
            if isinstance(doc.get(key), list):
                return doc[key], profile
        # Mapping of id -> entry?
        if doc and all(isinstance(v, dict) for v in doc.values()):
            return [{"id": k, **v} for k, v in doc.items()], profile
    raise ValueError(
        "could not find plugin rows: expected a list of {id, name, config} "
        f"or a mapping with one of {list(_ROW_LIST_KEYS)}"
    )


def _normalize_row(raw: Any, index: int) -> dict[str, Any]:
    where = f"rows[{index}]"
    if not isinstance(raw, dict):
        raise ValueError(f"{where} must be an object")
    pid = raw.get("id")
    name = raw.get("name", raw.get("package", raw.get("plugin")))
    config = raw.get("config", raw.get("options", {}))
    if not pid or not isinstance(pid, str):
        raise ValueError(f"{where} is missing a string 'id'")
    if not name or not isinstance(name, str):
        raise ValueError(f"{where} (id {pid!r}) is missing 'name'")
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError(f"{where} (id {pid!r}) has a non-object 'config'")
    return {"id": pid, "name": name, "config": dict(config), "disabled": raw.get("disabled")}


def import_harness(content: str, profile: str | None = None) -> dict[str, Any]:
    """Convert raw dsh text into ``{harness, kept, dropped, warnings}``."""
    doc = _load_document(content)
    raw_rows, doc_profile = _extract_rows(doc)

    # Patches may group new rows under `- insert: [...]`; splice them inline.
    expanded: list[Any] = []
    for raw in raw_rows:
        if isinstance(raw, dict) and isinstance(raw.get("insert"), list):
            expanded.extend(raw["insert"])
        else:
            expanded.append(raw)
    raw_rows = expanded

    kept: list[dict[str, Any]] = []
    kept_ids: list[str] = []
    dropped: list[dict[str, str]] = []
    warnings: list[str] = []
    required_missing: list[str] = []

    for i, raw in enumerate(raw_rows):
        try:
            row = _normalize_row(raw, i)
        except ValueError as e:
            dropped.append({"id": "?", "name": "?", "reason": str(e)})
            continue
        if row["disabled"] is True:
            dropped.append({"id": row["id"], "name": row["name"], "reason": "row disabled"})
            continue
        meta = SUPPORTED_DSH_PLUGINS.get(row["name"])
        if meta is None:
            if is_generic_plugin(row["name"]):
                # Deployed but unpinned: store verbatim for real-dsh replay.
                # No per-call effect on this server (see resolve_runtime).
                kept.append({"id": row["id"], "name": row["name"], "config": row["config"]})
                kept_ids.append(row["id"])
                warnings.append(
                    f"{row['id']}: unvalidated plugin {row['name']!r} — stored "
                    "opaque, no per-call effect here"
                )
                continue
            dropped.append(
                {"id": row["id"], "name": row["name"], "reason": "plugin not in supported set"}
            )
            continue
        allowed = meta["allowed_config_keys"]
        if allowed is None:
            kept.append({"id": row["id"], "name": row["name"], "config": row["config"]})
            kept_ids.append(row["id"])
            continue
        config = {k: v for k, v in row["config"].items() if k in allowed}
        for k in sorted(set(row["config"]) - allowed):
            warnings.append(f"{row['id']}: dropped unsupported config key {k!r}")
        for k in sorted(set(meta["required"]) - set(config)):
            required_missing.append(f"{row['id']}: missing required key {k!r}")
        kept.append({"id": row["id"], "name": row["name"], "config": config})
        kept_ids.append(row["id"])

    if required_missing:
        warnings.extend(required_missing)

    def _cfg(name: str) -> dict[str, Any]:
        for p in kept:
            if p["name"] == name:
                return p["config"]
        return {}

    persona = _cfg("@deepseek-ai/dsh-persona")
    model_cfg = _cfg("@deepseek-ai/dsh-agent-default-model")
    openai_cfg = _cfg("@deepseek-ai/dsh-plugin-openai")
    # The OpenAI-compatible adapter carries the effective model id
    # (e.g. grafilab/deepseek-v4-flash) when no dsh-agent-default-model row is present.
    provider = str(model_cfg.get("provider", "deepseek-official"))
    model_id = str(model_cfg.get("model") or openai_cfg.get("model") or "deepseek-chat")
    harness = {
        "version": HARNESS_VERSION,
        "kind": HARNESS_KIND,
        "profile": profile or doc_profile or "headless",
        "system_prompt": str(persona.get("prefix", "")),
        "model": {
            "provider": provider,
            "model": model_id,
        },
        "dsh_plugins": kept,
    }
    validate_dsh_harness(harness)  # must pass — we filtered above
    if not kept:
        warnings.append("no supported plugins found — harness is bare (dsh_plugins: [])")
    return {"harness": harness, "kept": kept_ids, "dropped": dropped, "warnings": warnings}


def coerce_harness(
    harness: str | None = None,
    harness_yml: str | None = None,
    profile: str | None = None,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Accept harness as raw cordis.patch.yml or dsh dump-config text.

    Returns ``(harness_dict_or_None, meta)`` where ``meta`` is
    ``{kept, dropped, warnings, source}``. ``source`` is ``"none"`` or
    ``"yml"``. Raises ``ValueError`` with an actionable
    message when both forms are given, when text is blank/unparseable, or
    when the text fails validation.

    The returned dictionary is an internal normalized representation. Callers
    that persist or return a harness should use ``to_cordis_patch_yml`` so the
    harness remains text at the boundary.
    ``harness_yml`` is always treated as raw text. ``profile`` overrides the
    profile detected in the document.
    """
    if harness is not None and harness_yml is not None:
        raise ValueError("pass either 'harness' or 'harness_yml', not both")
    if harness is not None:
        if harness_yml is not None:
            raise ValueError("pass either 'harness' or 'harness_yml', not both")
        harness_yml = harness

    if harness_yml is not None:
        if not harness_yml.strip():
            raise ValueError("harness_yml must be non-empty cordis.patch.yml text")
        result = import_harness(harness_yml, profile=profile)
        meta = {
            "kept": result["kept"],
            "dropped": result["dropped"],
            "warnings": result["warnings"],
            "source": "yml",
        }
        return result["harness"], meta

    if harness is None:
        return None, {"kept": [], "dropped": [], "warnings": [], "source": "none"}

    raise AssertionError("unreachable")
