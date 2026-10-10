#!/bin/sh
# Railway/container entrypoint: validate DeepSeek config, then start API.
set -u

DEEPSEEK_MODEL_ID="${DEEPSEEK_MODEL:-deepseek-chat}"
DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"
KEY_LEN=0
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then KEY_LEN=${#DEEPSEEK_API_KEY}; fi

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  echo "[start] WARNING: DEEPSEEK_API_KEY not set. /api/v1/deepseek/* will return 503." >&2
else
  echo "[start] deepseek config: model=${DEEPSEEK_MODEL_ID} baseUrl=${DEEPSEEK_BASE_URL} key_len=${KEY_LEN}"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-5001}"
