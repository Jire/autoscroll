#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# Opens scripts/test/page.html in Firefox or Chromium inside the headless shell,
# with a throwaway profile and background network services turned off.
#
#   scripts/test/launch-browser.sh firefox|chromium [x11]   (x11 needs AUTOSCROLL_TEST_X11=1)
set -euo pipefail
DIR=${AUTOSCROLL_TEST_DIR:-/run/user/$(id -u)/autoscroll-test}
# shellcheck disable=SC1091
. "$DIR/env"
cd "$(dirname "$0")"
page=${PAGE:-"file://$PWD/page.html"}

if [ "${2:-}" = x11 ]; then
    export DISPLAY=${TEST_X11_DISPLAY:?start the shell with AUTOSCROLL_TEST_X11=1}
    export XAUTHORITY=$TEST_XAUTHORITY GDK_BACKEND=x11 MOZ_ENABLE_WAYLAND=0
fi

case "$1" in
firefox)
    profile="$DIR/firefox-profile"
    mkdir -p "$profile"
    cat > "$profile/user.js" <<'PREFS'
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.normandy.enabled", false);
user_pref("app.update.auto", false);
user_pref("browser.safebrowsing.malware.enabled", false);
user_pref("browser.safebrowsing.phishing.enabled", false);
user_pref("browser.safebrowsing.downloads.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("extensions.update.enabled", false);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.region.update.enabled", false);
user_pref("browser.search.update", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("general.autoScroll", false);
PREFS
    # KIOSK=1: full screen, no toolbars (used for the README demo).
    kiosk=()
    [ "${KIOSK:-}" = 1 ] && kiosk=(--kiosk)
    MOZ_ENABLE_WAYLAND=${MOZ_ENABLE_WAYLAND:-1} setsid firefox --no-remote --profile "$profile" "${kiosk[@]}" --new-window "$page" \
        > "$DIR/firefox.log" 2>&1 &
    ;;
chromium)
    platform=wayland
    [ "${2:-}" = x11 ] && platform=x11
    setsid chromium --user-data-dir="$DIR/chromium-profile" --no-first-run --no-default-browser-check \
        --ozone-platform="$platform" --password-store=basic --disable-background-networking \
        --disable-component-update --disable-sync --no-pings --disable-domain-reliability \
        --disable-features=Translate,MediaRouter,OptimizationHints --new-window "$page" \
        > "$DIR/chromium.log" 2>&1 &
    ;;
*) echo "usage: $0 firefox|chromium [x11]" >&2; exit 1 ;;
esac
echo $! >> "$DIR/apps.pids"
