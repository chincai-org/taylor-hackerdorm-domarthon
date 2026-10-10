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
    assert root["status"] == "pending"
    assert isinstance(root["harness"], str)
    assert "model: \"grafilab/deepseek-v4-flash\"" in root["harness"]
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
