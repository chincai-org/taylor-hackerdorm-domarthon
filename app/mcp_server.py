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
from app.schemas.trees import CreateTreeRequest
from app.services.tree_creation import create_tree_with_default_harness
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
5. The selected parent must have status `complete`; pending, running, and failed
   nodes cannot receive children.
6. Pass get_node().parent_revision back to create_child_node unchanged.
7. Call create_child_node(tree_id, parent_id, parent_revision, suggested_changes,
   rationale).

To start a new optimization session, ask the user for a tree name and optional description,
then call create_tree(name, description). It performs the same initialization as the
website's Create tree form.

create_child_node is parent-relative. Do not send a full harness, raw YAML, or
fields such as version, kind, profile, or dsh_plugins. Send only a JSON object
with the changes to apply: existing plugin config updates go in `plugins`, new
rows in `add_plugins`, removals in `remove_plugins`, and top-level prompt/model
updates in `system_prompt` / `model`. The server preserves every unmentioned
parent field, rejects suggestions longer than 120 lines, then evaluates the
child in one shot: the tree's benchmark dataset is loaded from the database,
all scenario questions are combined into ONE candidate prompt POSTed once with
the child harness, and the full combined output plus ALL scenario expectations
goes to Grafilab in a single judge call (temperature 0, per-scenario verdicts;
empty benchmark falls back to one generic rollout + review). The returned node
is `complete` with a score, or `failed` with an error.
"""

mcp_server = MCPServer(
    name=settings.PROJECT_NAME,
    instructions=MCP_WORKFLOW_INSTRUCTIONS,
    version=settings.VERSION,
)


@mcp_server.tool()
def create_tree(name: str, description: str | None = None) -> dict[str, Any]:
    """Create a new optimization tree with the website's default harness.

    Ask the user for the required name and optional description before calling
    this tool. Name and description are normalized exactly like the website's
    Create tree form, and the default benchmark and baseline root node
    (score 0, complete) are initialized the same way.
    """
    try:
        request = CreateTreeRequest(name=name, description=description)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc

    try:
        with session_scope() as session:
            return create_tree_with_default_harness(session, request)
    except OSError as exc:
        raise ValueError("The default cordis.patch.yml harness could not be read.") from exc
    except ValueError as exc:
        raise ValueError(f"Default harness is invalid: {exc}") from exc


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
            "parent_status_rule": (
                "Only nodes with status 'complete' can receive children; "
                "pending, running, and failed nodes are not valid parents."
            ),
            "create_child_node": {
                "tree_id": tree_id,
                "parent_id": "<get_node().node_id>",
                "parent_revision": "<get_node().parent_revision>",
                "suggested_changes": {
                    "plugins": [{"id": "persona", "config": {"prefix": "<new prefix>"}}]
                },
                "rationale": "<why these parent-relative changes are better>",
            },
            "change_line_limit": 120,
            "harness_input": "parent-relative changes only; never a full harness",
            "parent_revision": "required from get_node(); no database field is needed",
            "evaluation": "scored synchronously; new nodes return complete|failed",
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
                if node.status == "complete"
                else (
                    f"Do not use this node as a parent while its status is "
                    f"'{node.status}'. Wait for evaluation to reach 'complete'."
                )
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
    """Create a child from bounded, parent-relative changes, then score it.

    Call ``get_node`` first and pass its ``parent_revision`` unchanged.
    ``suggested_changes`` is not a full harness and cannot contain ``version``,
    ``kind``, ``profile``, or ``dsh_plugins``.
    Existing plugin rows are partially updated through ``plugins``; use
    ``add_plugins`` and ``remove_plugins`` for row additions/removals. All
    unmentioned parent data is retained and the suggestion payload must stay
    within 120 lines. The server materializes the child patch, loads the
    tree's benchmark dataset from the database, combines all scenario
    questions into ONE candidate prompt POSTed once with the child harness,
    then sends the full combined output plus ALL expectations to Grafilab in
    a single judge call (temperature 0, per-scenario verdicts). The call
    blocks until rollout + judging finishes; the returned node is ``complete``
    with a score, or ``failed`` with an error.
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
        if parent.status != "complete":
            raise ValueError(
                f"Parent node '{parent_id}' cannot have children while its status is "
                f"'{parent.status}'. Only complete nodes can have children."
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
        node_id = node.id
        node_tree_id = node.tree_id
        node_parent_id = node.parent_id
        node_rationale = node.rationale

    # Scenarios are optional: an empty benchmark falls back to one generic
    # harness review inside the evaluator, so the node still gets a score.

    # Pending -> running before the blocking judge calls, so concurrent
    # readers never see a stale pending node mid-evaluation.
    with session_scope() as session:
        repository.update_node_evaluation(
            session, tree_id=tree_id, node_id=node_id, status="running"
        )

    try:
        from app.services.evaluator import evaluate_tree_harness_sync

        # DB-backed one-shot: dataset re-read from benchmarks.scenarios,
        # all questions in one candidate POST, full context to one judge call.
        score, benchmark_result = evaluate_tree_harness_sync(tree_id, patch_yml)
    except Exception as exc:  # noqa: BLE001 - node must land failed, never stuck running
        error = {"code": type(exc).__name__, "message": str(exc)[:500]}
        with session_scope() as session:
            repository.update_node_evaluation(
                session, tree_id=tree_id, node_id=node_id, status="failed", error=error
            )
        return {
            "node_id": node_id,
            "tree_id": node_tree_id,
            "parent_id": node_parent_id,
            "parent_revision": current_revision,
            "status": "failed",
            "score": None,
            "harness": patch_yml,
            "patch_yml": patch_yml,
            "suggested_changes": suggested_changes,
            "change_lines": change_lines,
            "parent_harness": parent.harness,
            "diff": harness_diff(parent_harness, child_harness),
            "harness_source": parent_meta.get("source", "none"),
            "warnings": parent_meta.get("warnings", []),
            "dropped": parent_meta.get("dropped", []),
            "rationale": node_rationale,
            "evaluation": {
                "status": "failed",
                "scheduled": True,
                "score": None,
                "reason": str(exc)[:500],
                "error": error,
            },
            "next_step": (
                "Judging failed; call checkout_tree(tree_id) to inspect the error. "
                "Use this node's id for any further child."
            ),
        }

    failed_ids = [
        item.get("scenario_id", item.get("id", "?"))
        for item in benchmark_result.get("scenarios", [])
        if isinstance(item, dict) and item.get("passed") is False
    ]
    # Evolution rule: a child scoring below its parent is a regression — mark
    # it failed (score + result kept for learning) so future branching skips
    # failed branches instead of building on worse harnesses.
    with session_scope() as session:
        fresh_parent = repository.get_node(session, tree_id=tree_id, node_id=node_parent_id)
        parent_score = fresh_parent.score if fresh_parent is not None else None
    regressed = parent_score is not None and score is not None and score < parent_score
    if regressed:
        regression = {
            "code": "regression",
            "message": (
                f"Score {score} below parent score {parent_score}; "
                "branch from the parent or a better node instead."
            ),
        }
        with session_scope() as session:
            repository.update_node_evaluation(
                session,
                tree_id=tree_id,
                node_id=node_id,
                status="failed",
                score=score,
                benchmark_result=benchmark_result,
                error=regression,
            )
        return {
            "node_id": node_id,
            "tree_id": node_tree_id,
            "parent_id": node_parent_id,
            "parent_revision": current_revision,
            "status": "failed",
            "score": score,
            "harness": patch_yml,
            "patch_yml": patch_yml,
            "suggested_changes": suggested_changes,
            "change_lines": change_lines,
            "parent_harness": parent.harness,
            "diff": harness_diff(parent_harness, child_harness),
            "harness_source": parent_meta.get("source", "none"),
            "warnings": parent_meta.get("warnings", []),
            "dropped": parent_meta.get("dropped", []),
            "rationale": node_rationale,
            "evaluation": {
                "status": "failed",
                "scheduled": True,
                "score": score,
                "passed": benchmark_result.get("passed"),
                "total": benchmark_result.get("total"),
                "failed_scenarios": failed_ids,
                "judge_model": benchmark_result.get("judge_model"),
                "generic": benchmark_result.get("generic", False),
                "reason": regression["message"],
                "error": regression,
            },
            "next_step": (
                "Regression: score below parent. Call checkout_tree(tree_id) "
                "to inspect it. Branch further children from the parent or a "
                "better node, never from this failed node."
            ),
        }
    with session_scope() as session:
        repository.update_node_evaluation(
            session,
            tree_id=tree_id,
            node_id=node_id,
            status="complete",
            score=score,
            benchmark_result=benchmark_result,
        )
    return {
        "node_id": node_id,
        "tree_id": node_tree_id,
        "parent_id": node_parent_id,
        "parent_revision": current_revision,
        "status": "complete",
        "score": score,
        "harness": patch_yml,
        "patch_yml": patch_yml,
        "suggested_changes": suggested_changes,
        "change_lines": change_lines,
        "parent_harness": parent.harness,
        "diff": harness_diff(parent_harness, child_harness),
        "harness_source": parent_meta.get("source", "none"),
        "warnings": parent_meta.get("warnings", []),
        "dropped": parent_meta.get("dropped", []),
        "rationale": node_rationale,
        "evaluation": {
            "status": "complete",
            "scheduled": True,
            "score": score,
            "passed": benchmark_result.get("passed"),
            "total": benchmark_result.get("total"),
            "failed_scenarios": failed_ids,
            "judge_model": benchmark_result.get("judge_model"),
            "generic": benchmark_result.get("generic", False),
        },
        "next_step": (
            "Call checkout_tree(tree_id) to inspect the scored node. "
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
