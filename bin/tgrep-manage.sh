#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../config.json"

# Load workspaces from SOURCE_DIRS env, or config.json, or SOURCE_DIR, or parent of project
if [[ -z "$SOURCE_DIRS" && -z "$SOURCE_DIR" && -f "$CONFIG_FILE" ]]; then
  SOURCE_DIRS=$(jq -r '.workspaces // [] | join(",")' "$CONFIG_FILE" 2>/dev/null || echo "")
fi

RAW_DIRS="${SOURCE_DIRS:-${SOURCE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}}"
IFS=',:' read -ra WORKSPACES <<< "$RAW_DIRS"

resolve_path() {
  local p="${1:-.}"
  if [[ "$p" != /* ]]; then
    for ws in "${WORKSPACES[@]}"; do
      ws="$(echo "$ws" | xargs)"
      if [[ -n "$ws" && -d "$ws/$p" ]]; then
        p="$ws/$p"
        break
      fi
    done
    if [[ "$p" != /* ]]; then
      p="$(pwd)/$p"
    fi
  fi
  (cd "$p" 2>/dev/null && pwd) || echo "$p"
}

is_running() {
  local target="$1"
  local sjson="$target/.tgrep/serve.json"
  if [[ -f "$sjson" ]]; then
    local pid
    pid=$(jq -r '.pid // empty' "$sjson" 2>/dev/null || grep -o '"pid":[0-9]*' "$sjson" | cut -d: -f2)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    else
      rm -f "$sjson" "$target/.tgrep/serve.lock"
    fi
  fi
  return 1
}

cmd_list() {
  echo "=========================================================================================="
  printf "%-25s | %-12s | %-18s | %-10s\n" "PROJECT" "INDEXED" "SERVER STATUS" "PORT/PID"
  echo "=========================================================================================="

  for ws in "${WORKSPACES[@]}"; do
    ws="$(echo "$ws" | xargs)"
    [[ -n "$ws" && -d "$ws" ]] || continue

    if [[ ${#WORKSPACES[@]} -gt 1 ]]; then
      echo "--- Workspace: $ws ---"
    fi

    for d in "$ws"/*; do
      if [[ -d "$d" && ! "$(basename "$d")" =~ ^\. ]]; then
        local name
        name="$(basename "$d")"
        local indexed="No"
        local sstatus="Stopped"
        local detail="-"

        if [[ -d "$d/.tgrep" ]]; then
          indexed="Yes"
          local pid
          if pid=$(is_running "$d"); then
            local port
            port=$(jq -r '.port // empty' "$d/.tgrep/serve.json" 2>/dev/null || grep -o '"port":[0-9]*' "$d/.tgrep/serve.json" | cut -d: -f2)
            sstatus="Running"
            detail=":${port} (PID:${pid})"
          fi
        fi
        printf "%-25s | %-12s | %-18s | %-10s\n" "$name" "$indexed" "$sstatus" "$detail"
      fi
    done
  done
  echo "=========================================================================================="
}

cmd_index() {
  local target
  target="$(resolve_path "$1")"
  if [[ ! -d "$target" ]]; then
    echo "Error: Directory not found: $target" >&2
    exit 1
  fi
  echo "==> Building trigram index for: $target"
  (cd "$target" && tgrep index .)
}

cmd_start() {
  local target
  target="$(resolve_path "$1")"
  if [[ ! -d "$target" ]]; then
    echo "Error: Directory not found: $target" >&2
    exit 1
  fi

  if pid=$(is_running "$target"); then
    echo "Server is already running for $target (PID: $pid)"
    return 0
  fi

  if [[ ! -d "$target/.tgrep" ]]; then
    echo "==> No index found. Building index first..."
    cmd_index "$target"
  fi

  echo "==> Starting tgrep serve for $target..."
  mkdir -p "$target/.tgrep"
  rm -f "$target/.tgrep/serve.json" "$target/.tgrep/serve.lock"

  cd "$target"
  nohup setsid tgrep serve . </dev/null > "$target/.tgrep/serve.log" 2>&1 &
  disown

  local max_wait=30
  local count=0
  while [[ $count -lt $max_wait ]]; do
    if [[ -f "$target/.tgrep/serve.json" ]]; then
      local port pid
      pid=$(jq -r '.pid // empty' "$target/.tgrep/serve.json" 2>/dev/null || grep -o '"pid":[0-9]*' "$target/.tgrep/serve.json" | cut -d: -f2)
      port=$(jq -r '.port // empty' "$target/.tgrep/serve.json" 2>/dev/null || grep -o '"port":[0-9]*' "$target/.tgrep/serve.json" | cut -d: -f2)
      if [[ -n "$pid" && -n "$port" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "✓ Server successfully started!"
        echo "  Project : $target"
        echo "  PID     : $pid"
        echo "  Port    : $port"
        return 0
      fi
    fi
    sleep 0.1
    count=$((count + 1))
  done

  echo "Warning: Server started but serve.json was not generated immediately. Check $target/.tgrep/serve.log"
}

cmd_stop() {
  local target
  target="$(resolve_path "$1")"
  if [[ ! -d "$target" ]]; then
    echo "Error: Directory not found: $target" >&2
    exit 1
  fi

  local pid
  if pid=$(is_running "$target"); then
    echo "==> Stopping tgrep serve for $target (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$target/.tgrep/serve.json" "$target/.tgrep/serve.lock"
    echo "✓ Stopped."
  else
    echo "No running server detected for $target."
    rm -f "$target/.tgrep/serve.json" "$target/.tgrep/serve.lock"
  fi
}

cmd_restart() {
  cmd_stop "$1"
  sleep 0.5
  cmd_start "$1"
}

cmd_status() {
  local target
  target="$(resolve_path "$1")"
  if [[ ! -d "$target" ]]; then
    echo "Error: Directory not found: $target" >&2
    exit 1
  fi
  (cd "$target" && tgrep status .)
}

usage() {
  echo "Usage: $0 {list|index|start|stop|restart|status} [project_path]"
  echo ""
  echo "Commands:"
  echo "  list               List all projects in $SOURCE_DIR with index & server status"
  echo "  index [path]       Build or rebuild trigram index (defaults to current dir)"
  echo "  start [path]       Start tgrep serve background daemon for the project"
  echo "  stop  [path]       Stop tgrep serve background daemon for the project"
  echo "  restart [path]     Restart tgrep serve daemon"
  echo "  status [path]      Show detailed tgrep status for the project"
  echo ""
  echo "Examples:"
  echo "  $0 list"
  echo "  $0 start my-service"
  echo "  $0 status /path/to/my-project"
  echo "  $0 stop my-service"
}

case "$1" in
  list)
    cmd_list
    ;;
  index)
    cmd_index "$2"
    ;;
  start)
    cmd_start "$2"
    ;;
  stop)
    cmd_stop "$2"
    ;;
  restart)
    cmd_restart "$2"
    ;;
  status)
    cmd_status "$2"
    ;;
  *)
    usage
    exit 1
    ;;
esac
