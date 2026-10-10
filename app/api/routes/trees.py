from collections.abc import Iterable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.db.engine import session_scope
from app.db.models import Benchmark, Node, Tree
from app.db.repository import (
    create_benchmark,
    create_root_node,
    get_benchmark,
    get_tree,
    list_trees,
    update_node_evaluation,
)
from app.db.repository import create_tree as persist_tree
from app.harness.dsh import to_cordis_patch_yml
from app.harness.importer import import_harness

router = APIRouter(prefix="/trees", tags=["trees"])


class CreateTreeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be blank")
        return value

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        value = value.strip() if value is not None else None
        return value or None


def _node(node: Node) -> dict[str, Any]:
    return {
        "id": node.id,
        "tree_id": node.tree_id,
        "parent_id": node.parent_id,
        "harness": node.harness,
        "status": node.status,
        "score": node.score,
        "benchmark_result": node.benchmark_result,
        "rationale": node.rationale,
        "error": node.error,
        "created_at": node.created_at.isoformat() if node.created_at else None,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
    }


def _tree(tree: Tree, nodes: Iterable[Node], benchmark: Benchmark | None) -> dict[str, Any]:
    serialized_nodes = [_node(node) for node in nodes]
    scores = [node["score"] for node in serialized_nodes if node["score"] is not None]
    return {
        "id": tree.id,
        "name": tree.name,
        "description": tree.description,
        "benchmark_id": tree.benchmark_id,
        "root_node_id": tree.root_node_id,
        "status": tree.status,
        "metadata": tree.metadata_json,
        "created_at": tree.created_at.isoformat() if tree.created_at else None,
        "updated_at": tree.updated_at.isoformat() if tree.updated_at else None,
        "benchmark": (
            {
                "id": benchmark.id,
                "name": benchmark.name,
                "version": benchmark.version,
                "scenarios": benchmark.scenarios,
            }
            if benchmark
            else None
        ),
        "nodes": serialized_nodes,
        "stats": {
            "node_count": len(serialized_nodes),
            "complete_count": sum(node["status"] == "complete" for node in serialized_nodes),
            "failed_count": sum(node["status"] == "failed" for node in serialized_nodes),
            "best_score": max(scores) if scores else None,
        },
    }


@router.post("", status_code=201)
def create_tree_endpoint(request: CreateTreeRequest) -> dict[str, Any]:
    """Create a support tree with the repository's default DeepSeek harness."""
    patch_path = Path(__file__).resolve().parents[3] / "cordis.patch.yml"
    try:
        patch_yml = patch_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="The default cordis.patch.yml harness could not be read.",
        ) from exc

    try:
        imported = import_harness(patch_yml)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Default harness is invalid: {exc}") from exc

    with session_scope() as session:
        benchmark = create_benchmark(
            session,
            name="Customer support benchmark (unconfigured)",
            scenarios=[],
        )
        tree = persist_tree(
            session,
            name=request.name,
            description=request.description,
            benchmark_id=benchmark.id,
            metadata={
                "initial_harness_source": "cordis.patch.yml",
                "harness_import": {
                    "kept": imported["kept"],
                    "dropped": imported["dropped"],
                    "warnings": imported["warnings"],
                },
                "benchmark_status": "unconfigured",
            },
        )
        root = create_root_node(
            session,
            tree_id=tree.id,
            harness=to_cordis_patch_yml(imported["harness"]),
            rationale="Initial DeepSeek harness loaded from cordis.patch.yml.",
        )
        tree_id = tree.id
        root_id = root.id
        root_harness = root.harness

    # Score the root node right away (generic review: new trees have no
    # scenarios yet) so it never gets stuck in pending.
    with session_scope() as session:
        update_node_evaluation(session, tree_id=tree_id, node_id=root_id, status="running")

    try:
        from app.services.evaluator import evaluate_harness_sync

        score, benchmark_result = evaluate_harness_sync(root_harness, [])
    except Exception as exc:  # noqa: BLE001 - root must land failed, never stuck running
        error: dict[str, Any] = {"code": type(exc).__name__, "message": str(exc)[:500]}
        with session_scope() as session:
            update_node_evaluation(
                session, tree_id=tree_id, node_id=root_id, status="failed", error=error
            )
    else:
        with session_scope() as session:
            update_node_evaluation(
                session,
                tree_id=tree_id,
                node_id=root_id,
                status="complete",
                score=score,
                benchmark_result=benchmark_result,
            )

    with session_scope() as session:
        tree = get_tree(session, tree_id)
        if tree is None:  # pragma: no cover - just created above
            raise HTTPException(status_code=500, detail="Tree was lost after creation.")
        nodes = list(session.query(Node).filter(Node.tree_id == tree.id).order_by(Node.created_at))
        return _tree(tree, nodes, get_benchmark(session, tree_id=tree.id))


@router.get("")
def read_trees() -> dict[str, Any]:
    with session_scope() as session:
        trees = list_trees(session)
        result = []
        for tree in trees:
            nodes = list(
                session.query(Node)
                .filter(Node.tree_id == tree.id)
                .order_by(Node.created_at)
            )
            result.append(_tree(tree, nodes, get_benchmark(session, tree_id=tree.id)))
        return {"data": result, "total": len(result)}


@router.get("/{tree_id}")
def read_tree(tree_id: str) -> dict[str, Any]:
    with session_scope() as session:
        tree = get_tree(session, tree_id)
        if tree is None:
            raise HTTPException(status_code=404, detail="Tree not found")
        nodes = list(
            session.query(Node)
            .filter(Node.tree_id == tree.id)
            .order_by(Node.created_at)
        )
        return _tree(tree, nodes, get_benchmark(session, tree_id=tree.id))
