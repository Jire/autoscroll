#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Records docs/demo.gif: autoscrolls scripts/demo/demo.html in Firefox inside a
# headless GNOME Shell (see scripts/test/headless.sh). Needs Firefox and Pillow.
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
# The monitor is the size of the recording; Firefox fills it in kiosk mode.
scripts/test/headless.sh start 1040x640 > /dev/null
scripts/test/headless.sh eval '(() => { AS.engine()._settings.set_boolean("debug", false); return "ok"; })()' > /dev/null
KIOSK=1 PAGE="file://$PWD/scripts/demo/demo.html" scripts/test/launch-browser.sh firefox
sleep 10
export DEMO_DIR="$DIR/demo"
rm -rf "$DEMO_DIR" && mkdir -p "$DEMO_DIR"
# The shell reads DEMO_DIR from its own environment, so pass it in the script.
scripts/test/headless.sh eval "GLib.setenv('DEMO_DIR', '$DEMO_DIR', true);
$(cat scripts/demo/record.js)" > "$DEMO_DIR/frames.json"
python3 scripts/demo/make-gif.py "$DEMO_DIR/frames.json" docs/demo.gif
