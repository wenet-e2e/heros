#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use default >/dev/null 2>&1 || true
fi

case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)
    PLATFORM="windows"
    export WINDIR="${WINDIR:-/mnt/c/WINDOWS}"
    export windir="${windir:-$WINDIR}"
    export SystemRoot="${SystemRoot:-$WINDIR}"
    ;;
  *)      echo "[HerOS] Unsupported OS: $(uname -s)"; exit 1 ;;
esac
echo "[HerOS] Detected platform: $(uname -s) → target: ${PLATFORM}"

NODE_VERSION="$(node --version | sed 's/^v//')"
MIN_NODE="20.19.4"
if [[ "${PLATFORM}" == "windows" ]]; then
  MIN_NODE="22.0.0"
fi

ver_ge() { printf '%s\n%s' "$2" "$1" | sort -V -C; }
if ! ver_ge "${NODE_VERSION}" "${MIN_NODE}"; then
  echo "[HerOS] Node ${NODE_VERSION} is too old. ${PLATFORM} target requires Node >= ${MIN_NODE}"
  exit 1
fi

if [[ -f ".env.local" ]]; then
  echo "[HerOS] Loading environment from .env.local ..."
  set -a
  # shellcheck disable=SC1091
  source ".env.local"
  set +a
else
  echo "[HerOS] .env.local not found, running without local env file."
fi

echo "[HerOS] Stopping existing Metro on port 8081 (if any)..."
EXISTING_PIDS="$(lsof -ti tcp:8081 -sTCP:LISTEN || true)"
if [[ -n "${EXISTING_PIDS}" ]]; then
  kill ${EXISTING_PIDS} || true
  sleep 1
fi

if pgrep -x "heros" >/dev/null 2>&1; then
  echo "[HerOS] Quitting existing app process..."
  pkill -x heros || true
fi

echo "[HerOS] Starting Metro with cache reset..."
npm run start -- --reset-cache > .metro.log 2>&1 &
METRO_PID=$!

echo "[HerOS] Waiting for Metro (http://localhost:8081)..."
METRO_READY=0
for _ in {1..30}; do
  if lsof -ti tcp:8081 -sTCP:LISTEN >/dev/null 2>&1; then
    METRO_READY=1
    break
  fi
  sleep 1
done

if [[ "${METRO_READY}" -ne 1 ]]; then
  echo "[HerOS] Metro failed to start. Check .metro.log"
  if kill -0 "${METRO_PID}" >/dev/null 2>&1; then
    kill "${METRO_PID}" || true
  fi
  exit 1
fi

echo "[HerOS] Metro is ready. Launching ${PLATFORM} app..."
if [[ "${PLATFORM}" == "windows" ]]; then
  echo "[HerOS] Metro is running on http://localhost:8081"
  echo "[HerOS] To launch the Windows app, run from a Windows PowerShell/CMD:"
  echo "       npx @react-native-community/cli run-windows"
  echo "[HerOS] If build tools are missing, run (Admin PowerShell):"
  echo "       .\\node_modules\\react-native-windows\\scripts\\rnw-dependencies.ps1"
else
  npm run "${PLATFORM}"
fi
