from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any

from app.db.models import Benchmark, Node, Tree


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _result_summary(result: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep benchmark feedback useful without returning bulky raw transcripts."""
    if not result:
        return None

    summary: dict[str, Any] = {}
    for key in ("score", "passed", "total", "status", "reason"):
        if key in result:
            summary[key] = result[key]

    scenarios = result.get("scenarios")
    if isinstance(scenarios, list):
        failed: list[dict[str, Any]] = []
        passed = 0
        for item in scenarios:
            if not isinstance(item, dict):
                continue
            is_passed = item.get("passed")
            if is_passed is True:
                passed += 1
            elif is_passed is False:
                failed.append(
                    {
                        key: item[key]
                        for key in ("id", "scenario_id", "reason", "failure_reason", "message")
                        if key in item
                    }
                )
        summary.setdefault("total", len(scenarios))
        summary.setdefault("passed", passed)
        summary["failed_scenarios"] = failed
    elif isinstance(result.get("failed_scenarios"), list):
        summary["failed_scenarios"] = result["failed_scenarios"]
    elif isinstance(result.get("failures"), list):
        summary["failed_scenarios"] = result["failures"]

    # Some evaluators use a top-level error/failure field instead of scenarios.
    for key in ("error", "failure", "failure_reasons"):
        if key in result:
            summary[key] = result[key]

    return summary or {"available": True}


def _scenario_digest(scenario: Any) -> Any:
    if not isinstance(scenario, dict):
        return scenario
    # Keep the benchmark context an optimizer needs, while omitting any raw
    # runner transcript or implementation-only fields that may be added later.
    keys = (
        "id",
        "scenario_id",
        "name",
        "customer_message",
        "expected_intent",
        "expected_tools",
        "expected_final_action",
        "forbidden_actions",
        "notes",
    )
    selected = {key: scenario[key] for key in keys if key in scenario}
    return selected or scenario


def digest_tree(
    tree: Tree,
    nodes: list[Node],
    benchmark: Benchmark | None,
) -> dict[str, Any]:
    """Build a deterministic, optimizer-oriented snapshot of a database tree."""
    ordered_nodes = sorted(
        nodes,
        key=lambda node: (node.created_at is None, node.created_at, node.id),
    )
    position_by_id = {node.id: f"n{index:03d}" for index, node in enumerate(ordered_nodes)}
    children_by_parent: dict[str, list[str]] = {node.id: [] for node in ordered_nodes}
    for node in ordered_nodes:
        if node.parent_id in children_by_parent:
            children_by_parent[node.parent_id].append(node.id)

    best_node = max(
        (node for node in ordered_nodes if node.score is not None),
        key=lambda node: (node.score, node.created_at, node.id),
        default=None,
    )
    head = best_node or (ordered_nodes[-1] if ordered_nodes else None)
    tips = [node.id for node in ordered_nodes if not children_by_parent[node.id]]
    counts = Counter(node.status for node in ordered_nodes)

    serialized_nodes: list[dict[str, Any]] = []
    for node in ordered_nodes:
        serialized_nodes.append(
            {
                "position": position_by_id[node.id],
                "id": node.id,
                "parent_id": node.parent_id,
                "parent_position": position_by_id.get(node.parent_id),
                "children": [position_by_id[child_id] for child_id in children_by_parent[node.id]],
                "status": node.status,
                "score": node.score,
                "harness": node.harness,
                "rationale": node.rationale,
                "benchmark_result": _result_summary(node.benchmark_result),
                "error": node.error,
                "created_at": _iso(node.created_at),
                "updated_at": _iso(node.updated_at),
            }
        )

    benchmark_digest = None
    if benchmark is not None:
        scenarios = benchmark.scenarios if isinstance(benchmark.scenarios, list) else []
        benchmark_digest = {
            "id": benchmark.id,
            "name": benchmark.name,
            "version": benchmark.version,
            "scenario_count": len(scenarios),
            "scenarios": [_scenario_digest(scenario) for scenario in scenarios],
        }

    digest: dict[str, Any] = {
        "protocol": "deepseek-harness-optimizer/tree-digest/1",
        "tree": {
            "id": tree.id,
            "name": tree.name,
            "description": tree.description,
            "status": tree.status,
            "metadata": tree.metadata_json,
            "root_node_id": tree.root_node_id,
            "created_at": _iso(tree.created_at),
            "updated_at": _iso(tree.updated_at),
        },
        "benchmark": benchmark_digest,
        "stats": {
            "total_nodes": len(ordered_nodes),
            "complete_nodes": counts.get("complete", 0),
            "failed_nodes": counts.get("failed", 0),
            "pending_nodes": counts.get("pending", 0),
            "running_nodes": counts.get("running", 0),
            "best_score": best_node.score if best_node else None,
            "best_node_id": best_node.id if best_node else None,
            "head_node_id": head.id if head else None,
            "tip_node_ids": tips,
        },
        "nodes": serialized_nodes,
    }

    canonical = json.dumps(digest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest["digest_hash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    digest["digest_text"] = _render_digest_text(digest, position_by_id)
    return digest


def _render_digest_text(digest: dict[str, Any], position_by_id: dict[str, str]) -> str:
    tree = digest["tree"]
    stats = digest["stats"]
    lines = [
        "# DEEPSEEK HARNESS TREE DIGEST",
        f"tree {tree['name']} ({tree['id']}) | {stats['total_nodes']} nodes | "
        f"hash {digest['digest_hash'][:12]}",
        f"status {tree['status']} | root {position_by_id.get(tree['root_node_id'], 'none')} | "
        f"head {position_by_id.get(stats['head_node_id'], 'none')} | "
        f"tips {len(stats['tip_node_ids'])}",
        f"nodes: {stats['complete_nodes']} complete | {stats['failed_nodes']} failed | "
        f"{stats['pending_nodes']} pending | {stats['running_nodes']} running | "
        f"best score {stats['best_score']}",
    ]
    benchmark = digest.get("benchmark")
    if benchmark:
        lines.append(
            f"benchmark {benchmark['name']} v{benchmark['version']} | "
            f"{benchmark['scenario_count']} scenarios"
        )
    lines.append("")
    for node in digest["nodes"]:
        parent = node["parent_position"] or "root"
        score = "-" if node["score"] is None else str(node["score"])
        lines.append(
            f"{node['position']} {node['status']} score={score} parent={parent} "
            f"children={len(node['children'])}"
        )
        harness = node["harness"]
        if isinstance(harness, dict):
            harness_name = harness.get("name") or harness.get("model") or "unnamed"
            lines.append(
                f"  harness={harness_name} tools={len(harness.get('tools', []))} "
                f"policy_items={len(harness.get('policy', []))}"
            )
        if node["rationale"]:
            lines.append(f"  rationale: {node['rationale']}")
        result = node["benchmark_result"]
        if result and result.get("failed_scenarios"):
            failed_ids = [
                (
                    item.get("scenario_id", item.get("id", "unknown"))
                    if isinstance(item, dict)
                    else str(item)
                )
                for item in result["failed_scenarios"]
            ]
            lines.append(f"  failed scenarios: {', '.join(map(str, failed_ids))}")
    return "\n".join(lines)
