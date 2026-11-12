#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Measures how fast each toolkit actually scrolls for autoscroll's scroll
# events, compared with Edge/Chrome on Windows. Needs the shell started with
# AUTOSCROLL_TEST_X11=1 for the x11 rows.  Usage: calibrate.sh [DISTANCE] [SPECS...]
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
dist=${1:-200}; shift || true
specs=("$@")
[ ${#specs[@]} -gt 0 ] || specs=("gtk4 wayland" "gtk3 wayland" "qt6 wayland" "qt5 wayland" "gtk4 x11" "gtk3 x11" "qt6 x11" "swing x11")
for spec in "${specs[@]}"; do
    read -r kind platform <<< "$spec"
    title="T-$kind-$platform"
    scripts/test/launch-client.sh "$kind" "$platform" "$title" "$DIR/$title.log" || continue
    sleep 1.5
    printf '%-14s ' "$kind/$platform"
    scripts/test/measure.sh "$DIR/$title.log" FINGER "$dist" 1.0 "$title" 2>&1 | tail -1
    scripts/test/headless.sh eval "AS.window('$title')?.delete(global.get_current_time()); 'closed'" > /dev/null
    sleep 0.5
done
