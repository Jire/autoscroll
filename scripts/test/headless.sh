#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Runs GNOME Shell headless, on its own private D-Bus session and with its own
# settings and data folders, with this checkout of Autoscroll installed. Lets
# you test changes without touching the desktop you're using.
#
#   scripts/test/headless.sh start [WxH]   start (or restart) it, default 1600x1000
#   scripts/test/headless.sh eval 'JS'     run JavaScript inside it and print the result
#   scripts/test/headless.sh run CMD...    run a command (an app) inside it
#   scripts/test/headless.sh log           show GNOME Shell's output
#   scripts/test/headless.sh stop
#
# Eval runs with Main, Meta, Shell, GLib and Gio in scope; scripts/test/driver.js
# adds an `AS` helper for synthetic mouse and keyboard input.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
DISPLAY_NAME=wayland-autoscroll-test
UUID=autoscroll@jire.github.io
HELPER=unsafe-mode@autoscroll.test

load_env() {
    [ -f "$DIR/env" ] || { echo "not running; use: $0 start" >&2; exit 1; }
    # shellcheck disable=SC1091
    . "$DIR/env"
}

shell_eval() {
    local out code
    # gdbus parses arguments as GVariant text, so pass the code as a quoted
    # GVariant string (otherwise backslashes in it get eaten).
    code=$(python3 -c 'import sys; from gi.repository import GLib; print(GLib.Variant("s", sys.argv[1]).print_(False))' "$1")
    out=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$code" 2>&1) || { echo "$out" >&2; return 1; }
    # (true, '"result"')  ->  "result"
    python3 -c '
import sys
from gi.repository import GLib
ok, value = GLib.Variant.parse(None, sys.argv[1], None, None).unpack()
print(value)
sys.exit(0 if ok else 3)
' "$out"
}

stop() {
    if [ -f "$DIR/shell.pid" ]; then
        kill "$(cat "$DIR/shell.pid")" 2>/dev/null || true
    fi
    if [ -f "$DIR/apps.pids" ]; then
        while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$DIR/apps.pids"
    fi
    if [ -f "$DIR/bus.pid" ]; then
        kill "$(cat "$DIR/bus.pid")" 2>/dev/null || true
    fi
    sleep 0.5
    rm -rf "$DIR"
}

start() {
    local size=${1:-1600x1000}
    stop
    mkdir -p "$DIR"/{data,config,state,cache}
    local ext="$DIR/data/gnome-shell/extensions"
    mkdir -p "$ext/$HELPER"
    cp -r "$ROOT/extension" "$ext/$UUID"
    glib-compile-schemas "$ext/$UUID/schemas"

    cat > "$ext/$HELPER/metadata.json" <<'JSON'
{"uuid": "unsafe-mode@autoscroll.test", "name": "Unsafe mode (tests only)",
 "description": "Lets the test scripts use org.gnome.Shell.Eval.",
 "shell-version": ["46", "47", "48", "49", "50", "51"]}
JSON
    cat > "$ext/$HELPER/extension.js" <<'JS'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class UnsafeMode extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
JS

    # Isolate everything *before* the bus starts, so services it activates
    # inherit it too. Settings go to a keyfile instead of dconf: dconf would
    # share its database and change notifications with your real session.
    mkdir -p "$DIR/runtime"
    chmod 700 "$DIR/runtime"
    cat > "$DIR/env" <<ENV
export XDG_DATA_HOME='$DIR/data'
export XDG_CONFIG_HOME='$DIR/config'
export XDG_STATE_HOME='$DIR/state'
export XDG_CACHE_HOME='$DIR/cache'
export XDG_RUNTIME_DIR='$DIR/runtime'
export GSETTINGS_BACKEND=keyfile
export WAYLAND_DISPLAY='$DISPLAY_NAME'
export GDK_BACKEND=wayland
export GTK_A11Y=none NO_AT_BRIDGE=1
export AUTOSCROLL_TEST_DIR='$DIR'
unset DISPLAY
ENV
    load_env
    local bus
    bus=$(dbus-daemon --session --fork --print-address=1 --print-pid=1)
    echo "$bus" | sed -n 2p > "$DIR/bus.pid"
    echo "export DBUS_SESSION_BUS_ADDRESS='$(echo "$bus" | sed -n 1p)'" >> "$DIR/env"
    load_env
    [ "$GSETTINGS_BACKEND" = keyfile ] && [ "$XDG_CONFIG_HOME" = "$DIR/config" ] \
        || { echo "refusing to write settings outside $DIR" >&2; exit 1; }

    gsettings set org.gnome.shell enabled-extensions "['$HELPER', '$UUID']"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '9999'
    # The virtual pointer starts in the top-left corner, which would open the overview.
    gsettings set org.gnome.desktop.interface enable-hot-corners false
    gsettings set org.gnome.desktop.notifications show-banners false
    gsettings --schemadir "$ext/$UUID/schemas" set org.gnome.shell.extensions.autoscroll debug true

    # AUTOSCROLL_TEST_X11=1 also starts Xwayland, for testing X11 apps.
    local x11=--no-x11
    [ "${AUTOSCROLL_TEST_X11:-}" = 1 ] && x11=
    # shellcheck disable=SC2086
    (unset WAYLAND_DISPLAY; exec setsid gnome-shell --headless --wayland $x11 \
        --wayland-display "$DISPLAY_NAME" --virtual-monitor "$size") \
        > "$DIR/shell.log" 2>&1 &
    echo $! > "$DIR/shell.pid"

    for _ in $(seq 100); do
        if [ "$(shell_eval 'Main.layoutManager._startingUp === false' 2>/dev/null)" = true ]; then
            shell_eval 'Main.overview.hide(); "ok"' > /dev/null
            sleep 1
            shell_eval 'Main.overview.hide(); "ok"' > /dev/null
            sleep 0.5
            local xdisplay
            xdisplay=$(shell_eval 'GLib.getenv("DISPLAY") ?? ""' | tr -d '"')
            if [ -n "$xdisplay" ]; then
                echo "export TEST_X11_DISPLAY='$xdisplay'" >> "$DIR/env"
                echo "export TEST_XAUTHORITY='$(shell_eval 'GLib.getenv("XAUTHORITY") ?? ""' | tr -d '"')'" >> "$DIR/env"
            fi
            echo "GNOME Shell is running headless ($size${xdisplay:+, Xwayland $xdisplay}). Log: $DIR/shell.log"
            return 0
        fi
        sleep 0.2
    done
    echo "GNOME Shell didn't start; see $DIR/shell.log" >&2
    tail -30 "$DIR/shell.log" >&2
    return 1
}

case "${1:-}" in
start) shift; start "$@" ;;
stop) stop ;;
eval)
    load_env
    driver=$(cat "$ROOT/scripts/test/driver.js")
    shell_eval "$driver
$2" ;;
run)
    load_env; shift
    "$@" >> "$DIR/apps.log" 2>&1 &
    echo $! >> "$DIR/apps.pids"
    echo $! ;;
log) cat "$DIR/shell.log" ;;
env) load_env; cat "$DIR/env" ;;
*) sed -n '6,17p' "$0"; exit 1 ;;
esac
