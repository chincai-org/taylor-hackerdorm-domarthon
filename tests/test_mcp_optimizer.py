from __future__ import annotations

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

VALID_HARNESS = {
    "version": 1,
    "kind": "dsh-default",
    "profile": "headless",
    "system_prompt": "",
    "model": {"provider": "deepseek-official", "model": "deepseek-chat"},
    "dsh_plugins": [
        {
            "id": "persona",
            "name": "@deepseek-ai/dsh-persona",
            "config": {"prefix": "You are a careful customer support agent."},
        }
    ],
}

VALID_PATCH_YML = """- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a careful customer support agent.
"""


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
    assert digest["nodes"][0]["harness"]["profile"] == "headless"
    assert digest["nodes"][0]["harness"]["dsh_plugins"][0]["id"] == "persona"
    assert digest["digest_hash"]
    assert "DEEPSEEK HARNESS TREE DIGEST" in digest["digest_text"]
    assert "harness=dsh:headless" in digest["digest_text"]


def test_create_child_persists_deepseek_harness_without_evaluation(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        harness=VALID_HARNESS,
        rationale="Adds a persona prefix.",
    )

    assert result["status"] == "pending"
    assert result["evaluation"] == {
        "status": "skipped",
        "scheduled": False,
        "reason": "The benchmark runner is not implemented yet.",
    }
    assert result["harness_source"] == "json"
    assert "persona" in result["patch_yml"]
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.parent_id == "root-1"
        assert child.harness == VALID_HARNESS
        assert child.score is None
        assert child.benchmark_result is None


def test_create_child_accepts_patch_yml_text(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        harness_yml=VALID_PATCH_YML,
        rationale="Same persona via yml.",
    )

    assert result["status"] == "pending"
    assert result["harness_source"] == "yml"
    assert result["harness"]["dsh_plugins"][0]["id"] == "persona"
    assert "persona" in result["patch_yml"]
    with factory() as session:
        child = session.get(Node, result["node_id"])
        assert child is not None
        assert child.harness["profile"] == "headless"


def test_create_child_accepts_yml_string_in_harness_field(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    result = mcp_server.create_child_node(
        tree_id="tree-1",
        parent_id="root-1",
        harness=VALID_PATCH_YML,  # type: ignore[arg-type]
    )
    assert result["harness_source"] == "yml"


def test_create_child_rejects_both_harness_forms(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    try:
        mcp_server.create_child_node("tree-1", "root-1", VALID_HARNESS, harness_yml=VALID_PATCH_YML)
    except ValueError as exc:
        assert "either" in str(exc).lower()
    else:
        raise AssertionError("both harness forms were accepted")


def test_create_child_rejects_non_deepseek_harness(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    invalid = {"version": 1, "kind": "dsh-default", "profile": "headless", "dsh_plugins": []}
    invalid["dsh_plugins"] = [{"id": "x", "name": "@not-a/real-plugin", "config": {}}]
    try:
        mcp_server.create_child_node("tree-1", "root-1", invalid)
    except ValueError as exc:
        assert "Invalid DeepSeek harness" in str(exc)
    else:
        raise AssertionError("invalid harness was accepted")


def test_create_child_rejects_garbage_yml(monkeypatch) -> None:
    factory, _ = _session_factory()
    with factory() as session:
        _seed(session)
    _patch_mcp_scope(monkeypatch, factory)

    try:
        mcp_server.create_child_node("tree-1", "root-1", harness_yml=": : : not yaml {{{")
    except ValueError as exc:
        assert "Invalid DeepSeek harness" in str(exc)
    else:
        raise AssertionError("garbage yml was accepted")


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
        _resolve(
            ChatRequest(prompt="hi", harness=VALID_HARNESS, harness_yml=VALID_PATCH_YML)  # type: ignore[arg-type]
        )
    except HTTPException as exc:
        assert exc.status_code == 422
    else:
        raise AssertionError("both harness forms were accepted")
