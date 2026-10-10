import os
from urllib.parse import urlparse

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


mcp_app = mcp_server.streamable_http_app(
    streamable_http_path="/",
    stateless_http=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    ),
)
