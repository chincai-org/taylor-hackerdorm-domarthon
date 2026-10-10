FROM python:3.14-slim

WORKDIR /app

# Provision requisite system dependencies, Node.js, and verified DSH plugins
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install @cordisjs/plugin-logger \
                @deepseek-ai/dsh-plugin-fs \
                @deepseek-ai/dsh-plugin-web-search \
                @deepseek-ai/dsh-mcp-client \
                dsh-plugin-shop \
                dsh-better-sidebar \
                @liustack/modlens \
                @stackstackstack/dsh-session-persistence-sqlite && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Step 1: Install third-party dependencies only (cached layer)
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && \
    uv export --frozen --format requirements-txt -o requirements.txt && \
    uv pip install --system -r requirements.txt

# Step 2: Copy full source code
COPY . .

RUN chmod +x /app/start.sh

ENV PORT=5001 \
    PYTHONUNBUFFERED=1
CMD ["/app/start.sh"]
