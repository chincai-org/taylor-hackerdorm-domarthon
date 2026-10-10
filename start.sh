#!/bin/sh
# Railway/container entrypoint: write Pi agent config from runtime env, then start API.
# Fails loudly (not silently) when config is missing so "no respond" is debuggable.
set -u

# Accept every historical spelling of the key; canonical source is GRAPHILIB_API_KEY.
PI_API_KEY="${GRAPHILIB_API_KEY:-}"
if [ -z "$PI_API_KEY" ]; then PI_API_KEY="${GRAFILAB_API_KEY:-}"; fi
if [ -z "$PI_API_KEY" ]; then PI_API_KEY="${GRAFFILAB_API_KEY:-}"; fi
PI_MODEL_ID="${PI_MODEL:-qwen/qwen3.7-flash}"
PI_BASE_URL="${GRAFILAB_BASE_URL:-https://llm.grafilab.ai/v1}"
PI_HOME_DIR="${HOME:-/root}"
MODELS_DIR="$PI_HOME_DIR/.pi/agent"
MODELS_PATH="$MODELS_DIR/models.json"

mkdir -p "$MODELS_DIR"

if [ -z "$PI_API_KEY" ]; then
  echo "[start] WARNING: no GrafiLab API key in env (checked GRAPHILIB_API_KEY, GRAFILAB_API_KEY, GRAFFILAB_API_KEY). Pi chat will fail until one is set." >&2
fi

# Render JSON via python so special chars in the key can never break the file.
export PI_API_KEY PI_MODEL_ID PI_BASE_URL MODELS_PATH
python3 - "$MODELS_PATH" <<'PYEOF'
import json, os, sys
path = sys.argv[1]
doc = {"providers": {"grafilab": {
    "baseUrl": os.environ.get("PI_BASE_URL", "https://llm.grafilab.ai/v1"),
    "api": "openai-completions",
    "apiKey": os.environ.get("PI_API_KEY", ""),
    "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
    # A provider with no "models" list exposes ZERO models to Pi, so every
    # prompt resolves to nothing and chat returns empty. Always declare one.
    "models": [{"id": os.environ.get("PI_MODEL_ID", "qwen/qwen3.7-flash")}],
}}}
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(doc, f, indent=2)
print(f"[start] wrote {path}", flush=True)
PYEOF

echo "[start] pi config: provider=grafilab model=${PI_MODEL_ID} baseUrl=${PI_BASE_URL} key_len=${#PI_API_KEY} path=${MODELS_PATH}"

if command -v pi >/dev/null 2>&1; then
  echo "[start] pi binary: $(command -v pi)"
  # Local config read; timeout keeps a slow plugin from delaying boot.
  timeout 20 pi --list-models 2>&1 | head -30 || true
else
  echo "[start] WARNING: 'pi' binary not on PATH; /api/v1/pi/* will return 503." >&2
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-5001}"
