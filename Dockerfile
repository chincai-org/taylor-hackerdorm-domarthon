FROM python:3.14-slim

WORKDIR /app

# Provision requisite system dependencies, Node.js, and the DeepSeek Harness ecosystem
RUN apt-get update && \
    apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install @cordisjs/plugin-logger \
                @deepseek-ai/dsh-plugin-fs \
                @deepseek-ai/dsh-plugin-web-search \
                @cordisjs/plugin-database-postgres \
                @cordisjs/plugin-mailer \
                dsh-plugin-taskboard && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Step 1: Install third-party dependencies only (cached layer)
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && \
    uv export --frozen --format requirements-txt -o requirements.txt && \
    uv pip install --system -r requirements.txt

# Step 2: Copy full source code (no separate package install needed:
# pyproject sets `package = false`, so there is nothing to build/install)
COPY . .

# Runtime config is validated by start.sh from env vars,
# so secrets never bake into the image. See start.sh for details.
RUN chmod +x /app/start.sh

# Establish the operational port for dynamic platform injection
ENV PORT=5001 \
    PYTHONUNBUFFERED=1
CMD ["/app/start.sh"]
