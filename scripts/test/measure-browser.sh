#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
#
# measure-browser.sh WMCLASS SOURCE DISTANCE SECONDS
# Autoscrolls DISTANCE px below the click for SECONDS in the browser showing
# page.html, and prints the scroll speed next to what Edge/Chrome would do,
# whether the page kept moving after autoscroll stopped, and which mouse
# events reached the page.
set -euo pipefail
cd "$(dirname "$0")/../.."
params="const P = {wmClass: '$1', source: '$2', distance: $3, seconds: $4};"
scripts/test/headless.sh eval "$params
$(cat scripts/test/measure-browser.js)" | python3 -c '
import json, sys
raw = json.loads(sys.stdin.read())
if not raw.startswith("{"):
    sys.exit(raw)
d = json.loads(raw)
dist, src = float(sys.argv[1]), sys.argv[2]
moved = d["atEnd"]["y"] - d["before"]["y"]
extra = d["after"]["y"] - d["atEnd"]["y"]
expected = 0.008 * dist ** 2.2
rate = d["steady"]
events = d["after"]["e"]
print(f"{src:10s} {rate:7.0f} px/s (Edge/Chrome {expected:4.0f}, ratio {rate / expected:4.2f}), "
      f"moved {extra:+5d}px after stopping; page events: {events!r}")
' "$3" "$2"
