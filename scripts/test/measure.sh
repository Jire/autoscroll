#!/usr/bin/env bash
# measure.sh APPLOG SOURCE DISTANCE SECONDS [WINDOW_TITLE]
# Autoscrolls DISTANCE px below the click for SECONDS and prints how far the
# app scrolled, in px/s, next to what Edge/Chrome would do.
set -euo pipefail
cd "$(dirname "$0")/../.."
log=$1 source=$2 dist=$3 secs=$4 title=${5:-Scroll test}
mark=$(wc -l < "$log")
scripts/test/headless.sh eval "(async () => {
    await AS.ready();
    const e = AS.engine();
    e._scrollSource = AS.Clutter.ScrollSource.$source;
    const w = AS.window('$title'); const r = w.get_frame_rect();
    w.activate(global.get_current_time());
    AS.moveTo(r.x + Math.round(r.width / 2), r.y + 250); await AS.sleep(200);
    await AS.click('middle');
    await AS.glide(0, $dist, 60, 6);
    await AS.sleep(Math.round($secs * 1000) + 300);
    await AS.click('left');
    await AS.sleep(600);
    return 'ok';
})()" > /dev/null
python3 - "$log" "$mark" "$dist" "$secs" "$source" <<'PY'
import json, sys
log, mark, dist, secs, source = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
lines = [json.loads(l) for l in open(log).read().splitlines()[mark:] if l.startswith('{')]
pos = [l for l in lines if l['ev'] == 'position']
before = [l for l in open(log).read().splitlines()[:mark] if '"position"' in l]
y0 = json.loads(before[-1])['y'] if before else 0.0
if not pos:
    print(f'{source}: no scrolling'); sys.exit()
moved = pos[-1]['y'] - y0
# Steady-state speed: the slope of the position log, skipping the first 0.3 s.
start = pos[0]['t'] + 300
steady = [p for p in pos if p['t'] >= start]
rate = (steady[-1]['y'] - steady[0]['y']) / ((steady[-1]['t'] - steady[0]['t']) / 1000) if len(steady) > 1 else 0
expected = 0.008 * dist ** 2.2
print(f'{source:10s} {rate:7.0f} px/s steady (Edge/Chrome {expected:4.0f}, ratio {rate / expected:5.2f}); total {moved:7.1f}px')
PY
