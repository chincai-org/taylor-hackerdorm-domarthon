"""Rollout-then-judge evaluation for new harness nodes.

Scoring contract (rubric v3 low-skew — the single source of truth is the
constants and ``_rubric_text()`` below; the judge system prompt and every
judge prompt embed that exact text so the rubric cannot drift):

Per node, in two stages (one-shot batch):

1. **Candidate rollout (one shot)** — the benchmark dataset is loaded from
   the database (``benchmarks.scenarios`` for the tree; see
   ``load_benchmark_scenarios`` / ``evaluate_tree_harness_sync``), all
   scenario customer messages are combined into ONE prompt
   (``_batch_candidate_prompt``), and the stored harness text plus that
   combined prompt is POSTed once to the candidate API
   (``{CANDIDATE_BASE_URL}/api/v1/deepseek/chat`` with
   ``{prompt, harness_yml, max_steps, model}``). The rollout model is pinned
   to the judge model (stored harnesses default to ``deepseek-chat``, which
   does not exist on the Grafilab endpoint).
2. **Grafilab judge (one shot)** — one Grafilab API call at temperature 0
   whose prompt carries the stored harness text, ALL scenario expectations,
   AND the full combined rollout output, reading back per-scenario verdicts
   ``{"scenarios": [{"scenario_id", "passed", "score", "reason"}...]}``.

Bands: 99-100 flawless (essentially perfect only), 92-98 satisfies
(narrow pass band, trivial gaps only), 50-91 partial, 0-49 fail — most real
outputs should land well below 50. Caps (each applies independently; the
final score is the minimum of the band score and every applicable cap):
forbidden action 10, wrong final action 30, missing expected tool 40,
invented policy / guaranteed outcome 15, missing escalation for
billing/safety/unresolved issues 40. ``passed`` is true exactly when the
final score is >= 92 (``PASS_THRESHOLD``); when in doubt the judge scores
far lower. Unparseable judge replies fail every scenario at 0 — never a pass.

Determinism: the judge call is temperature 0 with a fixed rubric. The
rollout inherits the candidate API's default sampling (that API exposes no
temperature pin), so repeat runs of the same harness may vary — scores are
comparable, not bit-identical.

Failure table (each failure mode fails every scenario at 0, never part of
the node): rollout error → ``candidate_error: …`` (judge not called, saves
quota); judge transport error → ``judge_error: …``; judge reply
unparseable → ``judge_parse_error: …``; total budget exhausted →
``eval_total_timeout`` for every unfinished scenario (partials kept only on
the legacy sequential path).

Aggregation: node score = mean of the per-scenario 0-100 scores, rounded
to 2dp; ``passed`` count = scenarios with ``passed is True``. Empty
benchmarks fall back to one generic rollout + review (``"generic": True``).
Every result records ``rubric_version``, ``pass_threshold``,
``judge_model``, ``judge_temperature``, ``candidate_url``, ``batched``,
and the shared batch prompt/reply so scores stay comparable across runs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.request
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.services.deepseek_client import DeepSeekClient, DeepSeekNotAvailableError

logger = logging.getLogger(__name__)

# --- Scoring rubric v3 (low-skew): single source of truth. ---------------
# Bands, caps, and the pass rule live here and are rendered verbatim into
# the judge system prompt and every per-scenario judge prompt via
# _rubric_text(), so the three can never disagree. Recorded on every
# result as rubric_version / pass_threshold.
RUBRIC_VERSION = "3"
PASS_THRESHOLD = 92.0
FLAWLESS_MIN = 99.0  # 99-100 flawless, essentially perfect only.
SATISFIES_MIN = 92.0  # 92-98 satisfies, trivial gaps only (= pass).
PARTIAL_MIN = 50.0  # 50-91 partial, 0-49 fail.
CAP_FORBIDDEN = 10.0  # any forbidden action in the actual output.
CAP_WRONG_FINAL_ACTION = 30.0
CAP_MISSING_TOOL = 40.0  # missing an expected tool.
CAP_INVENTED_POLICY = 15.0  # invented policy or guaranteed outcome.
CAP_MISSING_ESCALATION = 40.0  # billing/safety/unresolved not escalated.
REASON_MAX_CHARS = 500


def _rubric_text() -> str:
    """Exact rubric embedded in every judge prompt (bands + caps + pass rule)."""
    return (
        "Score bands: 99-100 flawless and essentially perfect, 92-98 "
        "satisfies with only trivial gaps, 50-91 partially satisfies, 0-49 "
        "fails. Start from 0 and award points only for demonstrated correct "
        "handling; deduct steeply for every gap and resolve all doubt far "
        "downward — most real outputs should land well below 50. "
        "Award 99+ only for perfect, production-grade handling. "
        "Independent caps — apply every one that fits and take the minimum "
        "with the band score: "
        f"any forbidden action caps at {CAP_FORBIDDEN:.0f} and fails; "
        f"wrong final action caps at {CAP_WRONG_FINAL_ACTION:.0f}; "
        f"missing an expected tool caps at {CAP_MISSING_TOOL:.0f}; "
        "invented policy or guaranteed outcomes cap at "
        f"{CAP_INVENTED_POLICY:.0f}; "
        "missing escalation for billing/safety/unresolved issues caps at "
        f"{CAP_MISSING_ESCALATION:.0f}. "
        f"Mark passed true exactly when the final score is {PASS_THRESHOLD:.0f} "
        "or higher."
    )


JUDGE_SYSTEM = (
    "You are a harsh, deterministic customer-support benchmark judge. "
    "You receive a harness configuration, one benchmark scenario, AND the "
    "actual agent output produced by running that harness on the scenario "
    "customer message. "
    "Judge the ACTUAL output — not what the harness might do in theory. "
    + _rubric_text()
    + " Return ONLY a JSON object with exactly three keys: "
    '{"passed": boolean, "score": number, "reason": string}. '
    "No markdown, no extra text."
)

BATCH_JUDGE_SYSTEM = (
    "You are a harsh, deterministic customer-support benchmark judge. "
    "You receive a harness configuration, ALL benchmark scenarios at once, "
    "AND the actual agent output produced by running that harness on every "
    "scenario customer message in a single combined rollout. "
    "Judge the ACTUAL output — not what the harness might do in theory. "
    "Score each scenario independently against its own expectations. "
    + _rubric_text()
    + " Return ONLY a JSON object with exactly one key: "
    '{"scenarios": [{"scenario_id": string, "passed": boolean, '
    '"score": number, "reason": string}, ...]} '
    "with one entry per input scenario, in the same order, using the exact "
    "scenario_id values given. No markdown, no extra text."
)

GENERIC_REVIEW_SCENARIO = {
    "scenario_id": "generic-harness-review",
    "id": "generic-harness-review",
    "name": "Generic customer-support harness review",
    "generic_review": True,
    "notes": (
        "No benchmark scenarios are configured for this tree, so review the "
        "actual harness output in general instead of against a specific "
        "customer message."
    ),
}

GENERIC_ROLLOUT_PROMPT = "Hi, I need help with my recent order. Can you help me?"

# Caps so the judge prompt and stored result stay small.
CANDIDATE_REPLY_CHARS = 4000
CANDIDATE_TOOLCALL_CHARS = 4000
# Batch (one-shot) caps: the combined rollout covers every scenario, so the
# judge sees a larger window while each stored per-scenario item stays small.
BATCH_CANDIDATE_REPLY_CHARS = 12000
BATCH_CANDIDATE_TOOLCALL_CHARS = 8000
# Max batch prompt chars sent to the candidate (questions are short; this is
# a safety rail, not a target).
BATCH_PROMPT_CHARS = 12000
# Max tool calls kept per scenario in the stored result (oldest first).
MAX_TOOLCALL_ITEMS = 20


def _get_client() -> DeepSeekClient:
    """Client pinned to the Grafilab API (credentials + endpoint + model)."""
    return DeepSeekClient(
        api_key=(settings.GRAFFILAB_API_KEY or "").strip(),
        base_url=settings.GRAFFILAB_BASE_URL,
        model=_judge_model(),
        default_timeout=settings.JUDGE_TIMEOUT_S,
    )


def _judge_model() -> str:
    return (
        settings.JUDGE_MODEL or settings.GRAFFILAB_MODEL or ""
    ).strip() or "grafilab/deepseek-v4-flash"


def _candidate_url() -> str:
    return settings.CANDIDATE_BASE_URL.rstrip("/") + "/api/v1/deepseek/chat"


def _scenario_id(scenario: dict[str, Any], index: int) -> str:
    for key in ("scenario_id", "id", "name"):
        value = scenario.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return f"scenario-{index + 1}"


def _candidate_prompt(scenario: dict[str, Any]) -> str:
    """Customer message fed to the candidate rollout for one scenario."""
    if scenario.get("generic_review"):
        return GENERIC_ROLLOUT_PROMPT
    for key in ("customer_message", "question", "prompt", "message", "input"):
        value = scenario.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    name = scenario.get("name")
    if isinstance(name, str) and name.strip():
        return f"Handle this customer-support scenario: {name.strip()}"
    return "Hello, I need help with a customer-support issue."


def _post_candidate_sync(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    """Blocking POST of one rollout request; raises on HTTP/parse errors."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read(500_000)
    except Exception as exc:
        raise RuntimeError(f"candidate rollout request failed: {exc}") from exc
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError(f"candidate rollout returned invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("candidate rollout returned a non-object response")
    return parsed


async def _run_candidate(
    patch_yml: str,
    scenario: dict[str, Any],
) -> dict[str, Any]:
    """Roll out the harness once via the candidate API; return its output."""
    payload = {
        "prompt": _candidate_prompt(scenario),
        "harness_yml": patch_yml,
        "max_steps": max(1, min(int(settings.CANDIDATE_MAX_STEPS or 5), 10)),
        # Pin the rollout model to the Grafilab judge model: stored harnesses
        # default to "deepseek-chat", which does not exist on the Grafilab
        # endpoint (404) — the per-call model beats harness default-model.
        "model": _judge_model(),
    }
    parsed = await asyncio.to_thread(
        _post_candidate_sync,
        _candidate_url(),
        payload,
        settings.EVAL_CANDIDATE_TIMEOUT_S,
    )
    reply = parsed.get("reply", "")
    return {
        "prompt": payload["prompt"],
        "reply": str(reply) if isinstance(reply, str) else str(reply or ""),
        "tool_calls": parsed.get("tool_calls", []),
        "steps": parsed.get("steps", []),
        "model": parsed.get("model"),
    }


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + "…[truncated]"


def _judge_prompt(
    patch_yml: str,
    scenario: dict[str, Any],
    candidate: dict[str, Any],
) -> str:
    """Harness text + scenario expectations + actual rollout output."""
    tool_calls = candidate.get("tool_calls", [])
    tool_calls_json = json.dumps(tool_calls, ensure_ascii=False)
    if len(tool_calls_json) > CANDIDATE_TOOLCALL_CHARS:
        tool_calls_json = tool_calls_json[:CANDIDATE_TOOLCALL_CHARS] + "…[truncated]"
    candidate_block = "\n".join(
        [
            f"rollout_prompt: {candidate.get('prompt', '')}",
            f"rollout_model: {candidate.get('model', '')}",
            f"rollout_reply: {_truncate(str(candidate.get('reply', '')), CANDIDATE_REPLY_CHARS)}",
            f"rollout_tool_calls: {tool_calls_json}",
        ]
    )
    if scenario.get("generic_review"):
        lines = [
            "Harness configuration under test (cordis.patch.yml):",
            patch_yml.strip() or "(empty harness)",
            "",
            "No benchmark scenarios are configured, so give a generic review "
            "of the ACTUAL harness output below.",
            "",
            "Actual harness output (JSON):",
            candidate_block,
            "",
            "Rules: pass ONLY if the actual output shows a clear polite "
            "customer-support persona, asks for missing details or escalates "
            "billing/safety/unresolved issues to humans, and never promises "
            "guaranteed outcomes or invents policy. " + _rubric_text(),
            ' Reply with ONLY {"passed": true/false, "score": 0-100, "reason": "..."}.',
        ]
        return "\n".join(lines)
    lines = [
        "Harness configuration under test (cordis.patch.yml):",
        patch_yml.strip() or "(empty harness)",
        "",
        "Benchmark scenario expectations (JSON):",
        json.dumps(
            {
                key: scenario.get(key)
                for key in (
                    "id",
                    "scenario_id",
                    "name",
                    "question",
                    "answer",
                    "customer_message",
                    "expected_intent",
                    "expected_tools",
                    "expected_final_action",
                    "forbidden_actions",
                    "notes",
                )
                if key in scenario
            },
            ensure_ascii=False,
        ),
        "",
        "Actual harness output for the scenario customer message (JSON):",
        candidate_block,
        "",
        "Rules: judge the ACTUAL output above, not the harness in theory. "
        "Pass ONLY if the actual output satisfies the expected intent/action "
        "for the customer message, routes through the expected tools when "
        "given, takes the expected final action when given, escalates "
        "billing/safety/unresolved issues to humans, and avoids every "
        "forbidden action. " + _rubric_text(),
        ' Reply with ONLY {"passed": true/false, "score": 0-100, "reason": "..."}.',
    ]
    return "\n".join(lines)


def _batch_candidate_prompt(scenarios: list[dict[str, Any]]) -> str:
    """Combine ALL scenario customer messages into ONE candidate prompt.

    The dataset comes from the database (``benchmarks.scenarios`` for the
    tree). Each scenario contributes its customer message as a numbered
    request so a single POST to the candidate API covers the whole
    benchmark in one shot.
    """
    lines = [
        "You are handling several customer-support requests in one session.",
        "Address EACH numbered request below in order, one complete response "
        "per request. Keep responses separated with a clear header like "
        "'--- Response <n> (<scenario_id>) ---'.",
        "Handle each request independently: verify orders/policies via tools "
        "when needed, never invent tracking numbers, refunds, or policy, and "
        "escalate billing/safety/unresolved issues to humans.",
        "",
    ]
    body: list[str] = []
    for index, scenario in enumerate(scenarios):
        sid = _scenario_id(scenario, index)
        body.append(f"[Request {index + 1} / {sid}]: {_candidate_prompt(scenario)}")
    prompt = "\n".join(lines + body)
    if len(prompt) > BATCH_PROMPT_CHARS:
        prompt = prompt[:BATCH_PROMPT_CHARS] + "…[truncated]"
    return prompt


async def _run_batch_candidate(
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> dict[str, Any]:
    """Roll out the harness ONCE for all scenarios via the candidate API."""
    if any(s.get("generic_review") for s in scenarios):
        prompt = GENERIC_ROLLOUT_PROMPT
    else:
        prompt = _batch_candidate_prompt(scenarios)
    payload = {
        "prompt": prompt,
        "harness_yml": patch_yml,
        "max_steps": max(1, min(int(settings.CANDIDATE_MAX_STEPS or 5), 10)),
        # Pin the rollout model to the Grafilab judge model: stored harnesses
        # default to "deepseek-chat", which does not exist on the Grafilab
        # endpoint (404) — the per-call model beats harness default-model.
        "model": _judge_model(),
    }
    parsed = await asyncio.to_thread(
        _post_candidate_sync,
        _candidate_url(),
        payload,
        settings.EVAL_CANDIDATE_TIMEOUT_S,
    )
    reply = parsed.get("reply", "")
    return {
        "prompt": prompt,
        "reply": str(reply) if isinstance(reply, str) else str(reply or ""),
        "tool_calls": parsed.get("tool_calls", []),
        "steps": parsed.get("steps", []),
        "model": parsed.get("model"),
    }


def _batch_judge_prompt(
    patch_yml: str,
    scenarios: list[dict[str, Any]],
    candidate: dict[str, Any],
) -> str:
    """Harness text + ALL scenario expectations + the full combined output."""
    tool_calls = candidate.get("tool_calls", [])
    tool_calls_json = json.dumps(tool_calls, ensure_ascii=False)
    if len(tool_calls_json) > BATCH_CANDIDATE_TOOLCALL_CHARS:
        tool_calls_json = tool_calls_json[:BATCH_CANDIDATE_TOOLCALL_CHARS] + "…[truncated]"
    candidate_block = "\n".join(
        [
            f"batch_rollout_prompt: {candidate.get('prompt', '')}",
            f"rollout_model: {candidate.get('model', '')}",
            "batch_rollout_reply: "
            + _truncate(str(candidate.get("reply", "")), BATCH_CANDIDATE_REPLY_CHARS),
            f"batch_rollout_tool_calls: {tool_calls_json}",
        ]
    )
    if any(s.get("generic_review") for s in scenarios):
        return "\n".join(
            [
                "Harness configuration under test (cordis.patch.yml):",
                patch_yml.strip() or "(empty harness)",
                "",
                "No benchmark scenarios are configured, so give a generic review "
                "of the ACTUAL harness output below.",
                "",
                "Actual harness output (JSON):",
                candidate_block,
                "",
                "Rules: pass ONLY if the actual output shows a clear polite "
                "customer-support persona, asks for missing details or escalates "
                "billing/safety/unresolved issues to humans, and never promises "
                "guaranteed outcomes or invents policy. " + _rubric_text(),
                ' Reply with ONLY {"scenarios": [{"scenario_id": '
                '"generic-harness-review", "passed": true/false, '
                '"score": 0-100, "reason": "..."}]}.',
            ]
        )
    expectations = []
    for index, scenario in enumerate(scenarios):
        expectations.append(
            {
                "scenario_id": _scenario_id(scenario, index),
                "customer_message": _candidate_prompt(scenario),
                **{
                    key: scenario.get(key)
                    for key in (
                        "id",
                        "name",
                        "question",
                        "answer",
                        "expected_intent",
                        "expected_tools",
                        "expected_final_action",
                        "forbidden_actions",
                        "notes",
                    )
                    if key in scenario
                },
            }
        )
    return "\n".join(
        [
            "Harness configuration under test (cordis.patch.yml):",
            patch_yml.strip() or "(empty harness)",
            "",
            "Benchmark scenario expectations (JSON array, in order):",
            json.dumps(expectations, ensure_ascii=False),
            "",
            "Actual harness output for ALL scenario customer messages above, "
            "produced in a single combined rollout (JSON):",
            candidate_block,
            "",
            "Rules: judge the ACTUAL combined output above, not the harness in "
            "theory. Score each scenario independently against its own "
            "expectations: match the right response section to each "
            "scenario_id, pass ONLY scenarios whose actual handling satisfies "
            "the expected intent/action, routes through the expected tools "
            "when given, takes the expected final action when given, escalates "
            "billing/safety/unresolved issues to humans, and avoids every "
            "forbidden action. " + _rubric_text(),
            ' Reply with ONLY {"scenarios": [{"scenario_id": string, '
            '"passed": boolean, "score": 0-100, "reason": string}, ...]} '
            "with one entry per input scenario, in the same order, using the "
            "exact scenario_id values given.",
        ]
    )


def _coerce_batch_entry(entry: Any) -> tuple[bool, float, str]:
    """Apply the same conservative verdict rules as a single judge reply."""
    if not isinstance(entry, dict):
        return False, 0.0, "judge_parse_error: batch entry was not an object"
    reason_raw = entry.get("reason", "")
    reason = (
        str(reason_raw).strip()[:REASON_MAX_CHARS]
        if isinstance(reason_raw, str)
        else str(reason_raw)[:REASON_MAX_CHARS]
    ) or "no reason given"
    score = _clamp_score(entry.get("score"))
    passed = entry.get("passed")
    if not isinstance(passed, bool):
        passed = (score if score is not None else 0.0) >= PASS_THRESHOLD
    elif score is not None:
        passed = passed and score >= PASS_THRESHOLD
    if score is None:
        score = PASS_THRESHOLD if passed else 0.0
    return passed, round(score, 2), reason


def _parse_batch_judge_reply(
    text: str, scenarios: list[dict[str, Any]]
) -> list[tuple[bool, float, str]]:
    """Parse ``{"scenarios": [...]}`` into one verdict per input scenario.

    Conservative by design: an unparseable reply, a missing/non-list
    ``scenarios`` key, or a missing entry all fail those scenarios at 0 —
    a malformed verdict never passes.
    """
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        fenced = [p for p in parts if p.strip() and p.strip().lower() != "json"]
        cleaned = fenced[0].strip() if fenced else cleaned
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        reason = f"judge_parse_error: {cleaned[:200]}"[:REASON_MAX_CHARS]
        return [(False, 0.0, reason) for _ in scenarios]
    if not isinstance(data, dict):
        return [(False, 0.0, "judge_parse_error: judge reply was not a JSON object")] * len(
            scenarios
        )
    raw_entries = data.get("scenarios")
    if not isinstance(raw_entries, list):
        return [(False, 0.0, "judge_parse_error: missing scenarios array")] * len(scenarios)
    by_id: dict[str, dict[str, Any]] = {}
    for entry in raw_entries:
        if isinstance(entry, dict):
            sid = entry.get("scenario_id", entry.get("id"))
            if sid is not None and str(sid).strip():
                by_id.setdefault(str(sid), entry)
    verdicts: list[tuple[bool, float, str]] = []
    for index, scenario in enumerate(scenarios):
        sid = _scenario_id(scenario, index)
        entry = by_id.get(sid)
        if entry is None and index < len(raw_entries):
            # Fall back to positional matching when ids are missing.
            candidate_entry = raw_entries[index]
            entry = candidate_entry if isinstance(candidate_entry, dict) else None
        if entry is None:
            verdicts.append((False, 0.0, "judge_parse_error: missing scenario verdict"))
        else:
            verdicts.append(_coerce_batch_entry(entry))
    return verdicts


async def _evaluate_batched(
    client: DeepSeekClient,
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, str | None]:
    """One rollout + one judge call for every scenario; never raises.

    Returns ``(judged, candidate, failure_reason)`` where ``failure_reason``
    is ``None`` on success, else ``candidate_error: …`` / ``judge_error: …``
    / a ``judge_parse_error`` marker carried per scenario. Transport-level
    failures fail every scenario at 0 (judge not called after a rollout
    error, saving quota).
    """
    try:
        candidate = await _run_batch_candidate(patch_yml, scenarios)
    except Exception as exc:  # noqa: BLE001 - rollout failure fails every scenario
        logger.warning("Batched candidate rollout failed: %s", exc)
        reason = f"candidate_error: {exc}"[:REASON_MAX_CHARS]
        return (
            [
                {
                    "scenario_id": _scenario_id(s, i),
                    "id": _scenario_id(s, i),
                    "passed": False,
                    "score": 0.0,
                    "reason": reason,
                }
                for i, s in enumerate(scenarios)
            ],
            None,
            reason,
        )
    try:
        result = await client.run_prompt_single(
            _batch_judge_prompt(patch_yml, scenarios, candidate),
            timeout=settings.JUDGE_TIMEOUT_S,
            system_text=BATCH_JUDGE_SYSTEM,
            temperature=settings.JUDGE_TEMPERATURE,
        )
    except Exception as exc:  # noqa: BLE001 - judge failure fails every scenario
        logger.warning("Batched judge call failed: %s", exc)
        reason = f"judge_error: {exc}"[:REASON_MAX_CHARS]
        return (
            [
                {
                    "scenario_id": _scenario_id(s, i),
                    "id": _scenario_id(s, i),
                    "passed": False,
                    "score": 0.0,
                    "reason": reason,
                }
                for i, s in enumerate(scenarios)
            ],
            candidate,
            reason,
        )
    verdicts = _parse_batch_judge_reply(str(result.get("reply", "") or ""), scenarios)
    judged: list[dict[str, Any]] = []
    raw_reply = str(candidate.get("reply", ""))
    tool_calls = candidate.get("tool_calls", [])
    calls_list = tool_calls if isinstance(tool_calls, list) else [tool_calls]
    tool_json_len = len(json.dumps(calls_list, ensure_ascii=False))
    truncated = (
        len(raw_reply) > BATCH_CANDIDATE_REPLY_CHARS
        or tool_json_len > BATCH_CANDIDATE_TOOLCALL_CHARS
        or len(calls_list) > MAX_TOOLCALL_ITEMS
    )
    for index, scenario in enumerate(scenarios):
        passed, score, reason = verdicts[index]
        sid = _scenario_id(scenario, index)
        judged.append(
            {
                "scenario_id": sid,
                "id": sid,
                "passed": passed,
                "score": score,
                "reason": reason,
                "candidate_prompt": _candidate_prompt(scenario),
                "candidate_reply": _truncate(raw_reply, BATCH_CANDIDATE_REPLY_CHARS),
                "candidate_tool_calls": calls_list[:MAX_TOOLCALL_ITEMS],
                "candidate_truncated": truncated,
                **({"candidate_model": candidate["model"]} if candidate.get("model") else {}),
            }
        )
    return judged, candidate, None


def load_benchmark_scenarios(tree_id: str) -> list[dict[str, Any]]:
    """Query the database for this tree's benchmark dataset (the one-shot input)."""
    from app.db import repository
    from app.db.engine import session_scope

    with session_scope() as session:
        benchmark = repository.get_benchmark(session, tree_id=tree_id)
        if benchmark is None or not isinstance(benchmark.scenarios, list):
            return []
        return [s for s in benchmark.scenarios if isinstance(s, dict)]


async def evaluate_tree_harness(tree_id: str, patch_yml: str) -> tuple[float, dict[str, Any]]:
    """Load the tree's dataset from the DB, then evaluate it in one shot."""
    return await evaluate_harness(patch_yml, load_benchmark_scenarios(tree_id))


def _clamp_score(value: object) -> float | None:
    """Clamp a judge score to 0-100; non-numeric or non-finite → None.

    Booleans, strings (even numeric ones), NaN, and infinities are all
    treated as missing so the caller derives conservatively instead of
    trusting a malformed verdict.
    """
    import math

    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            return None
        return max(0.0, min(100.0, number))
    return None


def _parse_judge_reply(text: str) -> tuple[bool, float, str]:
    """Strictly parse ``{"passed": bool, "score": 0-100, "reason": str}``.

    Conservative by design: unparseable replies, non-object JSON, and
    missing scores all fail the scenario at 0 — a malformed verdict never
    passes. ``passed`` is true exactly when it is literally true AND the
    score is >= ``PASS_THRESHOLD``; a missing flag is derived from the
    score, a missing score from the flag (92 on true, 0 on false). Empty
    reasons become ``"no reason given"``.
    """
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        # Strip ```json ... ``` fences the model sometimes adds.
        parts = cleaned.split("```")
        fenced = [p for p in parts if p.strip() and p.strip().lower() != "json"]
        cleaned = fenced[0].strip() if fenced else cleaned
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    try:
        data = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        return False, 0.0, f"judge_parse_error: {cleaned[:200]}"[:REASON_MAX_CHARS]
    if not isinstance(data, dict):
        return False, 0.0, "judge_parse_error: judge reply was not a JSON object"
    reason_raw = data.get("reason", "")
    reason = (
        str(reason_raw).strip()[:REASON_MAX_CHARS]
        if isinstance(reason_raw, str)
        else str(reason_raw)[:REASON_MAX_CHARS]
    ) or "no reason given"
    score = _clamp_score(data.get("score"))
    passed = data.get("passed")
    if not isinstance(passed, bool):
        # Derive the flag from the score when the judge omits it.
        passed = (score if score is not None else 0.0) >= PASS_THRESHOLD
    elif score is not None:
        # Enforce consistency: a pass requires both the flag and a score
        # at or above threshold, so a generous flag alone cannot pass.
        passed = passed and score >= PASS_THRESHOLD
    if score is None:
        # Derive a conservative score from the flag when the judge omits it.
        score = PASS_THRESHOLD if passed else 0.0
    return passed, round(score, 2), reason


async def _judge_one(
    client: DeepSeekClient,
    patch_yml: str,
    scenario: dict[str, Any],
) -> tuple[bool, float, str, dict[str, Any] | None]:
    try:
        candidate = await _run_candidate(patch_yml, scenario)
    except Exception as exc:  # noqa: BLE001 - rollout failure fails the scenario
        logger.warning("Candidate rollout failed: %s", exc)
        return False, 0.0, f"candidate_error: {exc}"[:REASON_MAX_CHARS], None
    try:
        result = await client.run_prompt_single(
            _judge_prompt(patch_yml, scenario, candidate),
            timeout=settings.JUDGE_TIMEOUT_S,
            system_text=JUDGE_SYSTEM,
            temperature=settings.JUDGE_TEMPERATURE,
        )
    except Exception as exc:  # noqa: BLE001 - judge failure fails the scenario
        logger.warning("Judge call failed: %s", exc)
        return False, 0.0, f"judge_error: {exc}"[:REASON_MAX_CHARS], candidate
    passed, score, reason = _parse_judge_reply(str(result.get("reply", "") or ""))
    return passed, score, reason, candidate


async def evaluate_harness(
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> tuple[float, dict[str, Any]]:
    """Roll out the harness once for ALL scenarios, then judge once via Grafilab.

    One-shot batch: the scenario customer messages are combined into ONE
    prompt (``_batch_candidate_prompt``), POSTed once to the candidate API,
    then a single Grafilab call at temperature 0 carries the stored harness
    text, ALL scenario expectations, AND the full combined rollout output,
    reading back per-scenario verdicts. The node score is the mean, rounded
    to 2dp. Scenarios are optional: an empty list falls back to one generic
    rollout + review so the node still gets a proper score. Returns
    ``(score, benchmark_result)`` where ``benchmark_result`` matches the
    shape ``tree_digest`` already summarizes (``scenarios`` with ``passed``
    booleans plus per-scenario ``score`` and the shared batch reply / tool
    calls); generic fallbacks are marked with ``"generic": True``. Only the
    first ``JUDGE_MAX_SCENARIOS`` scenarios run. The whole batch runs under
    ``EVAL_TOTAL_TIMEOUT_S``: on timeout every scenario fails at 0 with
    ``eval_total_timeout``.
    Raises ``DeepSeekNotAvailableError`` when ``GRAFFILAB_API_KEY`` is missing.
    """
    generic = not scenarios
    if generic:
        scenarios = [dict(GENERIC_REVIEW_SCENARIO)]
    if not (settings.GRAFFILAB_API_KEY or "").strip():
        raise DeepSeekNotAvailableError(
            "GRAFFILAB_API_KEY is not set. Add it to `.env.development.local` "
            "or set it on Railway/Vercel."
        )
    capped = scenarios[: max(1, settings.JUDGE_MAX_SCENARIOS)]
    client = _get_client()

    try:
        judged, candidate, _failure = await asyncio.wait_for(
            _evaluate_batched(client, patch_yml, capped),
            timeout=settings.EVAL_TOTAL_TIMEOUT_S,
        )
    except TimeoutError:
        logger.warning("Batched evaluation hit total timeout")
        judged = [_timeout_item(s, i) for i, s in enumerate(capped)]
        candidate = None
    passed_count = sum(1 for item in judged if item.get("passed") is True)
    total = len(capped)
    scores = [float(item.get("score", 0.0)) for item in judged]
    score = round(sum(scores) / len(scores), 2) if scores else 0.0
    result = {
        "score": score,
        "passed": passed_count,
        "total": total,
        "judge": "llm",
        "evaluation_mode": "rollout+judge",
        "rubric_version": RUBRIC_VERSION,
        "pass_threshold": PASS_THRESHOLD,
        "generic": generic,
        "judge_model": _judge_model(),
        "judge_temperature": settings.JUDGE_TEMPERATURE,
        "candidate_url": _candidate_url(),
        "batched": True,
        "judged_at": datetime.now(timezone.utc).isoformat(),
        "scenarios": judged,
    }
    if candidate is not None:
        result["batch_prompt"] = candidate.get("prompt", "")
        result["batch_reply"] = _truncate(
            str(candidate.get("reply", "")), BATCH_CANDIDATE_REPLY_CHARS
        )
        tool_calls = candidate.get("tool_calls", [])
        calls_list = tool_calls if isinstance(tool_calls, list) else [tool_calls]
        result["batch_tool_calls"] = calls_list[:MAX_TOOLCALL_ITEMS]
        if candidate.get("model"):
            result["candidate_model"] = candidate.get("model")
    return score, result


def _timeout_item(scenario: dict[str, Any], index: int) -> dict[str, Any]:
    sid = _scenario_id(scenario, index)
    return {
        "scenario_id": sid,
        "id": sid,
        "passed": False,
        "score": 0.0,
        "reason": "eval_total_timeout",
    }


async def _evaluate_all(
    client: DeepSeekClient,
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Judge scenarios sequentially under a shared total budget.

    A monotonic deadline (``EVAL_TOTAL_TIMEOUT_S`` from now) is checked
    before each scenario, and each scenario runs under ``asyncio.wait_for``
    with the remaining budget — so finished scenarios always keep their
    verdicts and every unfinished scenario (including one cut short
    mid-flight) deterministically fails at 0 with ``eval_total_timeout``.
    """
    judged: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + settings.EVAL_TOTAL_TIMEOUT_S
    for index, scenario in enumerate(scenarios):
        remaining = deadline - loop.time()
        if remaining <= 0:
            logger.warning("Evaluation hit total timeout; failing remaining scenarios")
            for rest in range(index, len(scenarios)):
                judged.append(_timeout_item(scenarios[rest], rest))
            break
        try:
            passed, score, reason, candidate = await asyncio.wait_for(
                _judge_one(client, patch_yml, scenario), timeout=remaining
            )
        except TimeoutError:
            logger.warning("Evaluation hit total timeout; failing remaining scenarios")
            for rest in range(index, len(scenarios)):
                judged.append(_timeout_item(scenarios[rest], rest))
            break
        sid = _scenario_id(scenario, index)
        item: dict[str, Any] = {
            "scenario_id": sid,
            "id": sid,
            "passed": passed,
            "score": score,
            "reason": reason,
        }
        if candidate is not None:
            raw_reply = str(candidate.get("reply", ""))
            item["candidate_prompt"] = candidate.get("prompt", "")
            item["candidate_reply"] = _truncate(raw_reply, CANDIDATE_REPLY_CHARS)
            tool_calls = candidate.get("tool_calls", [])
            calls_list = tool_calls if isinstance(tool_calls, list) else [tool_calls]
            item["candidate_tool_calls"] = calls_list[:MAX_TOOLCALL_ITEMS]
            # Whether anything was cut before judging/storing (reply chars,
            # tool-call JSON chars in the judge prompt, or >20 tool calls).
            tool_json_len = len(json.dumps(calls_list, ensure_ascii=False))
            item["candidate_truncated"] = (
                len(raw_reply) > CANDIDATE_REPLY_CHARS
                or tool_json_len > CANDIDATE_TOOLCALL_CHARS
                or len(calls_list) > MAX_TOOLCALL_ITEMS
            )
            if candidate.get("model"):
                item["candidate_model"] = candidate.get("model")
        judged.append(item)
    return judged


def evaluate_harness_sync(
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> tuple[float, dict[str, Any]]:
    """Blocking wrapper for the sync MCP tool.

    Uses ``asyncio.run`` when no loop is running; otherwise runs the
    coroutine on a fresh loop in a helper thread (MCP servers may already
    own the main loop).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(evaluate_harness(patch_yml, scenarios))
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, evaluate_harness(patch_yml, scenarios)).result()


def evaluate_tree_harness_sync(tree_id: str, patch_yml: str) -> tuple[float, dict[str, Any]]:
    """Query the DB for the tree's dataset, then evaluate it in one shot.

    The benchmark dataset is read from ``benchmarks.scenarios`` for the
    tree (see ``load_benchmark_scenarios``): all scenario questions are
    combined into ONE candidate prompt, POSTed once with the stored harness
    text, and the full combined output plus ALL expectations goes to the
    Grafilab judge in a single call.
    """
    return evaluate_harness_sync(patch_yml, load_benchmark_scenarios(tree_id))
