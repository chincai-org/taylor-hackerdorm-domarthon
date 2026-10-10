from typing import Any

from fastapi import APIRouter, HTTPException

from app.db.engine import session_scope
from app.db.models import Node
from app.db.repository import get_benchmark, get_tree, list_trees
from app.schemas.trees import CreateTreeRequest
from app.services.tree_creation import create_tree_with_default_harness, serialize_tree

router = APIRouter(prefix="/trees", tags=["trees"])


@router.post("", status_code=201)
def create_tree_endpoint(request: CreateTreeRequest) -> dict[str, Any]:
    """Create a support tree with the repository's default DeepSeek harness."""
    try:
        with session_scope() as session:
            return create_tree_with_default_harness(session, request)
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="The default cordis.patch.yml harness could not be read.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=f"Default harness is invalid: {exc}") from exc


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
            result.append(serialize_tree(tree, nodes, get_benchmark(session, tree_id=tree.id)))
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
        return serialize_tree(tree, nodes, get_benchmark(session, tree_id=tree.id))
