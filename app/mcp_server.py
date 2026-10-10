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


MCP_WORKFLOW_INSTRUCTIONS = """DeepSeek harness tree optimizer.

Canonical workflow (follow this order):
1. Call list_trees() before choosing a session.
2. Choose a tree_id from list_trees().trees.
3. Call checkout_tree(tree_id).
4. Choose parent_id from checkout_tree().nodes[].id. Use the actual UUID; do
   not send the display position (for example n000) or the word root.
5. Call create_child_node(tree_id, parent_id, harness, rationale).

create_child_node has one canonical harness input: `harness` must be raw
cordis.patch.yml text. Do not send a JSON object and do not use a
`harness_yml` argument. The server validates the text, normalizes supported
DeepSeek plugins, stores the generated patch text, and creates a pending node.
Evaluation is currently skipped, so no score is produced for a new node.

Minimal valid harness example:
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a careful customer-support agent.
"""

mcp_server = MCPServer(
    name=settings.PROJECT_NAME,
    instructions=MCP_WORKFLOW_INSTRUCTIONS,
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
            "workflow": [
                "Choose tree_id from trees[].tree_id.",
                "Call checkout_tree(tree_id).",
            ],
            "next_step": "Choose a tree_id and call checkout_tree(tree_id).",
        }


def _load_tree_digest(tree_id: str) -> dict[str, Any]:
    with session_scope() as session:
        tree = repository.get_tree(session, tree_id)
        if tree is None:
            raise ValueError(f"Tree '{tree_id}' was not found. Call list_trees() first.")
        digest = digest_tree(
            tree,
            repository.get_tree_nodes(session, tree_id=tree_id),
            repository.get_benchmark(session, tree_id=tree_id),
        )
        digest["workflow"] = {
            "parent_id_rule": (
                "Pass the actual node id from nodes[].id to create_child_node; "
                "do not pass nodes[].position or 'root'."
            ),
            "create_child_node": {
                "tree_id": tree_id,
                "parent_id": "<nodes[].id>",
                "harness": "<raw cordis.patch.yml text>",
                "rationale": "<why this harness is different>",
            },
            "evaluation": "skipped; new nodes remain pending",
        }
        return digest


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
    harness: str,
    rationale: str | None = None,
) -> dict[str, Any]:
    """Create a pending child from raw DeepSeek ``cordis.patch.yml`` text.

    Call this only after ``checkout_tree``. ``parent_id`` must be the actual
    node ID from ``nodes[].id``; the root node's ID is valid and may be used to
    expand directly from the root. ``harness`` is required raw YAML text, not a
    JSON object. Use this shape:

    - id: persona
      name: '@deepseek-ai/dsh-persona'
      config:
        prefix: You are a careful customer-support agent.

    Do not send ``harness_yml``: this tool intentionally has one canonical
    harness argument so clients cannot choose the wrong field. The server
    validates and normalizes the YAML, stores the generated patch text, and
    skips evaluation; the returned node remains ``pending``.
    """
    if not harness.strip():
        raise ValueError(
            "Missing harness. Pass raw cordis.patch.yml text in the 'harness' argument."
        )
    try:
        normalized_harness, meta = coerce_harness(harness)
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
            "next_step": (
                "Call checkout_tree(tree_id) to inspect the new pending node. "
                "Use this node's id for any further child."
            ),
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
