#!/bin/bash
# Watchdog / Starter for claude-max-api proxy
# Properly daemonizes using Python double-fork + setsid
# Called by cron (every 5 min) or manually

export HOME=/Users/picolbuilder
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
unset CLAUDECODE

LOG_DIR="$HOME/.openclaw/logs"
WATCHDOG_LOG="$LOG_DIR/maxproxy-watchdog.log"
mkdir -p "$LOG_DIR"

# Check if already running
if lsof -i :3456 -sTCP:LISTEN >/dev/null 2>&1; then
    exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Starting maxproxy..." >> "$WATCHDOG_LOG"

# Double-fork daemon via Python (fully detaches from parent process group)
python3 << 'PYEOF'
import os, sys

# First fork
if os.fork() > 0:
    sys.exit(0)

# New session
os.setsid()

# Second fork
if os.fork() > 0:
    sys.exit(0)

# Redirect stdio
devnull = os.open(os.devnull, os.O_RDWR)
os.dup2(devnull, 0)

log_dir = "/Users/picolbuilder/.openclaw/logs"
stdout_fd = os.open(log_dir + "/claude-max-api.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND)
stderr_fd = os.open(log_dir + "/claude-max-api.err.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND)
os.dup2(stdout_fd, 1)
os.dup2(stderr_fd, 2)

# Set env
os.environ["HOME"] = "/Users/picolbuilder"
os.environ["PATH"] = "/Users/picolbuilder/.openclaw/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
os.environ.pop("CLAUDECODE", None)
os.environ["NODE_PATH"] = "/Users/picolbuilder/.openclaw/maxproxy/node_modules"
os.environ["OPENCLAW_GATEWAY_TOKEN"] = "c2cece27f438be3eb489cbd1f3d4cbce91a9de58d32ebe59"
os.environ["OPENCLAW_GATEWAY_URL"] = "http://localhost:18789"

# Change to maxproxy dir for module resolution
os.chdir("/Users/picolbuilder/.openclaw/maxproxy")

# Exec the server
os.execv("/opt/homebrew/bin/node", [
    "node",
    "/Users/picolbuilder/.openclaw/maxproxy/dist/server/standalone.js"
])
PYEOF

sleep 3

if lsof -i :3456 -sTCP:LISTEN >/dev/null 2>&1; then
    PID=$(lsof -i :3456 -sTCP:LISTEN -t)
    echo "$(date '+%Y-%m-%d %H:%M:%S') maxproxy started (PID: $PID)" >> "$WATCHDOG_LOG"
else
    echo "$(date '+%Y-%m-%d %H:%M:%S') FAILED to start maxproxy" >> "$WATCHDOG_LOG"
    exit 1
fi
