#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# launch-client.sh gtk4|gtk3|qt6|qt5|swing wayland|x11 TITLE LOGFILE
set -euo pipefail
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
# shellcheck disable=SC1091
. "$DIR/env"
cd "$(dirname "$0")"
kind=$1 platform=$2 title=$3 log=$4
if [ "$platform" = x11 ]; then
    export DISPLAY=${TEST_X11_DISPLAY:?start the shell with AUTOSCROLL_TEST_X11=1}
    export XAUTHORITY=$TEST_XAUTHORITY
    export GDK_BACKEND=x11 QT_QPA_PLATFORM=xcb
    unset WAYLAND_DISPLAY
else
    export QT_QPA_PLATFORM=wayland
fi
case "$kind" in
gtk4) cmd=(gjs -m test-app.js "$title") ;;
gtk3) cmd=(gjs clients/gtk3.js "$title") ;;
qt6) cmd=(python3 clients/qt.py "$title") ;;
qt5) export QT_API=5; cmd=(python3 clients/qt.py "$title") ;;
swing) cmd=(java clients/SwingTest.java "$title") ;;
*) echo "unknown client $kind" >&2; exit 1 ;;
esac
setsid "${cmd[@]}" > "$log" 2>&1 &
echo $! >> "$DIR/apps.pids"
for _ in $(seq 100); do grep -q '"ready"' "$log" 2>/dev/null && exit 0; sleep 0.1; done
echo "client didn't start:" >&2; cat "$log" >&2; exit 1
