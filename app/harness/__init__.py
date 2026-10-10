"""Harness package: DeepSeek Harness (dsh) plugin configs stored in Node.harness."""

from app.harness.dsh import (
    LEGACY_HARNESS_KINDS,
    SUPPORTED_DSH_PLUGINS,
    default_customer_support_harness,
    default_harness,
    example_verifiable_harness,
    harness_diff,
    is_generic_plugin,
    list_supported_plugins,
    resolve_runtime,
    to_cordis_patch_yml,
    validate_dsh_harness,
)
from app.harness.importer import coerce_harness, import_harness

__all__ = [
    "LEGACY_HARNESS_KINDS",
    "SUPPORTED_DSH_PLUGINS",
    "coerce_harness",
    "default_customer_support_harness",
    "default_harness",
    "example_verifiable_harness",
    "harness_diff",
    "import_harness",
    "is_generic_plugin",
    "list_supported_plugins",
    "resolve_runtime",
    "to_cordis_patch_yml",
    "validate_dsh_harness",
]
