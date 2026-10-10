from datetime import datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import DateTime, Float, ForeignKey, Index, String, Text, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON


class Base(DeclarativeBase):
    pass


def new_id() -> str:
    return str(uuid4())


class Benchmark(Base):
    __tablename__ = "benchmarks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    scenarios: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Tree(Base):
    __tablename__ = "trees"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    benchmark_id: Mapped[str] = mapped_column(ForeignKey("benchmarks.id"), nullable=False)
    root_node_id: Mapped[str | None] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSON, default=dict, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Node(Base):
    __tablename__ = "nodes"
    __table_args__ = (
        Index("ix_nodes_tree_parent", "tree_id", "parent_id"),
        Index("ix_nodes_tree_status", "tree_id", "status"),
        Index("ix_nodes_tree_score", "tree_id", "score"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    tree_id: Mapped[str] = mapped_column(ForeignKey("trees.id"), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(36))
    harness: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False)
    score: Mapped[float | None] = mapped_column(Float)
    benchmark_result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    rationale: Mapped[str | None] = mapped_column(Text)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
