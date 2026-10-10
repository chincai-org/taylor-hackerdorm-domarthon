from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

from app.core.config import settings
from app.db import repository
from app.db.engine import session_scope
from app.harness.dsh import to_cordis_patch_yml
from app.harness.importer import coerce_harness
from app.services.tree_digest import digest_tree


def _vercel_host() -> str | None:
    value = os.getenv("VERCEL_URL")
    if not value:
        return None

    parsed = urlparse(value if "://" in value else f"https://{value}")
    return parsed.netloc or parsed.path


allowed_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
allowed_origins = [
    "http://127.0.0.1:*",
    "http://localhost:*",
    "http://[::1]:*",
]

vercel_host = _vercel_host()
if vercel_host:
    allowed_hosts.append(vercel_host)
    allowed_origins.append(f"https://{vercel_host}")


mcp_server = MCPServer(
    name=settings.PROJECT_NAME,
    instructions=(
        "DeepSeek customer-support harness optimizer. "
        "At the start of every optimizer session, call list_trees first. "
        "After the user chooses a tree, call checkout_tree with its tree_id. "
        "Use the returned digest to choose a parent node and submit only a "
        "DeepSeek harness object through create_child_node. Evaluation is "
        "currently skipped, so newly created nodes remain pending."
    ),
    version=settings.VERSION,
)


@mcp_server.tool()
def list_trees() -> dict[str, Any]:
    """List every optimization tree available in the website database.

    Call this before any other optimizer action. The response intentionally
    contains summaries only; use checkout_tree(tree_id) for the full digest.
    """
    with session_scope() as session:
        trees = repository.list_trees(session)
        summaries: list[dict[str, Any]] = []
        for tree in trees:
            nodes = repository.get_tree_nodes(session, tree_id=tree.id)
            scored_nodes = [node for node in nodes if node.score is not None]
            best_node = max(
                scored_nodes,
                key=lambda node: (node.score, node.created_at, node.id),
                default=None,
            )
            statuses: dict[str, int] = {}
            for node in nodes:
                statuses[node.status] = statuses.get(node.status, 0) + 1
            summaries.append(
                {
                    "tree_id": tree.id,
                    "name": tree.name,
                    "description": tree.description,
                    "status": tree.status,
                    "root_node_id": tree.root_node_id,
                    "node_count": len(nodes),
                    "best_score": best_node.score if best_node else None,
                    "best_node_id": best_node.id if best_node else None,
                    "node_status_counts": statuses,
                    "benchmark_id": tree.benchmark_id,
                    "updated_at": tree.updated_at.isoformat() if tree.updated_at else None,
                }
            )
        return {
            "trees": summaries,
            "total": len(summaries),
            "next_step": "Choose a tree_id and call checkout_tree(tree_id).",
        }


def _load_tree_digest(tree_id: str) -> dict[str, Any]:
    with session_scope() as session:
        tree = repository.get_tree(session, tree_id)
        if tree is None:
            raise ValueError(f"Tree '{tree_id}' was not found. Call list_trees() first.")
        return digest_tree(
            tree,
            repository.get_tree_nodes(session, tree_id=tree_id),
            repository.get_benchmark(session, tree_id=tree_id),
        )


@mcp_server.tool()
def checkout_tree(tree_id: str) -> dict[str, Any]:
    """Checkout a tree and return its complete optimizer-oriented digest.

    The digest includes benchmark context, parent/child structure, every
    DeepSeek harness, rationales, scores, statuses, and summarized failures.
    No database state is changed by this operation.
    """
    return _load_tree_digest(tree_id)


@mcp_server.tool()
def create_child_node(
    tree_id: str,
    parent_id: str,
    harness: str | None = None,
    rationale: str | None = None,
    harness_yml: str | None = None,
    harness_profile: str | None = None,
) -> dict[str, Any]:
    """Store a validated DeepSeek harness as a new child node.

    Pass the harness as raw ``cordis.patch.yml`` text. The text is validated
    server-side via the importer and stored unchanged as text. Evaluation is
    deliberately skipped until the test runner is implemented; the node is
    stored as pending and no score is invented.
    """
    if harness is None and harness_yml is None:
        raise ValueError(
            "Missing harness. Pass 'harness' (raw cordis.patch.yml text)."
        )
    try:
        normalized_harness, meta = coerce_harness(harness, harness_yml, profile=harness_profile)
    except Exception as exc:
        raise ValueError(f"Invalid DeepSeek harness. Details: {exc}") from exc
    assert normalized_harness is not None  # coerce returns None only when both inputs are None
    try:
        patch_yml = to_cordis_patch_yml(normalized_harness)
    except ValueError as exc:
        raise ValueError(f"Invalid DeepSeek harness. Details: {exc}") from exc

    with session_scope() as session:
        if repository.get_tree(session, tree_id) is None:
            raise ValueError(f"Tree '{tree_id}' was not found. Call list_trees() first.")
        parent = repository.get_node(session, tree_id=tree_id, node_id=parent_id)
        if parent is None:
            raise ValueError(
                f"Parent node '{parent_id}' was not found in tree '{tree_id}'. "
                "Use checkout_tree() and select a node from that tree."
            )

        node = repository.create_child_node(
            session,
            tree_id=tree_id,
            parent_id=parent_id,
            harness=patch_yml,
            rationale=rationale,
        )
        return {
            "node_id": node.id,
            "tree_id": node.tree_id,
            "parent_id": node.parent_id,
            "status": node.status,
            "harness": patch_yml,
            "patch_yml": patch_yml,
            "harness_source": meta.get("source", "none"),
            "warnings": meta.get("warnings", []),
            "dropped": meta.get("dropped", []),
            "rationale": node.rationale,
            "evaluation": {
                "status": "skipped",
                "scheduled": False,
                "reason": "The benchmark runner is not implemented yet.",
            },
            "next_step": "Call checkout_tree(tree_id) to inspect the new pending node.",
        }


mcp_app = mcp_server.streamable_http_app(
    streamable_http_path="/",
    stateless_http=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=["*"],
        allowed_origins=["*"],
    ),
)
