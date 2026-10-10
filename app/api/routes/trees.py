from collections.abc import Iterable
from typing import Any

from fastapi import APIRouter, HTTPException

from app.db.engine import session_scope
from app.db.models import Benchmark, Node, Tree
from app.db.repository import get_benchmark, get_tree, list_trees

router = APIRouter(prefix="/trees", tags=["trees"])


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
