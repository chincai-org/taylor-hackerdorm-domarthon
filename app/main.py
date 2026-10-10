from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.api.main import api_router
from app.core.config import settings
from app.mcp_server import mcp_app


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    async with mcp_app.router.lifespan_context(mcp_app):
        yield


app = FastAPI(
    title=settings.PROJECT_NAME,
    description=settings.PROJECT_NAME,
    version=settings.VERSION,
    lifespan=lifespan,
)

app.include_router(api_router, prefix=settings.API_V1_STR)
app.mount("/mcp", mcp_app)
app.mount(
    "/trees",
    StaticFiles(directory=Path(__file__).parent.parent / "frontend" / "trees-section"),
    name="trees",
)

templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


@app.get("/", response_class=HTMLResponse)
def read_root(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/tree/{tree_id}", response_class=HTMLResponse)
def read_tree_page(request: Request, tree_id: str):
    return templates.TemplateResponse(
        request,
        "tree.html",
        {
            "tree_id": tree_id,
            "tree_api_url": f"{settings.API_V1_STR}/trees/{quote(tree_id, safe='')}",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=5001, reload=True)
