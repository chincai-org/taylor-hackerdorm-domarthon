from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any
from urllib.parse import urlparse

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

from app.core.config import settings
from app.db import repository
from app.db.engine import session_scope
from app.harness.dsh import harness_diff, to_cordis_patch_yml
from app.harness.importer import coerce_harness
from app.harness.suggested_changes import apply_suggested_changes
from app.services.tree_digest import digest_tree


def _parent_revision(harness: str) -> str:
    """Derive a stable revision from the exact stored parent harness text."""
    digest = hashlib.sha256(harness.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


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
3. Call checkout_tree(tree_id), then get_node(tree_id, node_id) for the exact
   parent content you intend to improve.
4. Choose parent_id from get_node().node_id or checkout_tree().nodes[].id. Use
   the actual UUID; never send a display position such as n000 or the word root.
5. Pass get_node().parent_revision back to create_child_node unchanged.
6. Call create_child_node(tree_id, parent_id, parent_revision, suggested_changes,
   rationale).

create_child_node is parent-relative. Do not send a full harness, raw YAML, or
fields such as version, kind, profile, or dsh_plugins. Send only a JSON object
with the changes to apply: existing plugin config updates go in `plugins`, new
rows in `add_plugins`, removals in `remove_plugins`, and top-level prompt/model
updates in `system_prompt` / `model`. The server preserves every unmentioned
parent field and rejects suggestions longer than 120 lines.
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
                "Pass the actual node id from nodes[].id to get_node and "
                "create_child_node; do not pass nodes[].position or 'root'."
            ),
            "create_child_node": {
                "tree_id": tree_id,
                "parent_id": "<get_node().node_id>",
                "parent_revision": "<get_node().parent_revision>",
                "suggested_changes": {
                    "plugins": [
                        {"id": "persona", "config": {"prefix": "<new prefix>"}}
                    ]
                },
                "rationale": "<why these parent-relative changes are better>",
            },
            "change_line_limit": 120,
            "harness_input": "parent-relative changes only; never a full harness",
            "parent_revision": "required from get_node(); no database field is needed",
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
def get_node(tree_id: str, node_id: str) -> dict[str, Any]:
    """Return the exact content of one node before proposing a child.

    This is the required parent-read step. The returned ``harness`` is the
    complete stored parent patch, while ``node_id`` is the actual node ID to
    pass back to ``create_child_node``. The optimizer must not treat the display
    position in ``checkout_tree`` as an ID.
    """
    with session_scope() as session:
        if repository.get_tree(session, tree_id) is None:
            raise ValueError(f"Tree '{tree_id}' was not found. Call list_trees() first.")
        node = repository.get_node(session, tree_id=tree_id, node_id=node_id)
        if node is None:
            raise ValueError(
                f"Node '{node_id}' was not found in tree '{tree_id}'. "
                "Use checkout_tree() and select a node from that tree."
            )
        children = repository.get_children(session, tree_id=tree_id, parent_id=node_id)
        return {
            "node_id": node.id,
            "tree_id": node.tree_id,
            "parent_id": node.parent_id,
            "status": node.status,
            "score": node.score,
            "harness": node.harness,
            "parent_revision": _parent_revision(node.harness),
            "rationale": node.rationale,
            "benchmark_result": node.benchmark_result,
            "error": node.error,
            "children": [child.id for child in children],
            "next_step": (
                "Pass this node_id as parent_id and this parent_revision unchanged; "
                "then call create_child_node with only parent-relative suggested_changes."
            ),
        }


@mcp_server.tool()
def create_child_node(
    tree_id: str,
    parent_id: str,
    parent_revision: str,
    suggested_changes: dict[str, Any],
    rationale: str | None = None,
) -> dict[str, Any]:
    """Create a pending child from bounded, parent-relative changes.

    Call ``get_node`` first and pass its ``parent_revision`` unchanged.
    ``suggested_changes`` is not a full harness and cannot contain ``version``,
    ``kind``, ``profile``, or ``dsh_plugins``.
    Existing plugin rows are partially updated through ``plugins``; use
    ``add_plugins`` and ``remove_plugins`` for row additions/removals. All
    unmentioned parent data is retained and the suggestion payload must stay
    within 120 lines.
    """
    if not isinstance(parent_revision, str) or not parent_revision.strip():
        raise ValueError(
            "Missing parent_revision. Call get_node(tree_id, parent_id) first and "
            "pass its parent_revision unchanged."
        )
    if not isinstance(suggested_changes, dict):
        raise ValueError("suggested_changes must be a JSON object of parent-relative changes")

    with session_scope() as session:
        if repository.get_tree(session, tree_id) is None:
            raise ValueError(f"Tree '{tree_id}' was not found. Call list_trees() first.")
        parent = repository.get_node(session, tree_id=tree_id, node_id=parent_id)
        if parent is None:
            raise ValueError(
                f"Parent node '{parent_id}' was not found in tree '{tree_id}'. "
                "Use get_node() or checkout_tree() and select a node from that tree."
            )

        current_revision = _parent_revision(parent.harness)
        if not hmac.compare_digest(parent_revision, current_revision):
            raise ValueError(
                "Stale parent_revision. Call get_node again for the current parent "
                "and pass its parent_revision unchanged."
            )

        try:
            parent_harness, parent_meta = coerce_harness(parent.harness)
            if parent_harness is None:
                raise ValueError("parent harness is empty")
            child_harness, change_lines = apply_suggested_changes(
                parent_harness,
                suggested_changes,
            )
            patch_yml = to_cordis_patch_yml(child_harness)
        except Exception as exc:
            raise ValueError(f"Invalid suggested_changes. Details: {exc}") from exc

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
            "parent_revision": current_revision,
            "status": node.status,
            "harness": patch_yml,
            "patch_yml": patch_yml,
            "suggested_changes": suggested_changes,
            "change_lines": change_lines,
            "parent_harness": parent.harness,
            "diff": harness_diff(parent_harness, child_harness),
            "harness_source": parent_meta.get("source", "none"),
            "warnings": parent_meta.get("warnings", []),
            "dropped": parent_meta.get("dropped", []),
            "rationale": node.rationale,
            "evaluation": {
                "status": "skipped",
                "scheduled": False,
                "reason": "The benchmark runner is not implemented yet.",
            },
            "next_step": (
                "Call checkout_tree(tree_id) or get_node(tree_id, node_id) to inspect "
                "the new child."
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
