from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings

from app.core.config import settings

mcp_server = MCPServer(
    name=settings.PROJECT_NAME,
    version=settings.VERSION,
    instructions="Customer support tools exposed through the Model Context Protocol.",
)


@mcp_server.tool()
def get_support_item(item_id: int) -> dict[str, int | str]:
    """Return a sample support item by ID."""
    return {
        "id": item_id,
        "name": f"Sample Item {item_id}",
        "value": item_id * 100,
    }


mcp_app = mcp_server.streamable_http_app(
    streamable_http_path="/",
    stateless_http=True,
    # Vercel serves this app under rotating hostnames (per-deployment URLs
    # plus the production alias), which cannot be statically allowlisted.
    # The SDK's DNS-rebinding protection rejects non-localhost Host headers
    # with 421 "Invalid Host header" otherwise.
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ),
)
