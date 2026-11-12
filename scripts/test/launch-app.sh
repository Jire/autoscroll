#!/usr/bin/env bash
# Starts the GTK test app inside the headless shell: launch-app.sh TITLE LOGFILE
set -euo pipefail
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
# shellcheck disable=SC1091
. "$DIR/env"
cd "$(dirname "$0")/../.."
setsid gjs -m scripts/test/test-app.js "$1" > "$2" 2>&1 &
echo $! >> "$DIR/apps.pids"
for _ in $(seq 50); do grep -q '"ready"' "$2" 2>/dev/null && exit 0; sleep 0.1; done
echo "test app didn't start" >&2; cat "$2" >&2; exit 1
