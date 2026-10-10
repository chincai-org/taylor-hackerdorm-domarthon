from mcp.server.mcpserver import MCPServer

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
)
