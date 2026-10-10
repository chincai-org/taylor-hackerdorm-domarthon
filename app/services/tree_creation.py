from collections.abc import Iterable
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.db.models import Benchmark, Node, Tree
from app.db.repository import create_benchmark, create_root_node
from app.db.repository import create_tree as persist_tree
from app.harness.dsh import to_cordis_patch_yml
from app.harness.importer import import_harness
from app.schemas.trees import CreateTreeRequest

DEFAULT_PATCH_PATH = Path(__file__).resolve().parents[2] / "cordis.patch.yml"


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


def serialize_tree(
    tree: Tree,
    nodes: Iterable[Node],
    benchmark: Benchmark | None,
) -> dict[str, Any]:
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


def create_tree_with_default_harness(
    session: Session,
    request: CreateTreeRequest,
) -> dict[str, Any]:
    """Create a tree using the same initialization as the website form."""
    patch_yml = DEFAULT_PATCH_PATH.read_text(encoding="utf-8")
    imported = import_harness(patch_yml)

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
    create_root_node(
        session,
        tree_id=tree.id,
        harness=to_cordis_patch_yml(imported["harness"]),
        rationale="Initial DeepSeek harness loaded from cordis.patch.yml.",
    )
    nodes = list(session.query(Node).filter(Node.tree_id == tree.id).order_by(Node.created_at))
    return serialize_tree(tree, nodes, benchmark)
