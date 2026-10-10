"""Harness upload/download: real dsh material in and out."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.harness.dsh import example_verifiable_harness, to_cordis_patch_yml
from app.harness.importer import import_harness

router = APIRouter(prefix="/harness", tags=["harness"])


class ImportRequest(BaseModel):
    content: str = Field(
        min_length=1,
        description="Raw text: `dsh --profile <name> --dump-config` output (JSON/YAML) "
        "or a cordis.yml / cordis.patch.yml document",
    )
    profile: str | None = Field(
        default=None, description="Profile the dump came from (else read from doc, else headless)"
    )


class ImportResponse(BaseModel):
    harness: str
    kept: list[str] = Field(default_factory=list)
    dropped: list[dict[str, str]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ExportResponse(BaseModel):
    profile: str
    patch_yml: str


@router.get("/example", response_model=ImportResponse)
def example_harness_endpoint() -> ImportResponse:
    """Fetch a minimal harness with one verifiable plugin (dsh-persona).

    Pass the returned ``harness`` to ``POST /deepseek/chat`` and check the
    reply starts with ``VERIFIED`` — proves the per-call plugin path works.
    """
    from app.harness.dsh import validate_dsh_harness

    harness = example_verifiable_harness()
    validate_dsh_harness(harness)
    return ImportResponse(
        harness=to_cordis_patch_yml(harness),
        kept=["persona"],
        dropped=[],
        warnings=[],
    )


@router.post("/import", response_model=ImportResponse)
def import_harness_endpoint(req: ImportRequest) -> ImportResponse:
    """Upload current dsh config; get back harness text for Nodes and /deepseek/*."""
    try:
        result = import_harness(req.content, profile=req.profile)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return ImportResponse(
        harness=to_cordis_patch_yml(result["harness"]),
        kept=result["kept"],
        dropped=result["dropped"],
        warnings=result["warnings"],
    )


@router.post("/export", response_model=ExportResponse)
def export_harness_endpoint(harness: str) -> ExportResponse:
    """Validate stored harness text and return it as cordis.patch.yml."""
    try:
        from app.harness.importer import coerce_harness

        normalized, _ = coerce_harness(harness)
        if normalized is None:
            raise ValueError("harness must be non-empty text")
        yml = to_cordis_patch_yml(normalized)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    profile = normalized["profile"]
    return ExportResponse(profile=profile, patch_yml=yml)
