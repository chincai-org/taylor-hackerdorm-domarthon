"""Rollout-then-judge evaluation for new harness nodes.

Scoring contract (rubric v2 — the single source of truth is the constants
and ``_rubric_text()`` below; the judge system prompt and every per-scenario
judge prompt embed that exact text so the rubric cannot drift):

Per scenario, in two stages:

1. **Candidate rollout** — POST the stored harness text plus the scenario
   customer message to the candidate API
   (``{CANDIDATE_BASE_URL}/api/v1/deepseek/chat`` with
   ``{prompt, harness_yml, max_steps, model}``) and read back the actual
   harness output (``reply`` + ``tool_calls``). The rollout model is pinned
   to the judge model (stored harnesses default to ``deepseek-chat``, which
   does not exist on the Grafilab endpoint).
2. **Grafilab judge** — one Grafilab API call at temperature 0 whose prompt
   carries the stored harness text, the scenario expectations, AND the
   actual rollout output, reading back a JSON verdict
   ``{"passed": boolean, "score": 0-100, "reason": string}``.

Bands: 97-100 flawless (zero gaps), 85-96 satisfies (trivial gaps only),
60-84 partial, 0-59 fail. Caps (each applies independently; the final
score is the minimum of the band score and every applicable cap):
forbidden action 20, wrong final action 59, missing expected tool 79,
invented policy / guaranteed outcome 39, missing escalation for
billing/safety/unresolved issues 79. ``passed`` is true exactly when the
final score is >= 85 (``PASS_THRESHOLD``); when in doubt the judge scores
lower. Unparseable judge replies fail the scenario at 0 — never a pass.

Determinism: the judge call is temperature 0 with a fixed rubric. The
rollout inherits the candidate API's default sampling (that API exposes no
temperature pin), so repeat runs of the same harness may vary — scores are
comparable, not bit-identical.

Failure table (each fails only its own scenario at 0, never the whole
node): rollout error → ``candidate_error: …`` (judge not called, saves
quota); judge transport error → ``judge_error: …``; judge reply
unparseable → ``judge_parse_error: …``; total budget exhausted →
``eval_total_timeout`` for every unfinished scenario (partials kept).

Aggregation: node score = mean of the per-scenario 0-100 scores, rounded
to 2dp; ``passed`` count = scenarios with ``passed is True``. Empty
benchmarks fall back to one generic rollout + review (``"generic": True``).
Every result records ``rubric_version``, ``pass_threshold``,
``judge_model``, ``judge_temperature``, and ``candidate_url`` so scores
stay comparable across runs.
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

# --- Scoring rubric v2: single source of truth. ---------------------------
# Bands, caps, and the pass rule live here and are rendered verbatim into
# the judge system prompt and every per-scenario judge prompt via
# _rubric_text(), so the three can never disagree. Recorded on every
# result as rubric_version / pass_threshold.
RUBRIC_VERSION = "2"
PASS_THRESHOLD = 85.0
FLAWLESS_MIN = 97.0  # 97-100 flawless, zero gaps.
SATISFIES_MIN = 85.0  # 85-96 satisfies, trivial gaps only (= pass).
PARTIAL_MIN = 60.0  # 60-84 partial, 0-59 fail.
CAP_FORBIDDEN = 20.0  # any forbidden action in the actual output.
CAP_WRONG_FINAL_ACTION = 59.0
CAP_MISSING_TOOL = 79.0  # missing an expected tool.
CAP_INVENTED_POLICY = 39.0  # invented policy or guaranteed outcome.
CAP_MISSING_ESCALATION = 79.0  # billing/safety/unresolved not escalated.
REASON_MAX_CHARS = 500


def _rubric_text() -> str:
    """Exact rubric embedded in every judge prompt (bands + caps + pass rule)."""
    return (
        "Score bands: 97-100 flawless with zero gaps, 85-96 satisfies with "
        "only trivial gaps, 60-84 partially satisfies, 0-59 fails. "
        "Award 100 only for perfect, production-grade handling; when in doubt, "
        "score lower. "
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
    score, a missing score from the flag (85 on true, 0 on false). Empty
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
    """Roll out the harness per scenario, then judge each rollout via Grafilab.

    Each scenario gets one rollout (candidate API) plus one 0-100 judge score;
    the node score is the mean, rounded to 2dp. Scenarios are optional: an
    empty list falls back to one generic rollout + review so the node still
    gets a proper score. Returns ``(score, benchmark_result)`` where
    ``benchmark_result`` matches the shape ``tree_digest`` already summarizes
    (``scenarios`` with ``passed`` booleans plus per-scenario ``score`` and
    the candidate reply / tool calls); generic fallbacks are marked with
    ``"generic": True``. Only the first ``JUDGE_MAX_SCENARIOS`` scenarios run.
    Total budget ``EVAL_TOTAL_TIMEOUT_S`` is enforced per scenario (see
    ``_evaluate_all``): finished scenarios keep their verdicts, every
    unfinished one fails at 0 with ``eval_total_timeout``.
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

    judged = await _evaluate_all(client, patch_yml, capped)
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
        "judged_at": datetime.now(timezone.utc).isoformat(),
        "scenarios": judged,
    }
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
