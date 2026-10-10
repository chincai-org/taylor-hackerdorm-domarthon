from collections.abc import Iterable
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.db.engine import session_scope
from app.db.models import Benchmark, Node, Tree
from app.db.repository import (
    get_benchmark,
    get_tree,
    list_trees,
)
from app.services.tree_creation import create_tree_with_default_harness

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


class ScenarioRequest(BaseModel):
    scenario: dict[str, Any] = Field(min_length=1)


def _benchmark_payload(benchmark: Benchmark) -> dict[str, Any]:
    return {
        "id": benchmark.id,
        "name": benchmark.name,
        "version": benchmark.version,
        "scenarios": benchmark.scenarios,
    }


def _get_tree_benchmark(session, tree_id: str) -> tuple[Tree, Benchmark]:
    tree = get_tree(session, tree_id)
    benchmark = get_benchmark(session, tree_id=tree_id) if tree else None
    if tree is None:
        raise HTTPException(status_code=404, detail="Tree not found")
    if benchmark is None:  # pragma: no cover - benchmark is required by the schema
        raise HTTPException(status_code=404, detail="Benchmark not found")
    return tree, benchmark


def _scenario_id(scenario: dict[str, Any]) -> str | None:
    value = scenario.get("id") or scenario.get("scenario_id")
    return str(value).strip() if value is not None and str(value).strip() else None


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
    try:
        with session_scope() as session:
            # Root node is a baseline: score 0 + complete, no judge call.
            # Benchmark stays reserved for DB scenarios (empty until added
            # below via /benchmark/scenarios); real scoring happens on child
            # nodes once scenarios exist.
            created = create_tree_with_default_harness(session, request)
            return created
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
                session.query(Node).filter(Node.tree_id == tree.id).order_by(Node.created_at)
            )
            result.append(_tree(tree, nodes, get_benchmark(session, tree_id=tree.id)))
        return {"data": result, "total": len(result)}


@router.get("/{tree_id}")
def read_tree(tree_id: str) -> dict[str, Any]:
    with session_scope() as session:
        tree = get_tree(session, tree_id)
        if tree is None:
            raise HTTPException(status_code=404, detail="Tree not found")
        nodes = list(session.query(Node).filter(Node.tree_id == tree.id).order_by(Node.created_at))
        return _tree(tree, nodes, get_benchmark(session, tree_id=tree.id))


@router.post("/{tree_id}/benchmark/scenarios", status_code=201)
def create_scenario(tree_id: str, request: ScenarioRequest) -> dict[str, Any]:
    with session_scope() as session:
        _, benchmark = _get_tree_benchmark(session, tree_id)
        scenario = dict(request.scenario)
        scenario_id = _scenario_id(scenario) or str(uuid4())
        scenarios = list(benchmark.scenarios or [])
        if any(_scenario_id(item) == scenario_id for item in scenarios if isinstance(item, dict)):
            raise HTTPException(status_code=409, detail="Scenario ID already exists")
        scenario["id"] = scenario_id
        scenarios.append(scenario)
        benchmark.scenarios = scenarios
        benchmark.version += 1
        session.flush()
        return {"benchmark": _benchmark_payload(benchmark), "scenario": scenario}


@router.put("/{tree_id}/benchmark/scenarios/{scenario_id}")
def update_scenario(tree_id: str, scenario_id: str, request: ScenarioRequest) -> dict[str, Any]:
    with session_scope() as session:
        _, benchmark = _get_tree_benchmark(session, tree_id)
        scenarios = list(benchmark.scenarios or [])
        for index, existing in enumerate(scenarios):
            if isinstance(existing, dict) and _scenario_id(existing) == scenario_id:
                scenario = dict(request.scenario)
                scenario["id"] = scenario_id
                scenarios[index] = scenario
                benchmark.scenarios = scenarios
                benchmark.version += 1
                session.flush()
                return {"benchmark": _benchmark_payload(benchmark), "scenario": scenario}
        raise HTTPException(status_code=404, detail="Scenario not found")


@router.delete("/{tree_id}/benchmark/scenarios/{scenario_id}")
def delete_scenario(tree_id: str, scenario_id: str) -> dict[str, Any]:
    with session_scope() as session:
        _, benchmark = _get_tree_benchmark(session, tree_id)
        scenarios = list(benchmark.scenarios or [])
        remaining = [
            item
            for item in scenarios
            if not (isinstance(item, dict) and _scenario_id(item) == scenario_id)
        ]
        if len(remaining) == len(scenarios):
            raise HTTPException(status_code=404, detail="Scenario not found")
        benchmark.scenarios = remaining
        benchmark.version += 1
        session.flush()
        return {"benchmark": _benchmark_payload(benchmark)}
