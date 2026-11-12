#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Opens the preferences in the headless shell and saves screenshots of them.
#   screenshot-prefs.sh OUT_PREFIX [light|dark] [SCROLL_PX]
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
out=$1 scheme=${2:-light} scroll=${3:-0}
# shellcheck disable=SC1091
. "$DIR/env"
gsettings set org.gnome.desktop.interface color-scheme "$([ "$scheme" = dark ] && echo prefer-dark || echo default)"
setsid gnome-extensions prefs autoscroll@jire.github.io > "$DIR/prefs.log" 2>&1 &
sleep 3.5
scripts/test/headless.sh eval "(async () => {
    await AS.ready();
    const w = AS.window('Autoscroll');
    w.activate(global.get_current_time());
    await AS.sleep(400);
    const r = w.get_frame_rect();
    if ($scroll) {
        AS.moveTo(r.x + r.width / 2, r.y + r.height / 2);
        await AS.sleep(150);
        for (let i = 0; i < Math.round($scroll / 50); i++) { AS.wheel(1); await AS.sleep(25); }
        await AS.sleep(500);
    }
    AS.moveTo(r.x + r.width + 40, r.y + 40);
    await AS.sleep(300);
    const shooter = new Shell.Screenshot();
    const file = Gio.File.new_for_path('$out');
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await shooter.screenshot_window(true, false, stream);
    stream.close(null);
    w.delete(global.get_current_time());
    await AS.sleep(300);
    return 'ok';
})()" > /dev/null
echo "$out"
