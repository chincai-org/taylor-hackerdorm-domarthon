from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import Benchmark, Node, Tree


def create_benchmark(
    session: Session,
    *,
    name: str,
    scenarios: list[dict[str, Any]],
    version: int = 1,
) -> Benchmark:
    benchmark = Benchmark(name=name, scenarios=scenarios, version=version)
    session.add(benchmark)
    session.flush()
    return benchmark


def create_tree(
    session: Session,
    *,
    name: str,
    benchmark_id: str,
    description: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Tree:
    if session.get(Benchmark, benchmark_id) is None:
        raise ValueError(f"Benchmark {benchmark_id} does not exist")

    tree = Tree(
        name=name,
        description=description,
        benchmark_id=benchmark_id,
        metadata_json=metadata or {},
    )
    session.add(tree)
    session.flush()
    return tree


def create_root_node(
    session: Session,
    *,
    tree_id: str,
    harness: str,
    rationale: str | None = None,
) -> Node:
    tree = session.get(Tree, tree_id)
    if tree is None:
        raise ValueError(f"Tree {tree_id} does not exist")
    if tree.root_node_id is not None:
        raise ValueError(f"Tree {tree_id} already has a root node")

    node = Node(tree_id=tree_id, harness=harness, rationale=rationale)
    session.add(node)
    session.flush()
    tree.root_node_id = node.id
    return node


def create_child_node(
    session: Session,
    *,
    tree_id: str,
    parent_id: str,
    harness: str,
    rationale: str | None = None,
) -> Node:
    parent = session.get(Node, parent_id)
    if parent is None or parent.tree_id != tree_id:
        raise ValueError("Parent node does not exist in the requested tree")
    if parent.status != "complete":
        raise ValueError(
            f"Parent node '{parent_id}' cannot have children while its status is "
            f"'{parent.status}'. Only complete nodes can have children."
        )

    node = Node(
        tree_id=tree_id,
        parent_id=parent_id,
        harness=harness,
        rationale=rationale,
    )
    session.add(node)
    session.flush()

    # A new node is a tree mutation. Touch the parent tree so list_trees() can
    # order sessions by their most recent optimizer activity.
    tree = session.get(Tree, tree_id)
    if tree is not None:
        tree.updated_at = func.now()
    return node


def get_tree(session: Session, tree_id: str) -> Tree | None:
    return session.get(Tree, tree_id)


def list_trees(session: Session, *, limit: int | None = None) -> list[Tree]:
    query = select(Tree).order_by(Tree.updated_at.desc())
    if limit is not None:
        query = query.limit(max(1, limit))
    return list(session.scalars(query))


def get_tree_nodes(session: Session, *, tree_id: str) -> list[Node]:
    """Return every node in a tree in stable creation order."""
    return list(
        session.scalars(
            select(Node).where(Node.tree_id == tree_id).order_by(Node.created_at, Node.id)
        )
    )


def get_node(session: Session, *, tree_id: str, node_id: str) -> Node | None:
    node = session.get(Node, node_id)
    return node if node is not None and node.tree_id == tree_id else None


def get_children(session: Session, *, tree_id: str, parent_id: str) -> list[Node]:
    return list(
        session.scalars(
            select(Node)
            .where(Node.tree_id == tree_id, Node.parent_id == parent_id)
            .order_by(Node.created_at)
        )
    )


def get_benchmark(session: Session, *, tree_id: str) -> Benchmark | None:
    benchmark = session.scalars(
        select(Benchmark).join(Tree, Tree.benchmark_id == Benchmark.id).where(Tree.id == tree_id)
    ).first()
    return benchmark


def update_node_evaluation(
    session: Session,
    *,
    tree_id: str,
    node_id: str,
    status: str,
    score: float | None = None,
    benchmark_result: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> Node:
    node = get_node(session, tree_id=tree_id, node_id=node_id)
    if node is None:
        raise ValueError("Node does not exist in the requested tree")

    node.status = status
    node.score = score
    node.benchmark_result = benchmark_result
    node.error = error
    session.flush()
    return node


def tree_node_count(session: Session, *, tree_id: str) -> int:
    return int(
        session.scalar(select(func.count()).select_from(Node).where(Node.tree_id == tree_id)) or 0
    )
