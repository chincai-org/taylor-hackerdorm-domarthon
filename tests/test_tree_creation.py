from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

os.environ.setdefault("DATABASE_URL", "sqlite://")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes import trees
from app.db.models import Base, Node, Tree
from app.db.repository import create_benchmark, create_tree


def _session_factory() -> tuple[sessionmaker[Session], object]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False), engine


def test_create_tree_persists_default_harness_and_root(monkeypatch) -> None:
    factory, _ = _session_factory()

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

    monkeypatch.setattr(trees, "session_scope", scope)

    import app.services.evaluator as evaluator

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
                    "reason": "solid",
                },
            ],
        }
        return 100.0, result

    monkeypatch.setattr(evaluator, "evaluate_harness_sync", fake_evaluate)

    result = trees.create_tree_endpoint(
        trees.CreateTreeRequest(name="  Refund support  ", description="  First experiment  ")
    )

    assert result["name"] == "Refund support"
    assert result["description"] == "First experiment"
    assert result["metadata"]["initial_harness_source"] == "cordis.patch.yml"
    assert result["metadata"]["harness_import"]["kept"] == [
        "core-logger",
        "llm-adapter",
        "tool-filesystem",
        "tool-search",
    ]
    assert result["metadata"]["harness_import"]["dropped"] == []
    assert result["benchmark"]["scenarios"] == []
    assert result["stats"]["node_count"] == 1

    root = result["nodes"][0]
    assert root["id"] == result["root_node_id"]
    assert root["parent_id"] is None
    assert seen["scenarios"] == []
    assert root["status"] == "complete"
    assert root["score"] == 100.0
    assert root["benchmark_result"] is not None
    assert root["benchmark_result"]["generic"] is True
    assert isinstance(root["harness"], str)
    assert 'model: "grafilab/deepseek-v4-flash"' in root["harness"]
    assert all(
        plugin_id in root["harness"]
        for plugin_id in ("core-logger", "llm-adapter", "tool-filesystem", "tool-search")
    )

    with factory() as session:
        persisted = session.get(Tree, result["id"])
        assert persisted is not None
        assert persisted.root_node_id == root["id"]
        assert session.get(Node, root["id"]) is not None


def test_create_tree_request_rejects_blank_name() -> None:
    try:
        trees.CreateTreeRequest(name="   ")
    except ValueError as exc:
        assert "Name cannot be blank" in str(exc)
    else:
        raise AssertionError("blank tree name was accepted")


def test_benchmark_scenarios_can_be_created_updated_and_deleted(monkeypatch) -> None:
    factory, _ = _session_factory()

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

    monkeypatch.setattr(trees, "session_scope", scope)
    with scope() as session:
        benchmark = create_benchmark(session, name="Test benchmark", scenarios=[])
        tree = create_tree(session, name="Test tree", benchmark_id=benchmark.id)
        tree_id = tree.id

    created = trees.create_scenario(
        tree_id,
        trees.ScenarioRequest(scenario={"name": "Refund", "expected_final_action": "refund"}),
    )
    scenario_id = created["scenario"]["id"]
    assert created["benchmark"]["version"] == 2

    updated = trees.update_scenario(
        tree_id,
        scenario_id,
        trees.ScenarioRequest(scenario={"name": "Updated refund"}),
    )
    assert updated["scenario"] == {"name": "Updated refund", "id": scenario_id}
    assert updated["benchmark"]["version"] == 3

    deleted = trees.delete_scenario(tree_id, scenario_id)
    assert deleted["benchmark"]["scenarios"] == []
    assert deleted["benchmark"]["version"] == 4


def test_create_tree_root_judge_error_marks_failed(monkeypatch) -> None:
    factory, _ = _session_factory()

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

    monkeypatch.setattr(trees, "session_scope", scope)

    import app.services.evaluator as evaluator

    def _fail(_patch_yml: str, _scenarios: list) -> tuple[float, dict]:
        raise RuntimeError("judge exploded")

    monkeypatch.setattr(evaluator, "evaluate_harness_sync", _fail)

    result = trees.create_tree_endpoint(trees.CreateTreeRequest(name="Failing root"))

    root = result["nodes"][0]
    assert root["status"] == "failed"
    assert root["score"] is None
    assert root["error"] is not None
    assert root["error"]["code"] == "RuntimeError"
