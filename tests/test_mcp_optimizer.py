from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

os.environ.setdefault("DATABASE_URL", "sqlite://")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import mcp_server
from app.db.models import Base, Benchmark, Node, Tree

VALID_HARNESS = {
    "name": "support-v2",
    "system_prompt": "You are a careful customer support agent.",
    "tools": [
        {
            "name": "lookup_order",
            "signature": "lookup_order(order_id: str) -> dict",
            "description": "Look up an order.",
        }
    ],
    "policy": ["Do not promise outcomes that policy does not guarantee."],
    "settings": {"temperature": 0.2},
}


def _session_factory() -> tuple[sessionmaker[Session], object]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False), engine


def _seed(session: Session) -> None:
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
            harness=VALID_HARNESS,
            status="pending",
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

    digest = mcp_server.checkout_tree("tree-1")
    assert digest["tree"]["name"] == "DeepSeek support"
    assert digest["stats"]["total_nodes"] == 1
    assert digest["nodes"][0]["position"] == "n000"
    assert digest["nodes"][0]["harness"]["system_prompt"] == VALID_HARNESS["system_prompt"]
    assert digest["digest_hash"]
    assert "DEEPSEEK HARNESS TREE DIGEST" in digest["digest_text"]


def test_create_child_persists_deepseek_harness_without_evaluation(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        harness=VALID_HARNESS,
        rationale="Adds an order lookup tool.",
    )

    assert result["status"] == "pending"
    assert result["evaluation"] == {
        "status": "skipped",
        "scheduled": False,
        "reason": "The benchmark runner is not implemented yet.",
    }
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.parent_id == "root-1"
        assert child.harness == VALID_HARNESS
        assert child.score is None
        assert child.benchmark_result is None


def test_create_child_rejects_non_deepseek_harness(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    invalid = {**VALID_HARNESS, "unexpected": True}
    try:
        mcp_server.create_child_node("tree-1", "root-1", invalid)
    except ValueError as exc:
        assert "Invalid DeepSeek harness" in str(exc)
    else:
        raise AssertionError("invalid harness was accepted")


def test_digest_text_keeps_string_failures_and_harness_name(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
        session.add(
            Node(
                id="failed-1",
                tree_id="tree-1",
                parent_id="root-1",
                harness={"name": "unsafe-shortcut", "tools": []},
                status="failed",
                score=10.0,
                benchmark_result={"failed_scenarios": ["Ignored company policy"]},
            )
        )
        session.commit()
    _patch_mcp_scope(monkeypatch, factory)

    digest = mcp_server.checkout_tree("tree-1")
    assert "harness=unsafe-shortcut" in digest["digest_text"]
    assert "failed scenarios: Ignored company policy" in digest["digest_text"]
