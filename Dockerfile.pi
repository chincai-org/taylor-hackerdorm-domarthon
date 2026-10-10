FROM python:3.14-slim

# Provision Node.js 20 and system utilities
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install the Pi Coding Agent, prioritizing the maintained fork
RUN npm install -g @earendil-works/pi-coding-agent || npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

# Step 1: Install third-party dependencies only (cached layer)
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && \
    uv export --frozen --format requirements-txt -o requirements.txt && \
    uv pip install --system --no-deps -r requirements.txt

# Step 2: Copy full source code (no separate package install needed:
# pyproject sets `package = false`, so there is nothing to build/install)
COPY . .

# Generate a startup script to construct models.json with runtime environment variables
RUN echo '#!/bin/sh\n\
mkdir -p /root/.pi/agent\n\
cat <<EOF > /root/.pi/agent/models.json\n\
{\n\
  "providers": {\n\
    "grafilab": {\n\
      "baseUrl": "https://llm.grafilab.ai/v1",\n\
      "api": "openai-completions",\n\
      "apiKey": "${GRAFILAB_API_KEY}",\n\
      "compat": {\n\
        "supportsDeveloperRole": false,\n\
        "supportsReasoningEffort": false\n\
      }\n\
    }\n\
  }\n\
}\n\
EOF\n\
exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-5001}' > /app/start.sh && chmod +x /app/start.sh

# Establish the operational port for dynamic platform injection
ENV PORT=5001
CMD ["/app/start.sh"]
