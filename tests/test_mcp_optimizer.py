from __future__ import annotations

import asyncio
import inspect
import os
from contextlib import contextmanager
from typing import Iterator

os.environ.setdefault("DATABASE_URL", "sqlite://")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import mcp_server
from app.api.routes.deepseek import ChatRequest, _resolve
from app.db.models import Base, Benchmark, Node, Tree
from app.harness.dsh import to_cordis_patch_yml

VALID_PATCH_YML = """- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a careful customer support agent.
"""

VALID_HARNESS = {
    "version": 1,
    "kind": "dsh-default",
    "profile": "headless",
    "system_prompt": "You are a careful customer support agent.",
    "model": {"provider": "deepseek-official", "model": "deepseek-chat"},
    "dsh_plugins": [
        {
            "id": "persona",
            "name": "@deepseek-ai/dsh-persona",
            "config": {"prefix": "You are a careful customer support agent."},
        }
    ],
}


def _session_factory() -> tuple[sessionmaker[Session], object]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False), engine


def _seed(session: Session, *, root_status: str = "complete") -> None:
    session.add(Benchmark(id="benchmark-1", name="support", scenarios=[{"id": "login"}]))
    session.add(
        Tree(
            id="tree-1",
            name="DeepSeek support",
            description="Optimizer demo",
            benchmark_id="benchmark-1",
            root_node_id="root-1",
        )
    )
    session.add(
        Node(
            id="root-1",
            tree_id="tree-1",
            harness=VALID_PATCH_YML,
            status=root_status,
            score=42.0 if root_status == "complete" else None,
            benchmark_result={"scenarios": []} if root_status == "complete" else None,
            rationale="Baseline",
        )
    )
    session.commit()


def _patch_mcp_scope(monkeypatch, factory: sessionmaker[Session]) -> None:
    @contextmanager
    def scope() -> Iterator[Session]:
        session = factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    monkeypatch.setattr(mcp_server, "session_scope", scope)


def test_list_and_checkout_return_database_tree(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    listing = mcp_server.list_trees()
    assert listing["total"] == 1
    assert listing["trees"][0]["tree_id"] == "tree-1"
    assert listing["trees"][0]["node_count"] == 1
    assert "checkout_tree(tree_id)" in listing["next_step"]
    assert listing["workflow"][0].startswith("Choose tree_id")

    digest = mcp_server.checkout_tree("tree-1")
    assert digest["tree"]["name"] == "DeepSeek support"
    assert digest["stats"]["total_nodes"] == 1
    assert digest["nodes"][0]["position"] == "n000"
    assert "@deepseek-ai/dsh-persona" in digest["nodes"][0]["harness"]
    assert "customer support agent" in digest["nodes"][0]["harness"]
    assert digest["digest_hash"]
    assert "DEEPSEEK HARNESS TREE DIGEST" in digest["digest_text"]
    assert "harness=text chars=" in digest["digest_text"]
    assert "parent_id_rule" in digest["workflow"]
    assert "nodes[].id" in digest["workflow"]["parent_id_rule"]


def test_mcp_contract_requires_parent_relative_suggestions() -> None:
    signature = inspect.signature(mcp_server.create_child_node)
    assert list(signature.parameters) == [
        "tree_id",
        "parent_id",
        "parent_revision",
        "suggested_changes",
        "rationale",
    ]

    tools = asyncio.run(mcp_server.mcp_server.list_tools())
    create_tool = next(tool for tool in tools if tool.name == "create_child_node")
    get_tool = next(tool for tool in tools if tool.name == "get_node")
    properties = create_tool.input_schema["properties"]
    assert set(properties) == {
        "tree_id",
        "parent_id",
        "parent_revision",
        "suggested_changes",
        "rationale",
    }
    assert "harness" not in properties
    assert "harness_yml" not in properties
    assert "parent-relative" in (create_tool.description or "")
    assert "node ID" in (get_tool.description or "")


def test_get_node_returns_exact_parent_content(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    result = mcp_server.get_node("tree-1", "root-1")

    assert result["node_id"] == "root-1"
    assert result["harness"] == VALID_PATCH_YML
    assert result["parent_revision"].startswith("sha256:")
    assert len(result["parent_revision"]) == len("sha256:") + 64
    assert result["children"] == []
    assert "suggested_changes" in result["next_step"]


def test_create_child_scores_via_llm_judge(monkeypatch) -> None:
    import app.services.evaluator as evaluator

    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    parent = mcp_server.get_node("tree-1", "root-1")
    seen: dict[str, object] = {}

    def fake_evaluate(patch_yml: str, scenarios: list) -> tuple[float, dict]:
        seen["patch_yml"] = patch_yml
        seen["scenarios"] = scenarios
        result = {
            "score": 62.5,
            "passed": 1,
            "total": 2,
            "judge": "llm",
            "judge_model": "test-judge",
            "scenarios": [
                {"scenario_id": "a", "id": "a", "passed": True, "score": 85.0, "reason": "ok"},
                {
                    "scenario_id": "b",
                    "id": "b",
                    "passed": False,
                    "score": 40.0,
                    "reason": "missing refund",
                },
            ],
        }
        return 62.5, result

    monkeypatch.setattr(evaluator, "evaluate_harness_sync", fake_evaluate)

    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        parent_revision=parent["parent_revision"],
        suggested_changes={
            "plugins": [
                {"id": "persona", "config": {"prefix": "You are an empathetic support agent."}}
            ]
        },
        rationale="Adds an empathetic persona prefix.",
    )

    assert result["status"] == "complete"
    assert result["score"] == 62.5
    assert result["evaluation"]["status"] == "complete"
    assert result["evaluation"]["score"] == 62.5
    assert result["evaluation"]["passed"] == 1
    assert result["evaluation"]["total"] == 2
    assert result["evaluation"]["failed_scenarios"] == ["b"]
    assert 1 <= result["change_lines"] <= 120
    assert result["harness_source"] == "yml"
    assert "empathetic support agent" in result["patch_yml"]
    assert result["diff"]["changed"]["persona"]["prefix"]["from"] == (
        "You are a careful customer support agent."
    )
    assert "empathetic support agent" in seen.get("patch_yml", "")
    assert isinstance(seen.get("scenarios"), list)
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.parent_id == "root-1"
        assert child.harness == result["patch_yml"]
        assert child.status == "complete"
        assert child.score == 62.5
        assert child.benchmark_result is not None
        assert child.benchmark_result["passed"] == 1


def test_create_child_empty_benchmark_still_scores_via_generic_review(monkeypatch) -> None:
    import app.services.evaluator as evaluator

    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
        benchmark = session.get(Benchmark, "benchmark-1")
        assert benchmark is not None
        benchmark.scenarios = []
        session.commit()
    _patch_mcp_scope(monkeypatch, factory)

    seen: dict[str, object] = {}

    def fake_evaluate(patch_yml: str, scenarios: list) -> tuple[float, dict]:
        seen["scenarios"] = scenarios
        result = {
            "score": 100.0,
            "passed": 1,
            "total": 1,
            "judge": "llm",
            "generic": True,
            "judge_model": "test-judge",
            "scenarios": [
                {
                    "scenario_id": "generic-harness-review",
                    "id": "generic-harness-review",
                    "passed": True,
                    "score": 100.0,
                    "reason": "solid persona",
                },
            ],
        }
        return 100.0, result

    monkeypatch.setattr(evaluator, "evaluate_harness_sync", fake_evaluate)

    parent = mcp_server.get_node("tree-1", "root-1")
    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        parent_revision=parent["parent_revision"],
        suggested_changes={
            "plugins": [{"id": "persona", "config": {"prefix": "You are a kind support agent."}}]
        },
        rationale="No benchmark configured.",
    )

    assert seen["scenarios"] == []
    assert result["status"] == "complete"
    assert result["score"] == 100.0
    assert result["evaluation"]["status"] == "complete"
    assert result["evaluation"]["generic"] is True
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.status == "complete"
        assert child.score == 100.0
        assert child.benchmark_result is not None
        assert child.benchmark_result["generic"] is True


def test_create_child_judge_error_marks_failed(monkeypatch) -> None:
    import app.services.evaluator as evaluator

    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    def _fail(_patch_yml: str, _scenarios: list) -> tuple[float, dict]:
        raise RuntimeError("judge exploded")

    monkeypatch.setattr(evaluator, "evaluate_harness_sync", _fail)

    parent = mcp_server.get_node("tree-1", "root-1")
    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        parent_revision=parent["parent_revision"],
        suggested_changes={
            "plugins": [{"id": "persona", "config": {"prefix": "You are a kind support agent."}}]
        },
    )

    assert result["status"] == "failed"
    assert result["evaluation"]["status"] == "failed"
    assert "judge exploded" in result["evaluation"]["reason"]
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.status == "failed"
        assert child.score is None
        assert child.error is not None
        assert child.error["code"] == "RuntimeError"


def test_judge_reply_parsing() -> None:
    from app.services.evaluator import _parse_judge_reply

    passed, score, reason = _parse_judge_reply(
        '{"passed": true, "score": 85, "reason": "polite refund"}'
    )
    assert passed is True
    assert score == 85.0
    assert reason == "polite refund"

    passed, score, _ = _parse_judge_reply(
        '```json\n{"passed": false, "score": 30, "reason": "nope"}\n```'
    )
    assert passed is False
    assert score == 30.0

    # Scores clamp into 0-100.
    _, high, _ = _parse_judge_reply('{"passed": true, "score": 150, "reason": "x"}')
    assert high == 100.0
    _, low, _ = _parse_judge_reply('{"passed": false, "score": -5, "reason": "x"}')
    assert low == 0.0

    # Inconsistent flag+score: pass requires both (hard rubric).
    inconsistent_pass, _, _ = _parse_judge_reply('{"passed": true, "score": 80, "reason": "x"}')
    assert inconsistent_pass is False

    # Missing fields derive conservatively (pass threshold 85).
    derived_pass, derived_score, _ = _parse_judge_reply('{"score": 70, "reason": "x"}')
    assert derived_pass is False
    assert derived_score == 70.0
    derived_pass, derived_score, _ = _parse_judge_reply('{"score": 90, "reason": "x"}')
    assert derived_pass is True
    assert derived_score == 90.0
    _, fallback_score, _ = _parse_judge_reply('{"passed": false, "reason": "x"}')
    assert fallback_score == 0.0
    _, fallback_pass_score, _ = _parse_judge_reply('{"passed": true, "reason": "x"}')
    assert fallback_pass_score == 85.0

    passed, score, reason = _parse_judge_reply("not json at all")
    assert passed is False
    assert score == 0.0
    assert reason

    # Airtight: a truncated reply containing '"passed": true' never passes.
    passed, score, reason = _parse_judge_reply('{"passed": true, "score": 9')
    assert passed is False
    assert score == 0.0
    assert reason.startswith("judge_parse_error")

    # Non-finite scores are treated as missing (derived conservatively).
    passed, score, _ = _parse_judge_reply('{"passed": true, "score": NaN, "reason": "x"}')
    assert passed is True
    assert score == 85.0
    passed, score, _ = _parse_judge_reply('{"passed": false, "score": Infinity, "reason": "x"}')
    assert passed is False
    assert score == 0.0

    # Boolean and string scores are not numbers → treated as missing.
    _, score, _ = _parse_judge_reply('{"passed": true, "score": true, "reason": "x"}')
    assert score == 85.0
    _, score, _ = _parse_judge_reply('{"passed": false, "score": "90", "reason": "x"}')
    assert score == 0.0

    # Empty reasons default instead of staying silent.
    _, _, empty_reason = _parse_judge_reply('{"passed": false, "score": 10, "reason": "  "}')
    assert empty_reason == "no reason given"


def test_rubric_is_single_sourced_across_prompts() -> None:
    from app.services import evaluator as evaluator

    candidate = {
        "prompt": "Hi",
        "reply": "Hello, how can I help?",
        "tool_calls": [],
        "model": "m",
    }
    scenario_prompt = evaluator._judge_prompt(
        "- id: persona",
        {"id": "a", "customer_message": "Hi", "forbidden_actions": ["x"]},
        candidate,
    )
    generic_prompt = evaluator._judge_prompt(
        "- id: persona", dict(evaluator.GENERIC_REVIEW_SCENARIO), candidate
    )
    rubric = evaluator._rubric_text()
    # System prompt and both branches embed the exact same rubric text.
    assert rubric in evaluator.JUDGE_SYSTEM
    assert rubric in scenario_prompt
    assert rubric in generic_prompt
    # Every cap is visible to the judge in both branches (escalation was
    # previously missing from the scenario branch).
    for cap in ("20", "59", "79", "39"):
        assert cap in scenario_prompt
        assert cap in generic_prompt
    assert "minimum" in rubric
    assert evaluator.RUBRIC_VERSION == "2"
    assert evaluator.PASS_THRESHOLD == 85.0


def test_total_timeout_keeps_finished_verdicts(monkeypatch) -> None:
    import asyncio

    import app.services.evaluator as evaluator
    from app.core import config

    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")
    monkeypatch.setattr(config.settings, "EVAL_TOTAL_TIMEOUT_S", 0.2)

    async def fake_judge_one(client, patch_yml, scenario):
        if scenario.get("id") == "slow":
            await asyncio.sleep(10)
            raise AssertionError("should have been cancelled")
        return True, 90.0, "fast ok", {"prompt": "p", "reply": "r", "tool_calls": []}

    monkeypatch.setattr(evaluator, "_judge_one", fake_judge_one)

    class NoClient:
        def __init__(self, **kwargs: object) -> None:
            pass

    monkeypatch.setattr(evaluator, "DeepSeekClient", NoClient)

    score, result = evaluator.evaluate_harness_sync(
        VALID_PATCH_YML,
        [
            {"id": "fast", "customer_message": "Hi"},
            {"id": "slow", "customer_message": "Hello?"},
        ],
    )
    assert result["scenarios"][0]["passed"] is True
    assert result["scenarios"][0]["score"] == 90.0
    assert result["scenarios"][1]["passed"] is False
    assert result["scenarios"][1]["score"] == 0.0
    assert result["scenarios"][1]["reason"] == "eval_total_timeout"
    assert result["passed"] == 1
    assert result["total"] == 2
    assert score == 45.0


def test_evaluator_calls_grafilab_directly_with_harness_text(monkeypatch) -> None:
    import app.services.evaluator as evaluator
    from app.core import config

    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")
    monkeypatch.setattr(config.settings, "JUDGE_MODEL", None)

    calls: dict[str, object] = {}
    rollouts: list[dict[str, object]] = []

    async def fake_run_candidate(patch_yml: str, scenario: dict) -> dict:
        rollouts.append({"patch_yml": patch_yml, "scenario": dict(scenario)})
        sid = str(scenario.get("id", "x"))
        return {
            "prompt": str(scenario.get("customer_message", "")),
            "reply": f"rollout reply for {sid}: I can help with that.",
            "tool_calls": [{"name": "lookup_order", "arguments": {}}],
            "steps": [],
            "model": "candidate-model",
        }

    monkeypatch.setattr(evaluator, "_run_candidate", fake_run_candidate)

    class FakeClient:
        def __init__(
            self,
            api_key: str | None = None,
            base_url: str = "",
            model: str = "",
            default_timeout: float = 0,
        ) -> None:
            calls["api_key"] = api_key
            calls["base_url"] = base_url
            calls["model"] = model

        async def run_prompt_single(self, prompt: str, **kwargs: object) -> dict:
            prompts = calls.setdefault("prompts", [])
            assert isinstance(prompts, list)
            prompts.append(prompt)
            calls["temperature"] = kwargs.get("temperature")
            calls["system_text"] = kwargs.get("system_text")
            if len(prompts) == 1:
                return {"reply": '{"passed": true, "score": 90, "reason": "judged"}'}
            return {"reply": '{"passed": false, "score": 40, "reason": "judged"}'}

        async def run_prompt_agent(self, *args: object, **kwargs: object) -> dict:
            raise AssertionError("evaluator must not run an agent loop")

    monkeypatch.setattr(evaluator, "DeepSeekClient", FakeClient)

    scenarios = [
        {"id": "a", "customer_message": "I want a refund."},
        {"id": "b", "customer_message": "I cannot log in."},
    ]
    score, result = evaluator.evaluate_harness_sync(VALID_PATCH_YML, scenarios)

    # Rollout ran once per scenario with the harness + customer message.
    assert len(rollouts) == 2
    assert all(r["patch_yml"] == VALID_PATCH_YML for r in rollouts)
    assert rollouts[0]["scenario"]["customer_message"] == "I want a refund."
    assert rollouts[1]["scenario"]["customer_message"] == "I cannot log in."

    assert calls["api_key"] == "grafilab-key"
    assert calls["base_url"] == config.settings.GRAFFILAB_BASE_URL
    assert calls["temperature"] == 0
    assert calls["system_text"]
    assert "ACTUAL" in str(calls["system_text"])
    prompts = calls["prompts"]
    assert isinstance(prompts, list) and len(prompts) == 2
    assert all(VALID_PATCH_YML.strip() in prompt for prompt in prompts)
    assert all("0-100" in prompt for prompt in prompts)
    # Judge saw the actual rollout output, not just the harness.
    assert all("rollout reply for" in prompt for prompt in prompts)
    assert all("rollout_reply" in prompt for prompt in prompts)
    assert score == 65.0
    assert result["passed"] == 1
    assert result["total"] == 2
    assert result["evaluation_mode"] == "rollout+judge"
    assert result["rubric_version"] == "2"
    assert result["pass_threshold"] == 85.0
    assert result["judge_temperature"] == 0.0
    assert result["candidate_url"].endswith("/api/v1/deepseek/chat")
    assert result["scenarios"][0]["score"] == 90.0
    assert result["scenarios"][1]["score"] == 40.0
    assert result["scenarios"][0]["candidate_reply"].startswith("rollout reply for a")
    assert result["scenarios"][1]["candidate_prompt"] == "I cannot log in."
    assert result["judge_model"] == config.settings.GRAFFILAB_MODEL


def test_evaluator_rollout_failure_fails_scenario_without_judge(monkeypatch) -> None:
    import app.services.evaluator as evaluator
    from app.core import config

    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")

    async def failing_candidate(_patch_yml: str, _scenario: dict) -> dict:
        raise RuntimeError("candidate boom")

    monkeypatch.setattr(evaluator, "_run_candidate", failing_candidate)

    class NoJudgeClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def run_prompt_single(self, *args: object, **kwargs: object) -> dict:
            raise AssertionError("judge must not run when rollout fails")

    monkeypatch.setattr(evaluator, "DeepSeekClient", NoJudgeClient)

    score, result = evaluator.evaluate_harness_sync(
        VALID_PATCH_YML, [{"id": "a", "customer_message": "Hi"}]
    )
    assert score == 0.0
    assert result["passed"] == 0
    assert result["scenarios"][0]["passed"] is False
    assert "candidate_error" in result["scenarios"][0]["reason"]


def test_evaluator_empty_scenarios_falls_back_to_generic_review(monkeypatch) -> None:
    import app.services.evaluator as evaluator
    from app.core import config

    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")
    monkeypatch.setattr(config.settings, "JUDGE_MODEL", None)

    calls: dict[str, object] = {}

    async def fake_run_candidate(patch_yml: str, scenario: dict) -> dict:
        calls["rollout_scenario"] = dict(scenario)
        return {
            "prompt": "generic prompt",
            "reply": "generic rollout reply: happy to help.",
            "tool_calls": [],
            "steps": [],
            "model": "candidate-model",
        }

    monkeypatch.setattr(evaluator, "_run_candidate", fake_run_candidate)

    class FakeClient:
        def __init__(self, **kwargs: object) -> None:
            calls["init"] = kwargs

        async def run_prompt_single(self, prompt: str, **kwargs: object) -> dict:
            calls["prompt"] = prompt
            return {"reply": '{"passed": true, "score": 90, "reason": "clear persona"}'}

    monkeypatch.setattr(evaluator, "DeepSeekClient", FakeClient)

    score, result = evaluator.evaluate_harness_sync(VALID_PATCH_YML, [])

    prompt = calls["prompt"]
    assert isinstance(prompt, str)
    assert VALID_PATCH_YML.strip() in prompt
    assert "generic" in prompt.lower()
    assert "generic rollout reply" in prompt
    assert score == 90.0
    assert result["generic"] is True
    assert result["evaluation_mode"] == "rollout+judge"
    assert result["total"] == 1
    assert result["scenarios"][0]["scenario_id"] == "generic-harness-review"
    assert result["scenarios"][0]["score"] == 90.0
    assert result["scenarios"][0]["candidate_reply"].startswith("generic rollout reply")


def test_create_child_rejects_non_complete_parents(monkeypatch) -> None:
    for status in ("pending", "running", "failed"):
        factory, _ = _session_factory()
        with factory() as session:
            _seed(session, root_status=status)
        _patch_mcp_scope(monkeypatch, factory)

        parent = mcp_server.get_node("tree-1", "root-1")
        try:
            mcp_server.create_child_node(
                "tree-1",
                "root-1",
                parent["parent_revision"],
                suggested_changes={"plugins": []},
            )
        except ValueError as exc:
            message = str(exc)
            assert f"status is '{status}'" in message
            assert "Only complete nodes can have children" in message
        else:
            raise AssertionError(f"{status} parent was accepted")

        with factory() as session:
            children = session.query(Node).filter(Node.parent_id == "root-1").all()
            assert children == []


def test_create_child_rejects_full_harness_payload(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    parent = mcp_server.get_node("tree-1", "root-1")
    try:
        mcp_server.create_child_node(
            "tree-1",
            "root-1",
            parent["parent_revision"],
            suggested_changes={"version": 1, "dsh_plugins": []},
        )
    except ValueError as exc:
        assert "not a full harness" in str(exc)
    else:
        raise AssertionError("full harness payload was accepted")


def test_create_child_requires_parent_revision(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    try:
        mcp_server.create_child_node(
            "tree-1",
            "root-1",
            "",
            suggested_changes={"plugins": []},
        )
    except ValueError as exc:
        assert "Call get_node" in str(exc)
    else:
        raise AssertionError("missing parent revision was accepted")


def test_create_child_rejects_stale_parent_revision(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    try:
        mcp_server.create_child_node(
            "tree-1",
            "root-1",
            "sha256:" + "0" * 64,
            suggested_changes={"plugins": []},
        )
    except ValueError as exc:
        assert "Stale parent_revision" in str(exc)
    else:
        raise AssertionError("stale parent revision was accepted")


def test_create_child_rejects_more_than_120_suggestion_lines(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    too_many = {"plugins": [{"id": "persona", "config": {f"key-{i}": i for i in range(121)}}]}
    parent = mcp_server.get_node("tree-1", "root-1")
    try:
        mcp_server.create_child_node("tree-1", "root-1", parent["parent_revision"], too_many)
    except ValueError as exc:
        assert "lines; the maximum is 120" in str(exc)
    else:
        raise AssertionError("oversized suggestion was accepted")


def test_digest_text_keeps_string_failures_and_harness_name(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
        session.add(
            Node(
                id="failed-1",
                tree_id="tree-1",
                parent_id="root-1",
                harness="name: unsafe-shortcut\ntools: []\n",
                status="failed",
                score=10.0,
                benchmark_result={"failed_scenarios": ["Ignored company policy"]},
            )
        )
        session.commit()
    _patch_mcp_scope(monkeypatch, factory)

    digest = mcp_server.checkout_tree("tree-1")
    assert "harness=text chars=" in digest["digest_text"]
    assert "failed scenarios: Ignored company policy" in digest["digest_text"]


def test_deepseek_resolve_accepts_harness_yml() -> None:
    rt = _resolve(ChatRequest(prompt="hi", harness_yml=VALID_PATCH_YML))
    assert rt["source"] == "yml"
    assert "careful customer support" in (rt["system_text"] or "")
    assert rt["patch_yml"] is not None
    assert "persona" in rt["patch_yml"]
    # Round-trip: the rendered yml parses back to the same plugin row.
    assert to_cordis_patch_yml(rt["harness"]) == rt["patch_yml"]


def test_deepseek_resolve_rejects_both_forms() -> None:
    from fastapi import HTTPException

    try:
        _resolve(ChatRequest(prompt="hi", harness=VALID_PATCH_YML, harness_yml=VALID_PATCH_YML))
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("both harness forms were accepted")


def test_llm_provider_resolution_prefers_deepseek_key(monkeypatch) -> None:
    from app.core import config

    monkeypatch.setattr(config.settings, "DEEPSEEK_API_KEY", "deepseek-key")
    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")
    assert config.llm_provider() == "deepseek"
    assert config.llm_api_key() == "deepseek-key"
    assert config.llm_base_url() == config.settings.DEEPSEEK_BASE_URL
    assert config.llm_model() == config.settings.DEEPSEEK_MODEL

    monkeypatch.setattr(config.settings, "DEEPSEEK_API_KEY", None)
    assert config.llm_provider() == "grafilab"
    assert config.llm_api_key() == "grafilab-key"
    assert config.llm_base_url() == config.settings.GRAFFILAB_BASE_URL
    assert config.llm_model() == config.settings.GRAFFILAB_MODEL

    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", None)
    assert config.llm_provider() is None


def test_llm_client_and_health_use_grafilab_when_only_grafilab_key(monkeypatch) -> None:
    from app.api.routes.deepseek import deepseek_health
    from app.core import config
    from app.services.deepseek_client import build_llm_client

    monkeypatch.setattr(config.settings, "DEEPSEEK_API_KEY", None)
    monkeypatch.setattr(config.settings, "GRAFFILAB_API_KEY", "grafilab-key")

    client = build_llm_client()
    assert client.api_key == "grafilab-key"
    assert client.base_url == config.settings.GRAFFILAB_BASE_URL
    assert client.model == config.settings.GRAFFILAB_MODEL

    health = deepseek_health()
    assert health["available"] is True
    assert health["provider"] == "grafilab"
    assert health["model"] == config.settings.GRAFFILAB_MODEL
