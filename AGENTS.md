# AGENTS.md

Guidance for AI coding assistants (Claude Code, Codex, Copilot, Cursor and others) working in this repository or helping someone install or use it.

## What this is

Autoscroll is a GNOME Shell extension (GJS, ES modules) that adds Windows-style middle-click autoscroll to every app: click (or hold) the middle button, move the mouse away from the click, and the window under the click scrolls that way, faster the further you move. It draws the same origin marker and direction arrows as Windows and scrolls at the speed Edge and Chrome use on Windows.

- UUID: `autoscroll@jire.github.io`
- Supported GNOME Shell: 46–51 on Wayland. Tested on 51. 46–50 have the same event routing and APIs (checked against Mutter's and GNOME Shell's source for each version) but haven't been run.
- License: GPL-2.0-or-later

## Helping someone install it

Point them to the one-line installer in [README.md](README.md#install). It installs per user (never with `sudo`). On Wayland the extension loads at the next login; to load it without logging out, use the Looking Glass line in the README. Settings: `gnome-extensions prefs autoscroll@jire.github.io`.

If a middle-click doesn't start autoscroll (or starts it where it shouldn't), have them turn on **Debug logging** in the settings and run `journalctl --user -f -g autoscroll` while they middle-click. Every middle-click logs either `started …` (with the app's toolkit and the pointer image) or `middle-click goes to <app>: <reason>`.

## Layout

| Path | Purpose |
| --- | --- |
| `extension/` | Everything that ships in the extension zip |
| `extension/extension.js` | The engine: input hooks, the session state machine, pointer pinning, scroll injection |
| `extension/overlay.js` | The origin marker and pan cursor, drawn with Cairo |
| `extension/toolkits.js` | Per-toolkit scroll calibration (see below) |
| `extension/cursorShapes.js` | Recognises the hand and text pointers from the cursor theme's Xcursor files |
| `extension/apps.js` | The "apps without autoscroll" list. Also imported by `prefs.js`, so it must not import Shell modules |
| `extension/prefs.js` | Preferences window (libadwaita, must work with Adwaita 1.5 / GNOME 46) |
| `extension/schemas/` | GSettings schema XML only; GNOME 44+ and `install.sh` compile it at install time |
| `scripts/hot-load.js` | Looking Glass loader for reloading without logging out. Not shipped in the zip; `install.sh` puts it in `~/.local/share/autoscroll/` |
| `install.sh` | User-facing installer (curl/wget pipe), also `--uninstall`, `--purge`, `--version`, `--zip` |
| `scripts/build.sh` | Builds `dist/<uuid>.shell-extension.zip` |
| `scripts/test/` | Headless GNOME Shell test harness, end-to-end tests, calibration, unit tests |
| `scripts/demo/` | Records `docs/demo.gif` |
| `.github/workflows/ci.yml` | Syntax check, ESLint, schema check, ShellCheck, unit tests, build; publishes a release on `v*` tags |

## How it works

On Wayland, Mutter decides inside its own Clutter event filter (`meta_display_handle_event` in `src/core/events.c`) whether an input event goes to an app, and that filter runs **before** any filter an extension adds (filters run in the order they were added). Two things happen inside it, before the decision, that an extension can hook synchronously:

1. The window under a click gets its user time updated → `notify::user-time` on that `MetaWindow` (button and key presses only). This is how a middle-click is noticed.
2. The idle monitor is reset → user-active watches fire (every non-synthetic event). While autoscrolling, a self-re-arming `add_user_active_watch()` sees every click, key and wheel event.

Right after those, Mutter checks `stage_has_grab()` and, if there's a Clutter grab, doesn't send the event to the app. So to keep an event from the app the engine starts a grab in the hook ("swallowing"), and its own event filter, which runs straight after Mutter's, matches the event (type + `get_time_us()`), drops the grab and returns `EVENT_STOP`. A high-priority idle drops the grab too, in case another filter stopped the event first. Side effect: the app sees a keyboard focus-out/in pair for each swallowed event (any Clutter grab does that). This ordering is identical in Mutter 46–51; if a new Mutter changes it, this is the first thing to check.

While a session runs:

- **Pinning.** Four `Meta.Barrier`s box the real pointer into 1 × 1 px at the click, so the app keeps scrolling what was clicked (like Windows apps capturing the mouse). The pointer is warped to a whole pixel (L, T); the left and top barriers are one-way (they sit on the pointer) and the right/bottom ones block both ways. With that box the pointer is always within a barrier's 2 px "hit box", so a barrier that has been hit stays held and reports every later move. Don't change the geometry without re-running `pin_holds_in_every_direction` and `fast_press_and_move_stays_pinned`.
- **Movement.** `Clutter.Event.get_relative_motion()` isn't usable from GJS (no `(out)` annotations), so movement comes from the barrier `hit` events (`event.dx/dy`, the accelerated motion before it was blocked). Only the first barrier that reports is listened to; they all report the same moves.
- **Cursor.** The real pointer is hidden with `inhibit_cursor_visibility()` plus `seat.inhibit_unfocus()` (without the latter a hidden pointer loses focus and apps get no scroll events; the magnifier does the same). `overlay.js` draws the marker and the pan cursor at the tracked position.
- **Scrolling.** A `Clutter.VirtualInputDevice` sends `notify_scroll_continuous` with `ScrollSource.FINGER` every frame (a `Clutter.Timeline` on the cursor actor), at Chromium's autoscroll speed: nothing within 15 px per axis, then `0.008 × distance^2.2` px/s.
- **Ending a scroll gesture without a fling.** Apps fling a touchpad-style gesture on when it ends, and Windows stops dead. GTK and Firefox take the fling speed from the last 100–150 ms of scroll events by their timestamps, so the end is stamped 200 ms after the last real scroll event. Chromium takes it from its last three scroll events however old they are (`ComputeFlingVelocity` in `wayland_event_source.cc`) and flings whenever an axis stop arrives in a frame with no movement within 200 ms of *any* pointer event, so the end frame still moves 0.02 units vertically and only stops the horizontal axis. The gesture is ended when autoscroll stops (before unpinning, so the app gets it) and after the pan cursor rests 300 ms in the dead zone. `browsers_never_fling` in `scripts/test/run_tests.py` covers this; v1 sent a plain axis stop and Chromium flung the page at the previous autoscroll's speed.
- **Calibration.** Toolkits turn the same event into different distances, so `toolkits.js` detects the window's toolkit from `/proc/PID/maps` (Chromium maps `icudtl.dat`, Firefox `libxul.so`, then Qt, Java, GTK 4, GTK 3, in that order because the first ones load GTK too) and divides by its factor: Chromium 10.3 (12.4 on X11), Firefox 4 (13.3 on X11), GTK 4 2.5 (`MAGIC_SCROLL_FACTOR`), GTK 3 and GTK 4 on X11 `viewHeight^(2/3)/10`, Qt 6. Re-measure with `scripts/test/calibrate.sh` and `measure-browser.sh` after toolkit updates.
- **Ending.** Any button press, key press, wheel scroll or touch ends it (the press or key is swallowed, and so is the release of every swallowed button). Then the barriers go, the real pointer is warped to the pan cursor, and the cursor is shown again. In hold-only mode a click without movement is replayed to the app with the virtual device (`notify_button` takes **Clutter** button numbers, not evdev codes).

Middle-clicks are passed through (not swallowed) on links (hand pointer, recognised by size + hotspot from the theme's Xcursor files, since Mutter only exposes the image), near the top of windows, over the window frame, in excluded apps, with the pass-through key held, when a menu is open, when the app hides the pointer, and for non-mouse devices.

## Conventions

- Every `connect` needs a matching `disconnect` (use `connectObject` / `disconnectObject` in the extension; `prefs.js` runs outside the Shell and uses plain `connect`/`disconnect`). `disable()` must undo everything, including a running session: barriers, the hidden cursor, the unfocus inhibit, grabs, idle watches, timers.
- Only use Mutter/Shell APIs that exist in GNOME 46–51, or feature-detect them (see the cursor tracker and seat lookups in `extension.js`).
- Start new source files with the SPDX header used in the existing files.
- Logging during normal operation goes through `_log()`, which only logs when the `debug` setting is on.

## Checking changes

```bash
npx --yes eslint@9 .
shellcheck install.sh scripts/*.sh scripts/test/*.sh scripts/demo/*.sh
gjs -m scripts/test/unit.js
scripts/test/run_tests.py                       # end-to-end, in a headless GNOME Shell
scripts/build.sh && ./install.sh --zip dist/*.shell-extension.zip
```

Then reload with the Looking Glass line from the README. Reloading the user's live session is their call, so ask before suggesting it.

### The headless test shell

`scripts/test/headless.sh start` runs GNOME Shell headless on a private D-Bus session, with its own `XDG_*_HOME` folders, its own `XDG_RUNTIME_DIR`, and `GSETTINGS_BACKEND=keyfile`. All of that matters: dconf shares one database (and change notifications) per user, so a test shell that writes settings through dconf, or a D-Bus daemon started before the `XDG_*` variables are exported, writes into the real desktop's settings. The script refuses to write settings unless the keyfile backend is active. Keep it that way.

- `scripts/test/headless.sh eval 'JS'` runs code in it (through `org.gnome.Shell.Eval`; a throwaway extension turns on unsafe mode). `scripts/test/driver.js` adds `AS`, a virtual mouse and keyboard plus state helpers.
- `scripts/test/launch-app.sh`, `launch-client.sh` (GTK 3/4, Qt 5/6, Swing) and `launch-browser.sh` (Firefox/Chromium with throwaway profiles) open test windows; `AUTOSCROLL_TEST_X11=1 headless.sh start` adds Xwayland for the X11 variants.
- The virtual pointer starts in the top-left hot corner; hot corners are turned off in the test session so the overview doesn't open.
- Headless Mutter doesn't update the cursor tracker from app cursors (there's no cursor renderer for virtual devices), so link detection can only be unit-tested (`scripts/test/unit.js`, against the installed Adwaita theme).

## Releasing

Tag and push (`git tag -a vN -m vN && git push origin vN`). CI builds the zip and attaches it to the GitHub release, and the installer always fetches `releases/latest`. The same zip can be uploaded at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/). Don't add a `version` key to `metadata.json`: extensions.gnome.org sets it. When a new GNOME version comes out, re-check the event routing order described above, run the tests, then add it to `shell-version`.

Everything shipped in `extension/` must pass the [extensions.gnome.org review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html). Notes for the review: the extension reads `/proc/PID/maps` of app windows (only to pick a scroll speed per toolkit) and the cursor theme's Xcursor files (to recognise the hand pointer), and uses a virtual pointer device and pointer barriers only while autoscrolling.
