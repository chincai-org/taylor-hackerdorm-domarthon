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
    """The only harness shape accepted by the optimizer MCP.

    This mirrors ``pi_harness.models.HarnessConfig`` while keeping the persisted
    value JSON-native for SQLAlchemy and the DeepSeek client.
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
