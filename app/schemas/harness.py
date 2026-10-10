"""Legacy harness schema (pre-dsh).

Kept for back-compat only. New code stores the dsh patch-layer harness
(``app/harness/dsh.py``: ``{version, kind, profile, dsh_plugins}``) and
accepts raw ``cordis.patch.yml`` text via
``app/harness/importer.coerce_harness``. The MCP optimizer and the
``/deepseek/*`` routes no longer use this schema.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DeepSeekToolSpec(BaseModel):
    """A tool exposed to the customer-support agent in a DeepSeek harness."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    signature: str = Field(min_length=1)
    description: str = ""

    @field_validator("name", "signature")
    @classmethod
    def reject_blank_values(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value


class DeepSeekHarness(BaseModel):
    """Legacy harness shape (pre-dsh, JSON-native for SQLAlchemy).

    Kept for back-compat only; the optimizer MCP and ``/deepseek/*`` routes
    use raw dsh ``cordis.patch.yml`` text instead.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    system_prompt: str = Field(min_length=1)
    tools: list[DeepSeekToolSpec] = Field(default_factory=list)
    policy: list[str] = Field(default_factory=list)
    settings: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name", "system_prompt")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("policy")
    @classmethod
    def reject_blank_policy_items(cls, value: list[str]) -> list[str]:
        cleaned = [item.strip() for item in value]
        if any(not item for item in cleaned):
            raise ValueError("policy entries must not be blank")
        return cleaned


def validate_deepseek_harness(value: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a client-provided harness for persistence."""
    return DeepSeekHarness.model_validate(value).model_dump(mode="json")
