#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
"""End-to-end tests for Autoscroll in a headless GNOME Shell.

Starts scripts/test/headless.sh, opens the GTK 4 test app, and drives it with a
virtual mouse and keyboard. Each test checks both what the extension did and
what the app received (it logs every input event), so a middle-click leaking
through to the app is caught.

    scripts/test/run_tests.py            # all tests
    scripts/test/run_tests.py -k drag    # tests whose name contains "drag"
"""

import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR = os.environ.get('AUTOSCROLL_TEST_DIR', f'/run/user/{os.getuid()}/autoscroll-test')
HEADLESS = os.path.join(ROOT, 'scripts/test/headless.sh')
APP_LOG = os.path.join(DIR, 'tests-app.log')
SCHEMA = 'org.gnome.shell.extensions.autoscroll'
TITLE = 'Autoscroll tests'


def shell(js):
    out = subprocess.run([HEADLESS, 'eval', js], capture_output=True, text=True)
    text = out.stdout.strip()
    if out.returncode != 0:
        raise RuntimeError(f'eval failed: {text} {out.stderr.strip()}')
    value = json.loads(text) if text else None
    return json.loads(value) if isinstance(value, str) and value[:1] in '[{' else value


def reset_settings():
    shell(f"""(() => {{
        const s = Main.extensionManager.lookup('autoscroll@jire.github.io').stateObj._engine._settings;
        for (const key of s.settings_schema.list_keys())
            if (key !== 'debug') s.reset(key);
        return 'ok';
    }})()""")


def app_events_since(mark):
    with open(APP_LOG) as f:
        lines = f.read().splitlines()[mark:]
    return [json.loads(line) for line in lines if line.startswith('{')]


def app_mark():
    with open(APP_LOG) as f:
        return len(f.read().splitlines())


PRELUDE = f"""
    await AS.ready();
    const win = AS.window('{TITLE}');
    win.activate(global.get_current_time());
    await AS.sleep(150);
    const r = win.get_frame_rect();
    const cx = r.x + 450, cy = r.y + 350;
    AS.moveTo(cx, cy);
    await AS.sleep(150);
    const C = AS.Clutter;
"""


def scenario(body):
    """Runs an async JS scenario (with PRELUDE) and returns its JSON result."""
    return shell(f'(async () => {{ {PRELUDE} {body} }})()')


class Test:
    def __init__(self, name):
        self.name = name
        self.failures = []

    def check(self, condition, message):
        if not condition:
            self.failures.append(message)


def buttons(events):
    return [(e['ev'], e.get('button')) for e in events if e['ev'] in ('press', 'release')]


def scrolled(events):
    pos = [e for e in events if e['ev'] == 'position']
    return (pos[-1]['x'] - pos[0]['x'], pos[-1]['y'] - pos[0]['y']) if len(pos) > 1 else (0, 0)


def idle_state(t, state):
    t.check(state['session'] is None, f'session still active: {state["session"]}')
    t.check(state['barriers'] == 0, f'{state["barriers"]} barriers left')
    t.check(state['cursorHidden'] is False, 'cursor still hidden')
    t.check(state['grab'] is False, 'swallow grab still active')
    t.check(state['held'] == [], f'still swallowing releases of {state["held"]}')


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def sticky_click_scroll_and_click_to_stop(t):
    mark = app_mark()
    r = scenario("""
        await AS.click('middle');
        const s1 = AS.state();
        await AS.glide(0, 150, 80, 8);
        await AS.sleep(700);
        const s2 = AS.state();
        await AS.click('left');
        await AS.sleep(300);
        return JSON.stringify({s1, s2, s3: AS.state(), cx, cy});
    """)
    ev = app_events_since(mark)
    t.check(r['s1']['session'] and r['s1']['session']['state'] == 'sticky', f'not sticky after click: {r["s1"]}')
    t.check(r['s1']['cursorHidden'] and r['s1']['barriers'] == 4 and r['s1']['overlay'], 'session not set up')
    t.check(abs(r['s2']['pointer']['y'] - r['cy']) <= 2, f'pointer not pinned: {r["s2"]["pointer"]} vs {r["cy"]}')
    t.check(buttons(ev) == [], f'app received clicks: {buttons(ev)}')
    t.check(scrolled(ev)[1] > 100, f'did not scroll down enough: {scrolled(ev)}')
    idle_state(t, r['s3'])
    t.check(abs(r['s3']['pointer']['y'] - (r['cy'] + 150)) <= 3, f'pointer not moved to pan cursor: {r["s3"]["pointer"]}')


@test
def hold_drag_release(t):
    mark = app_mark()
    r = scenario("""
        AS.press('middle');
        await AS.sleep(80);
        await AS.glide(0, -150, 80, 8);
        await AS.sleep(500);
        const s1 = AS.state();
        AS.release('middle');
        await AS.sleep(300);
        return JSON.stringify({s1, s2: AS.state()});
    """)
    ev = app_events_since(mark)
    t.check(r['s1']['session'] and r['s1']['session']['state'] == 'dragging', f'not dragging: {r["s1"]}')
    t.check(buttons(ev) == [], f'app received clicks: {buttons(ev)}')
    t.check(scrolled(ev)[1] < -50, f'did not scroll up: {scrolled(ev)}')
    idle_state(t, r['s2'])


@test
def fast_press_and_move_stays_pinned(t):
    # Movement that arrives before the extension has handled the click must
    # still count, and the pointer must not escape the pin box.
    r = scenario("""
        AS.press('middle');
        for (let i = 0; i < 20; i++)
            AS.move(0, 15);
        await AS.sleep(250);
        const s1 = AS.state();
        for (let i = 0; i < 10; i++)
            AS.move(0, 15);
        await AS.sleep(250);
        const s2 = AS.state();
        AS.release('middle');
        await AS.sleep(300);
        return JSON.stringify({s1, s2, s3: AS.state(), cy});
    """)
    s1, s2 = r['s1'], r['s2']
    t.check(s2['session'] and s2['session']['state'] == 'dragging', f'not dragging: {s2}')
    t.check(abs(s2['session']['y'] - (r['cy'] + 450)) <= 6, f'lost movement: pan cursor at {s2["session"]["y"]}, expected {r["cy"] + 450}')
    t.check(abs(s2['pointer']['y'] - s1['pointer']['y']) <= 2, f'pointer escaped the pin: {s1["pointer"]} -> {s2["pointer"]}')
    idle_state(t, r['s3'])


@test
def pin_holds_in_every_direction(t):
    r = scenario("""
        AS.press('middle');
        await AS.sleep(60);
        const start = AS.state();
        const path = [[100, 0], [0, 100], [-200, 0], [0, -200], [100, 0], [0, 100], [70, 70], [-140, -140], [70, 70]];
        let maxDrift = 0;
        for (const [dx, dy] of path) {
            await AS.glide(dx, dy, 40, 8);
            const p = AS.state().pointer;
            maxDrift = Math.max(maxDrift, Math.abs(p.x - start.pointer.x), Math.abs(p.y - start.pointer.y));
        }
        await AS.sleep(150);
        const end = AS.state();
        AS.release('middle');
        await AS.sleep(300);
        return JSON.stringify({start, end, maxDrift, after: AS.state()});
    """)
    s0, s1 = r['start']['session'], r['end']['session']
    t.check(r['maxDrift'] <= 1, f'pointer drifted {r["maxDrift"]} px from the pin')
    t.check(abs(s1['x'] - s0['x']) <= 2 and abs(s1['y'] - s0['y']) <= 2, f'pan cursor did not come back: {s0} -> {s1}')
    idle_state(t, r['after'])


@test
def middle_click_again_stops(t):
    mark = app_mark()
    r = scenario("""
        await AS.click('middle');
        const s1 = AS.state();
        await AS.click('middle');
        await AS.sleep(200);
        return JSON.stringify({s1, s2: AS.state()});
    """)
    ev = app_events_since(mark)
    t.check(r['s1']['session'] is not None, 'did not start')
    t.check(buttons(ev) == [], f'app received clicks: {buttons(ev)}')
    idle_state(t, r['s2'])


@test
def dead_zone_does_not_scroll(t):
    mark = app_mark()
    scenario("""
        await AS.click('middle');
        await AS.glide(10, 12, 60, 6);
        await AS.sleep(500);
        await AS.key(C.KEY_Escape);
        await AS.sleep(200);
        return 'ok';
    """)
    ev = app_events_since(mark)
    t.check(scrolled(ev) == (0, 0), f'scrolled inside the dead zone: {scrolled(ev)}')


@test
def escape_stops_and_is_swallowed(t):
    mark = app_mark()
    r = scenario("""
        await AS.click('middle');
        await AS.key(C.KEY_Escape);
        await AS.sleep(200);
        return JSON.stringify(AS.state());
    """)
    ev = app_events_since(mark)
    idle_state(t, r)
    presses = [e for e in ev if e['ev'] == 'key-press']
    t.check(presses == [], f'app received the key press: {presses}')


@test
def wheel_stops(t):
    r = scenario("""
        await AS.click('middle');
        AS.wheel(1);
        await AS.sleep(250);
        return JSON.stringify(AS.state());
    """)
    idle_state(t, r)


@test
def ctrl_middle_click_goes_to_app(t):
    mark = app_mark()
    r = scenario("""
        await AS.keyDown(C.KEY_Control_L);
        await AS.click('middle');
        await AS.keyUp(C.KEY_Control_L);
        await AS.sleep(200);
        return JSON.stringify(AS.state());
    """)
    ev = app_events_since(mark)
    t.check(('press', 2) in buttons(ev) and ('release', 2) in buttons(ev), f'app did not get the middle-click: {buttons(ev)}')
    idle_state(t, r)


@test
def top_of_window_goes_to_app(t):
    mark = app_mark()
    r = scenario("""
        AS.moveTo(cx, r.y + 20);
        await AS.sleep(150);
        await AS.click('middle');
        await AS.sleep(200);
        return JSON.stringify(AS.state());
    """)
    ev = app_events_since(mark)
    t.check(('press', 2) in buttons(ev), f'app did not get the middle-click: {buttons(ev)}')
    idle_state(t, r)


@test
def excluded_app_goes_to_app(t):
    shell("""(() => { AS.engine()._settings.set_strv('excluded-apps', ['wmclass:test.autoscroll.*']); return 'ok'; })()""")
    try:
        mark = app_mark()
        r = scenario("""
            await AS.click('middle');
            await AS.sleep(200);
            return JSON.stringify(AS.state());
        """)
        ev = app_events_since(mark)
        t.check(('press', 2) in buttons(ev), f'app did not get the middle-click: {buttons(ev)}')
        idle_state(t, r)
    finally:
        shell("""(() => { AS.engine()._settings.reset('excluded-apps'); return 'ok'; })()""")


@test
def hold_only_mode_click_is_replayed(t):
    shell("""(() => { AS.engine()._settings.set_string('activation', 'hold'); return 'ok'; })()""")
    try:
        mark = app_mark()
        r = scenario("""
            await AS.click('middle');
            await AS.sleep(300);
            return JSON.stringify(AS.state());
        """)
        ev = app_events_since(mark)
        t.check(buttons(ev) == [('press', 2), ('release', 2)], f'app did not get exactly one middle-click: {buttons(ev)}')
        idle_state(t, r)

        mark = app_mark()
        r = scenario("""
            AS.press('middle');
            await AS.glide(0, 120, 80, 8);
            await AS.sleep(400);
            const s1 = AS.state();
            AS.release('middle');
            await AS.sleep(300);
            return JSON.stringify({s1, s2: AS.state()});
        """)
        ev = app_events_since(mark)
        t.check(r['s1']['session'] and r['s1']['session']['state'] == 'dragging', f'hold did not scroll: {r["s1"]}')
        t.check(buttons(ev) == [], f'app received clicks while holding: {buttons(ev)}')
        t.check(scrolled(ev)[1] > 20, f'did not scroll: {scrolled(ev)}')
        idle_state(t, r['s2'])
    finally:
        shell("""(() => { AS.engine()._settings.reset('activation'); return 'ok'; })()""")


@test
def horizontal_and_vertical_only(t):
    mark = app_mark()
    scenario("""
        await AS.click('middle');
        await AS.glide(150, 0, 80, 8);
        await AS.sleep(500);
        await AS.click('left');
        await AS.sleep(200);
        return 'ok';
    """)
    t.check(scrolled(app_events_since(mark))[0] > 50, f'did not scroll right: {scrolled(app_events_since(mark))}')
    shell("""(() => { AS.engine()._settings.set_boolean('vertical-only', true); return 'ok'; })()""")
    try:
        mark = app_mark()
        scenario("""
            await AS.click('middle');
            await AS.glide(150, 0, 80, 8);
            await AS.sleep(500);
            await AS.click('left');
            await AS.sleep(200);
            return 'ok';
        """)
        t.check(scrolled(app_events_since(mark))[0] == 0, 'scrolled sideways with vertical-only on')
    finally:
        shell("""(() => { AS.engine()._settings.reset('vertical-only'); return 'ok'; })()""")


@test
def middle_click_focuses_background_window(t):
    subprocess.run([os.path.join(ROOT, 'scripts/test/launch-app.sh'), 'Front window', os.path.join(DIR, 'front.log')], check=True)
    time.sleep(1)
    try:
        r = shell(f"""(async () => {{
            await AS.ready();
            const back = AS.window('{TITLE}');
            const front = AS.window('Front window');
            back.move_frame(false, 100, 100);
            front.move_frame(false, 800, 200);
            front.activate(global.get_current_time());
            await AS.sleep(400);
            const r = back.get_frame_rect();
            AS.moveTo(r.x + 300, r.y + 400);
            await AS.sleep(150);
            const before = global.display.focus_window === back;
            await AS.click('middle');
            await AS.sleep(200);
            const after = global.display.focus_window === back;
            await AS.click('left');
            await AS.sleep(200);
            return JSON.stringify({{before, after, state: AS.state()}});
        }})()""")
        t.check(r['before'] is False, 'back window had focus already')
        t.check(r['after'] is True, 'middle-click did not focus the window')
        idle_state(t, r['state'])
    finally:
        shell("""(() => { AS.window('Front window')?.delete(global.get_current_time()); return 'ok'; })()""")


@test
def middle_click_with_menu_open_only_closes_it(t):
    r = scenario("""
        // The text entry's context menu is a popup (an xdg_popup window).
        AS.moveTo(r.x + 400, r.y + 70);
        await AS.sleep(150);
        await AS.click('right');
        await AS.sleep(500);
        const menus = global.get_window_actors().map(a => a.meta_window.get_window_type());
        AS.moveTo(cx, cy + 150);
        await AS.sleep(150);
        await AS.click('middle');
        await AS.sleep(300);
        const menusAfter = global.get_window_actors().map(a => a.meta_window.get_window_type());
        return JSON.stringify({menus, menusAfter, state: AS.state()});
    """)
    # Clicking outside an open popup only closes it (the app doesn't get the
    # press), and autoscroll must stay out of the way.
    t.check(len(r['menus']) > 1, f'no menu window opened: {r["menus"]}')
    t.check(len(r['menusAfter']) == 1, f'menu did not close: {r["menusAfter"]}')
    idle_state(t, r['state'])


@test
def overview_stops(t):
    r = scenario("""
        await AS.click('middle');
        Main.overview.show();
        await AS.sleep(400);
        const s = AS.state();
        Main.overview.hide();
        await AS.sleep(600);
        return JSON.stringify(s);
    """)
    idle_state(t, r)


@test
def disable_during_session_cleans_up(t):
    r = scenario("""
        await AS.click('middle');
        await AS.glide(0, 100, 60, 6);
        const ext = Main.extensionManager.lookup('autoscroll@jire.github.io');
        const tracker = global.backend.get_cursor_tracker();
        const seat = global.stage.context.get_backend().get_default_seat();
        await Main.extensionManager.disableExtension(ext.uuid);
        await AS.sleep(300);
        const after = {visible: tracker.get_pointer_visible(), unfocusInhibited: seat.is_unfocus_inhibited(),
            grab: global.stage.get_grab_actor() !== null};
        await Main.extensionManager.enableExtension(ext.uuid);
        await AS.sleep(300);
        return JSON.stringify({after, state: AS.state()});
    """)
    t.check(r['after']['visible'] is True, 'pointer left hidden after disabling')
    t.check(r['after']['grab'] is False, 'grab left behind after disabling')
    idle_state(t, r['state'])


@test
def window_closing_stops(t):
    # Uses a second, throwaway window.
    subprocess.run([os.path.join(ROOT, 'scripts/test/launch-app.sh'), 'Close me', os.path.join(DIR, 'close-me.log')], check=True)
    time.sleep(1)
    r = shell("""(async () => {
        await AS.ready();
        const w = AS.window('Close me');
        w.activate(global.get_current_time());
        await AS.sleep(200);
        const r = w.get_frame_rect();
        AS.moveTo(r.x + 400, r.y + 400);
        await AS.sleep(150);
        await AS.click('middle');
        const s1 = AS.state();
        w.delete(global.get_current_time());
        await AS.sleep(500);
        return JSON.stringify({s1, s2: AS.state()});
    })()""")
    t.check(r['s1']['session'] is not None, 'did not start')
    idle_state(t, r['s2'])


@test
def no_leaks_after_many_sessions(t):
    r = scenario("""
        const tracker = global.backend.get_cursor_tracker();
        for (let i = 0; i < 15; i++) {
            await AS.click('middle');
            await AS.glide(0, i % 2 ? 60 : -60, 30, 3);
            await AS.click(i % 3 ? 'left' : 'right');
        }
        await AS.sleep(300);
        return JSON.stringify({state: AS.state(), visible: tracker.get_pointer_visible(),
            grab: global.stage.get_grab_actor() !== null});
    """)
    idle_state(t, r['state'])
    t.check(r['visible'] is True, 'pointer hidden after many sessions')
    t.check(r['grab'] is False, 'grab left behind after many sessions')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('-k', default='')
    parser.add_argument('--no-start', action='store_true', help='reuse the running headless shell')
    args = parser.parse_args()

    if not args.no_start:
        subprocess.run([HEADLESS, 'start'], check=True)
    # With --no-start the test app may already be open; don't open a second one.
    if not shell(f"!!AS.window('{TITLE}')"):
        subprocess.run([os.path.join(ROOT, 'scripts/test/launch-app.sh'), TITLE, APP_LOG], check=True)
        time.sleep(1.5)

    failed = 0
    for fn in TESTS:
        if args.k not in fn.__name__:
            continue
        t = Test(fn.__name__)
        try:
            reset_settings()
            fn(t)
        except Exception as e:  # noqa: BLE001
            t.failures.append(f'error: {e}')
        status = 'PASS' if not t.failures else 'FAIL'
        print(f'{status}  {t.name}')
        for f in t.failures:
            print(f'      {f}')
        failed += bool(t.failures)
        time.sleep(0.3)

    log = subprocess.run([HEADLESS, 'log'], capture_output=True, text=True).stdout
    problems = [l for l in log.splitlines() if 'JS ERROR' in l or ('CRITICAL' in l and 'autoscroll' in l.lower())]
    for line in problems:
        print(f'LOG   {line}')
    sys.exit(1 if failed or problems else 0)


if __name__ == '__main__':
    main()
