#!/usr/bin/env bash
# Start Paper Reader locally with env from .env.local
#
# First time:
#   cp .env.local.example .env.local
#   # edit .env.local — paste keys from Vercel or Supabase dashboard
#   ./start-local.sh
#
# Then open http://localhost:3000

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=""
for candidate in .env.local .env; do
  if [[ -f "$candidate" ]]; then
    ENV_FILE="$candidate"
    break
  fi
done

if [[ -z "$ENV_FILE" ]]; then
  echo ""
  echo "  No .env.local found."
  echo ""
  echo "  Setup (once):"
  echo "    cp .env.local.example .env.local"
  echo "    # edit .env.local — add ANTHROPIC_API_KEY (+ optional Supabase)"
  echo ""
  echo "  Keys live in Vercel → paper-reader → Settings → Environment Variables"
  echo "  Supabase URL: https://pmyodrwlvbqbukirecjh.supabase.co"
  echo ""
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
echo "  ✓ Loaded $ENV_FILE"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "  ⚠️  ANTHROPIC_API_KEY missing — chat will error (PDF/URL load still works)"
fi
if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_ANON_KEY:-}" ]]; then
  echo "  ℹ️  Supabase not configured — browser-only storage"
elif [[ "${SUPABASE_ANON_KEY}" == *"your-"* || ${#SUPABASE_ANON_KEY} -lt 40 ]]; then
  echo "  ⚠️  SUPABASE_ANON_KEY looks like a placeholder — cloud sync will show \"Invalid API key\""
  echo "     Paste the anon/public key from Supabase → Settings → API into .env.local"
fi

export PORT="${PORT:-3000}"
echo ""
exec node dev-server.js
