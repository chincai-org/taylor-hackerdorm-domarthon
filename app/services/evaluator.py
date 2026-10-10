"""Direct Grafilab LLM-judge evaluation for new harness nodes.

Flow per new node (called right after the node is inserted as ``pending``):

For each benchmark scenario, make one direct Grafilab API call
(temperature 0) whose prompt carries the stored harness text plus the
scenario expectations, and read back a JSON verdict
``{"passed": boolean, "score": 0-100, "reason": string}``. No harness resolution, no agent
tool loop — just the API returning JSON.

Score = mean of the per-scenario 0-100 scores; per-scenario detail is kept so
``checkout_tree`` can show ``failed_scenarios`` without extra work.
Network failures degrade to per-scenario ``passed=False`` with a reason —
the node still completes with a proper score instead of getting stuck in
``running``.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.services.deepseek_client import DeepSeekClient, DeepSeekNotAvailableError

logger = logging.getLogger(__name__)

JUDGE_SYSTEM = (
    "You are a harsh, deterministic customer-support benchmark judge. "
    "You receive a harness configuration and one benchmark scenario. "
    "Decide whether the harness would handle the scenario correctly and "
    "score it from 0 to 100: 97-100 flawless with zero gaps, 85-96 "
    "satisfies with only trivial gaps, 60-84 partially satisfies, 0-59 fails. "
    "Be strict: award 100 only for perfect, production-grade handling. "
    "Any forbidden action caps the score at 20 and fails. "
    "Wrong final action caps at 59. Missing an expected tool caps at 79. "
    "Invented policy or guaranteed outcomes cap at 39. "
    "Missing escalation for billing/safety/unresolved issues caps at 79. "
    "Mark passed true exactly when the score is 85 or higher. "
    "When in doubt, score lower. "
    "Return ONLY a JSON object with exactly three keys: "
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
        "harness in general instead of against a specific customer message."
    ),
}


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


def _scenario_id(scenario: dict[str, Any], index: int) -> str:
    for key in ("scenario_id", "id", "name"):
        value = scenario.get(key)
        if value is not None and str(value).strip():
            return str(value)
    return f"scenario-{index + 1}"


def _judge_prompt(patch_yml: str, scenario: dict[str, Any]) -> str:
    """Harness text + scenario expectations, demanding a JSON verdict."""
    if scenario.get("generic_review"):
        lines = [
            "Harness configuration under review (cordis.patch.yml):",
            patch_yml.strip() or "(empty harness)",
            "",
            "No benchmark scenarios are configured, so give a generic review "
            "of this customer-support harness.",
            "",
            "Rules: pass ONLY if the harness defines a clear polite "
            "customer-support persona, asks for missing details or escalates "
            "billing/safety/unresolved issues to humans, and never promises "
            "guaranteed outcomes or invents policy. "
            "Be harsh: 97-100 flawless only, 85-96 trivial gaps only, 60-84 "
            "partial, 0-59 failing. Missing escalation caps at 79, invented "
            "policy or guaranteed outcomes cap at 39. "
            "Score it 0-100 with passed true exactly when the score is 85 or "
            "higher; when in doubt score lower. "
            'Reply with ONLY {"passed": true/false, "score": 0-100, "reason": "..."}.',
        ]
        return "\n".join(lines)
    lines = [
        "Harness configuration under review (cordis.patch.yml):",
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
        "Rules: pass ONLY if the harness would satisfy the expected "
        "intent/action for the customer message, route through the expected "
        "tools when given, take the expected final action when given, and "
        "avoid every forbidden action. "
        "Be harsh: 97-100 flawless only, 85-96 trivial gaps only, 60-84 "
        "partial, 0-59 failing. Any forbidden action caps at 20 and fails. "
        "Wrong final action caps at 59. Missing an expected tool caps at 79. "
        "Invented policy or guaranteed outcomes cap at 39. "
        "Score it 0-100 with passed true exactly when the score is 85 or "
        "higher; when in doubt score lower. "
        'Reply with ONLY {"passed": true/false, "score": 0-100, "reason": "..."}.',
    ]
    return "\n".join(lines)


PASS_THRESHOLD = 85.0


def _clamp_score(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return max(0.0, min(100.0, float(value)))
    return None


def _parse_judge_reply(text: str) -> tuple[bool, float, str]:
    """Leniently parse ``{"passed": bool, "score": 0-100, "reason": str}``."""
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
        # Fall back to keyword scan so one malformed judge reply does not
        # fail the whole node evaluation. Conservative: never award more
        # than the pass threshold on unparseable replies.
        lowered = cleaned.lower()
        if '"passed": true' in lowered or '"passed":true' in lowered:
            return True, PASS_THRESHOLD, cleaned[:500] or "judge keyword fallback: passed"
        return False, 0.0, (cleaned[:500] or "judge_parse_error: empty judge reply")
    if not isinstance(data, dict):
        return False, 0.0, "judge_parse_error: judge reply was not a JSON object"
    reason_raw = data.get("reason", "")
    reason = str(reason_raw)[:500] if isinstance(reason_raw, str) else str(reason_raw)[:500]
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
    return passed, score, reason


async def _judge_one(
    client: DeepSeekClient,
    patch_yml: str,
    scenario: dict[str, Any],
) -> tuple[bool, float, str]:
    try:
        result = await client.run_prompt_single(
            _judge_prompt(patch_yml, scenario),
            timeout=settings.JUDGE_TIMEOUT_S,
            system_text=JUDGE_SYSTEM,
            temperature=0,
        )
    except Exception as exc:  # noqa: BLE001 - judge failure fails the scenario
        logger.warning("Judge call failed: %s", exc)
        return False, 0.0, f"judge_error: {exc}"[:500]
    return _parse_judge_reply(str(result.get("reply", "") or ""))


async def evaluate_harness(
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> tuple[float, dict[str, Any]]:
    """Judge the harness against every scenario via direct Grafilab calls.

    Each scenario gets one 0-100 score from the judge; the node score is the
    mean. Scenarios are optional: an empty list falls back to one generic
    harness review so the node still gets a proper score. Returns ``(score,
    benchmark_result)`` where ``benchmark_result`` matches the shape
    ``tree_digest`` already summarizes (``scenarios`` with ``passed``
    booleans plus per-scenario ``score``); generic fallbacks are marked with
    ``"generic": True``. Raises ``DeepSeekNotAvailableError`` when
    ``GRAFFILAB_API_KEY`` is missing.
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

    judged: list[dict[str, Any]] = []
    passed_count = 0
    try:
        judged = await asyncio.wait_for(
            _evaluate_all(client, patch_yml, capped),
            timeout=settings.EVAL_TOTAL_TIMEOUT_S,
        )
    except TimeoutError:
        # Total cap hit: keep whatever finished, fail the rest.
        logger.warning("Evaluation hit total timeout; failing remaining scenarios")
        seen = len(judged)
        for i in range(seen, len(capped)):
            sid = _scenario_id(capped[i], i)
            judged.append(
                {
                    "scenario_id": sid,
                    "id": sid,
                    "passed": False,
                    "score": 0.0,
                    "reason": "eval_total_timeout",
                }
            )
    for item in judged:
        if item.get("passed") is True:
            passed_count += 1
    total = len(capped)
    scores = [float(item.get("score", 0.0)) for item in judged]
    score = round(sum(scores) / len(scores), 2) if scores else 0.0
    result = {
        "score": score,
        "passed": passed_count,
        "total": total,
        "judge": "llm",
        "generic": generic,
        "judge_model": _judge_model(),
        "judged_at": datetime.now(timezone.utc).isoformat(),
        "scenarios": judged,
    }
    return score, result


async def _evaluate_all(
    client: DeepSeekClient,
    patch_yml: str,
    scenarios: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    judged: list[dict[str, Any]] = []
    for index, scenario in enumerate(scenarios):
        sid = _scenario_id(scenario, index)
        passed, score, reason = await _judge_one(client, patch_yml, scenario)
        judged.append(
            {"scenario_id": sid, "id": sid, "passed": passed, "score": score, "reason": reason}
        )
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
