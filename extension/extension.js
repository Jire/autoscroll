// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Autoscroll
//
// Windows-style middle-click autoscroll in every app. Click the middle mouse
// button (or hold it), move the mouse away from where you clicked, and the
// window scrolls that way, faster the further you move. Click again, or let
// go if you held the button, to stop.
//
// How it works
// ------------
// On Wayland, Mutter decides inside its own Clutter event filter whether an
// input event goes to an app, and that filter runs before any filter an
// extension can add. But two things happen in it, before the decision, that
// an extension can hook synchronously:
//
//  * the window under a click gets its user time updated, which emits
//    notify::user-time (button and key presses only), and
//  * the idle monitor is reset, which fires user-active watches (every event).
//
// Straight after that Mutter checks whether the stage has a Clutter grab, and
// if it does, the event doesn't go to the app. So to keep a click from an app
// we start a grab in one of those hooks, and our own event filter, which runs
// right after Mutter's, drops the grab again and stops the event ("swallowing").
// This is what happens to the middle-click that starts autoscroll and to the
// click or key press that ends it, like on Windows.
//
// While autoscrolling:
//  * four pointer barriers pin the real pointer where you clicked, so the app
//    keeps seeing it there and keeps scrolling what you clicked on, the way a
//    Windows app captures the mouse;
//  * the barriers report every move they block, which moves our own pan
//    cursor (drawn by overlay.js while the real one is hidden);
//  * every frame, a virtual pointer device sends a smooth scroll event at the
//    speed Edge and Chrome use on Windows for the current distance, adjusted
//    for the app's toolkit (toolkits.js).
//
// When it ends, the barriers go and the real pointer is moved to where the
// pan cursor was. AGENTS.md has the details.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AppRules} from './apps.js';
import {CursorShapes} from './cursorShapes.js';
import {Overlay} from './overlay.js';
import {Toolkits} from './toolkits.js';

// How Edge and Chrome autoscroll on Windows (Chromium's AutoscrollController),
// in logical pixels: nothing happens within 15 px of the click on each axis,
// and beyond that the speed is 0.008 × distance^2.2 pixels per second. That's
// about 200 px/s at 100 px from the click, 900 px/s at 200 px and 2200 px/s
// at 300 px.
const DEAD_ZONE = 15;
const SPEED_SCALE = 0.008;
const SPEED_EXPONENT = 2.2;
// After a stall, never scroll more than this many seconds' worth at once.
const MAX_FRAME_TIME = 0.1;
// Apps that see the end of a scroll gesture (touchpad style) start a kinetic
// fling from the last movement. So the gesture is only finished once nothing
// has scrolled for this long, while the pointer is still on the app.
const SCROLL_END_DELAY_US = 300 * 1000;
// Half-length of the barriers that pin the pointer while autoscrolling.
const PIN_REACH = 64;
// Our own injected events are recognised by their timestamps.
const INJECTED_MEMORY = 64;

const MODIFIER_MASKS = {
    none: 0,
    ctrl: Clutter.ModifierType.CONTROL_MASK,
    shift: Clutter.ModifierType.SHIFT_MASK,
    alt: Clutter.ModifierType.MOD1_MASK,
    super: Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK,
};

const APP_WINDOW_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);

const MENU_WINDOW_TYPES = new Set([
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.COMBO,
    Meta.WindowType.MENU,
]);

const MOUSE_DEVICE_TYPES = new Set([
    Clutter.InputDeviceType.POINTER_DEVICE,
    Clutter.InputDeviceType.TOUCHPAD_DEVICE,
]);

const EventType = Clutter.EventType;
const EMULATED = Clutter.EventFlags.FLAG_POINTER_EMULATED;

/** Scroll speed in px/s along one axis, `distance` px from the click. */
function axisSpeed(distance) {
    const abs = Math.abs(distance);
    if (abs <= DEAD_ZONE)
        return 0;
    return Math.sign(distance) * SPEED_SCALE * abs ** SPEED_EXPONENT;
}

function contains(rect, x, y) {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/** One autoscroll, from the middle-click that starts it to whatever ends it. */
class Session {
    constructor(window, x, y, holdOnly) {
        this.window = window;
        this.originX = x;
        this.originY = y;
        this.x = x;
        this.y = y;
        this.holdOnly = holdOnly;
        // pressed:  middle button down, still inside the dead zone
        // dragging: middle button down and moved out of the dead zone; letting go ends it
        // sticky:   clicked; scrolls until the next click or key press
        this.state = 'pressed';
        this.lastFrame = GLib.get_monotonic_time();
        // Pixels the window scrolls per unit of our scroll events (see toolkits.js).
        this.unitPixels = 1;
    }
}

class Engine {
    constructor(settings) {
        this._settings = settings;
        this._windowTracker = Shell.WindowTracker.get_default();
        // GNOME 48 and later; GNOME 46 and 47 only have get_for_display().
        this._cursorTracker = global.backend.get_cursor_tracker?.() ??
            Meta.CursorTracker.get_for_display(global.display);
        this._idleMonitor = global.backend.get_core_idle_monitor();
        // GNOME 47+ has the stage's context; older versions the default backend.
        const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
        this._seat = backend.get_default_seat();
        this._device = this._seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._wmPreferences = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});

        this._overlay = new Overlay();
        this._shapes = new CursorShapes(this._cursorTracker, msg => this._log(msg));
        this._toolkits = new Toolkits();

        // Holding a grab on this (invisible) actor is what keeps an event from the app.
        this._grabActor = new Clutter.Actor({reactive: true});
        Main.layoutManager.uiGroup.add_child(this._grabActor);

        this._session = null;
        this._swallowGrab = null;
        this._swallowing = null;
        this._swallowIdleId = 0;
        this._activateAfterSwallow = null;
        // Buttons whose press we swallowed; their release must be swallowed too.
        this._swallowedButtons = new Set();
        this._watchId = 0;
        this._injected = [];
        this._barriers = [];
        this._reportingBarrier = null;
        this._cursorHidden = false;
        this._timeline = null;
        this._scrollSource = Clutter.ScrollSource.FINGER;
        this._gestureOpen = false;
        this._lastScrollTime = 0;

        this._loadSettings();
        this._settings.connectObject('changed', () => this._loadSettings(), this);

        this._filterId = Clutter.Event.add_filter(null, event => this._filter(event));

        this._watched = new Set();
        for (const window of global.display.list_all_windows())
            this._watch(window);
        global.display.connectObject('window-created', (_display, window) => this._watch(window), this);

        Main.overview.connectObject('showing', () => this._end('the overview opened'), this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._end('the workspace changed'), this);
        global.backend.get_monitor_manager().connectObject('monitors-changed',
            () => this._end('the monitors changed'), this);
    }

    destroy() {
        this._end('autoscroll was turned off');
        this._dropSwallowGrab();
        this._swallowedButtons.clear();
        this._disarmWatch();
        if (this._filterId) {
            Clutter.Event.remove_filter(this._filterId);
            this._filterId = 0;
        }

        for (const window of this._watched)
            window.disconnectObject(this);
        this._watched.clear();
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.backend.get_monitor_manager().disconnectObject(this);
        this._settings.disconnectObject(this);

        this._overlay.destroy();
        this._shapes.destroy();
        this._grabActor.destroy();
        this._device = null;
        this._settings = null;
    }

    _loadSettings() {
        const settings = this._settings;
        this._holdOnly = settings.get_string('activation') === 'hold';
        this._speed = settings.get_double('speed');
        this._verticalOnly = settings.get_boolean('vertical-only');
        this._passLinks = settings.get_boolean('pass-through-links');
        this._passText = settings.get_boolean('pass-through-text');
        this._passTop = settings.get_boolean('pass-through-top');
        this._topHeight = settings.get_int('top-height');
        this._modifierMask = MODIFIER_MASKS[settings.get_string('pass-through-modifier')] ?? 0;
        this._rules = new AppRules(settings.get_strv('excluded-apps'));
        this._debug = settings.get_boolean('debug');
        if (this._passLinks || this._passText)
            this._shapes.ensureLoaded();
    }

    _log(message) {
        if (this._debug)
            console.log(`[autoscroll] ${message}`);
    }

    // ---- Starting

    _watch(window) {
        if (this._watched.has(window))
            return;
        this._watched.add(window);
        window.connectObject(
            'notify::user-time', () => this._onUserTime(window),
            'unmanaging', () => this._unwatch(window),
            this);
    }

    _unwatch(window) {
        if (!this._watched.delete(window))
            return;
        window.disconnectObject(this);
        this._toolkits.forget(window);
        if (this._session?.window === window)
            this._end('the window closed');
    }

    /** Runs inside Mutter's event handling, before it sends a click to the app. */
    _onUserTime(window) {
        if (this._session || this._swallowGrab)
            return;
        const event = Clutter.get_current_event();
        if (!event || event.type() !== EventType.BUTTON_PRESS ||
            event.get_button() !== Clutter.BUTTON_MIDDLE || this._isInjected(event))
            return;

        const reason = this._passThroughReason(window, event);
        if (reason) {
            this._log(`middle-click goes to ${window.get_wm_class()}: ${reason}`);
            return;
        }
        this._start(window, event);
    }

    /** Why a middle-click should go to the app instead of starting autoscroll, or null. */
    _passThroughReason(window, event) {
        if (Main.sessionMode.isLocked)
            return 'the screen is locked';

        const device = event.get_source_device();
        if (!device || !MOUSE_DEVICE_TYPES.has(device.get_device_type()))
            return 'not from a mouse or touchpad';
        if (event.get_flags() & EMULATED)
            return 'emulated click';
        if (this._modifierMask && (event.get_state() & this._modifierMask))
            return 'the pass-through key is held';

        if (!APP_WINDOW_TYPES.has(window.get_window_type()))
            return 'not an app window';
        const rule = this._rules.match(this._windowIds(window));
        if (rule)
            return `matches "${rule}" in the app list`;
        if (this._menuIsOpen())
            return 'a menu is open';

        const [x, y] = event.get_coords();
        const frame = window.get_frame_rect();
        if (!contains(window.frame_rect_to_client_rect(frame), x, y))
            return 'on the window border or title bar';
        if (this._passTop && !window.is_fullscreen() && y < frame.y + this._topHeight)
            return 'near the top of the window';

        const shape = this._shapes.classify();
        if (shape === 'hidden')
            return 'the app hides the pointer';
        if (shape === 'pointer' && this._passLinks)
            return 'the pointer is a hand (link)';
        if (shape === 'text' && this._passText)
            return 'the pointer is a text cursor';
        return null;
    }

    _windowIds(window) {
        const appIds = [];
        const app = this._windowTracker.get_window_app(window);
        if (app)
            appIds.push(app.get_id());
        for (const id of [window.get_gtk_application_id(), window.get_sandboxed_app_id()]) {
            if (id)
                appIds.push(`${id}.desktop`);
        }
        const wmClasses = [window.get_wm_class(), window.get_wm_class_instance()].filter(Boolean);
        return {appIds, wmClasses};
    }

    _menuIsOpen() {
        return global.get_window_actors().some(actor =>
            actor.visible && MENU_WINDOW_TYPES.has(actor.meta_window.get_window_type()));
    }

    _start(window, event) {
        const [x, y] = event.get_coords();
        this._swallow(event);
        this._swallowedButtons.add(Clutter.BUTTON_MIDDLE);
        // A middle-click focuses the window like any other click would have.
        this._activateAfterSwallow = {window, time: event.get_time()};

        const session = new Session(window, x, y, this._holdOnly);
        session.unitPixels = this._toolkits.pixelsPerUnit(window);
        this._log(`started at ${Math.round(x)},${Math.round(y)} in ${window.get_wm_class()} ` +
            `(${this._toolkits.detect(window)}, ${session.unitPixels.toFixed(2)} px per unit; ` +
            `pointer ${this._shapes.describe()})`);
        this._session = session;
        // The pan cursor starts wherever the pointer has got to by now.
        [session.x, session.y] = this._pin();
        this._hideCursor();
        this._overlay.show(x, y, this._verticalOnly);
        this._moved(session);
        this._armWatch();
        this._startFrames();
        window.connectObject('notify::minimized', () => this._end('the window was minimized'), session);
    }

    // ---- While autoscrolling

    /** Runs for every input event during a session, before Mutter routes it. */
    _onEvent(event) {
        if (this._isInjected(event))
            return;

        const session = this._session;
        switch (event.type()) {
        case EventType.BUTTON_PRESS:
            if (session) {
                // Like Windows, the click that stops autoscroll does nothing else.
                this._swallow(event);
                this._swallowedButtons.add(event.get_button());
                this._end('click');
            }
            break;
        case EventType.BUTTON_RELEASE: {
            const button = event.get_button();
            if (this._swallowedButtons.delete(button))
                this._swallow(event);
            if (session && button === Clutter.BUTTON_MIDDLE)
                this._onMiddleRelease(session);
            break;
        }
        case EventType.SCROLL:
            if (session && !(event.get_flags() & EMULATED))
                this._end('the mouse wheel was used');
            break;
        case EventType.KEY_PRESS:
            if (session) {
                this._swallow(event);
                this._end('key press');
            }
            break;
        case EventType.TOUCH_BEGIN:
        case EventType.TOUCHPAD_SWIPE:
        case EventType.TOUCHPAD_PINCH:
            if (session)
                this._end('touch');
            break;
        }

        if (!this._session && !this._swallowedButtons.size)
            this._disarmWatch();
    }

    /**
     * Mouse movement while the pointer is pinned. Each barrier that has been
     * hit reports every following move (what it would have been, before it
     * was blocked), so only the first one to report is listened to.
     */
    _onBarrierEvent(barrier, event, left) {
        const session = this._session;
        if (!session)
            return;
        this._reportingBarrier ??= barrier;
        if (barrier !== this._reportingBarrier)
            return;
        // Shouldn't happen (see _pin), but if it stops reporting, use another.
        if (left)
            this._reportingBarrier = null;

        session.x += event.dx;
        session.y += event.dy;
        this._moved(session);
    }

    _moved(session) {
        [session.x, session.y] = this._clampToMonitors(session.x, session.y);
        const [vx, vy] = this._velocity(session);
        if (session.state === 'pressed' && (vx || vy))
            session.state = 'dragging';
        this._overlay.moveCursor(session.x, session.y, this._direction(vx, vy));
    }

    _onMiddleRelease(session) {
        if (session.state === 'dragging') {
            this._end('the middle button was released');
        } else if (session.state === 'pressed') {
            if (session.holdOnly) {
                this._end('it was a click', {replayClick: true});
            } else {
                session.state = 'sticky';
                this._log('clicked: scrolling until the next click or key press');
            }
        }
    }

    _velocity(session) {
        const vx = this._verticalOnly ? 0 : axisSpeed(session.x - session.originX);
        const vy = axisSpeed(session.y - session.originY);
        return [vx * this._speed, vy * this._speed];
    }

    _direction(vx, vy) {
        const ns = vy < 0 ? 'n' : vy > 0 ? 's' : '';
        const ew = vx < 0 ? 'w' : vx > 0 ? 'e' : '';
        return ns + ew || null;
    }

    _clampToMonitors(x, y) {
        let best = [x, y];
        let bestDistance = Infinity;
        for (const monitor of Main.layoutManager.monitors) {
            const cx = Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - 1);
            const cy = Math.min(Math.max(y, monitor.y), monitor.y + monitor.height - 1);
            const distance = (cx - x) ** 2 + (cy - y) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = [cx, cy];
                if (distance === 0)
                    break;
            }
        }
        return best;
    }

    _startFrames() {
        this._timeline = new Clutter.Timeline({
            actor: this._overlay.cursorActor,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._frame());
        this._timeline.start();
    }

    _stopFrames() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline.run_dispose();
        this._timeline = null;
    }

    _frame() {
        const session = this._session;
        if (!session)
            return;
        const now = GLib.get_monotonic_time();
        const seconds = Math.min((now - session.lastFrame) / 1e6, MAX_FRAME_TIME);
        session.lastFrame = now;

        const [vx, vy] = this._velocity(session);
        const units = seconds / session.unitPixels;
        if (vx || vy)
            this._scroll(now, vx * units, vy * units);
        else if (this._gestureOpen && now - this._lastScrollTime > SCROLL_END_DELAY_US)
            this._finishGesture();
    }

    _scroll(time, dx, dy) {
        this._remember(time);
        this._device.notify_scroll_continuous(time, dx, dy, this._scrollSource,
            Clutter.ScrollFinishFlags.NONE);
        this._gestureOpen = true;
        this._lastScrollTime = time;
    }

    _finishGesture() {
        if (!this._gestureOpen)
            return;
        this._gestureOpen = false;
        const time = GLib.get_monotonic_time();
        this._remember(time);
        this._device.notify_scroll_continuous(time, 0, 0, this._scrollSource,
            Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL);
    }

    // ---- Stopping

    _end(reason, {replayClick = false} = {}) {
        const session = this._session;
        if (!session)
            return;
        this._session = null;
        this._log(`stopped: ${reason}`);

        session.window.disconnectObject(session);
        this._stopFrames();
        // The scroll gesture is deliberately left open: finishing it now would
        // make apps turn the last movement into a kinetic fling, and Windows
        // stops dead. It's finished later, when it's safe (see _frame).
        this._unpin();

        const seat = this._seat;
        if (replayClick) {
            // Hold-only mode, and the button was only clicked: give the app its
            // middle-click after all, where it happened.
            seat.warp_pointer(Math.round(session.originX), Math.round(session.originY));
            const time = GLib.get_monotonic_time();
            this._remember(time);
            this._device.notify_button(time, Clutter.BUTTON_MIDDLE, Clutter.ButtonState.PRESSED);
            this._remember(time + 1);
            this._device.notify_button(time + 1, Clutter.BUTTON_MIDDLE, Clutter.ButtonState.RELEASED);
        }
        // Put the real pointer where the pan cursor is.
        if (replayClick || Math.hypot(session.x - session.originX, session.y - session.originY) >= 1)
            seat.warp_pointer(Math.round(session.x), Math.round(session.y));

        this._showCursor();
        this._overlay.hide();
        if (!this._swallowedButtons.size)
            this._disarmWatch();
    }

    // ---- Plumbing

    /** Keeps the event being handled right now from reaching the app. */
    _swallow(event) {
        this._swallowing = {type: event.type(), time: event.get_time_us()};
        if (this._swallowGrab)
            return;
        this._swallowGrab = global.stage.grab(this._grabActor);
        // In case another event filter stops the event before ours sees it.
        this._swallowIdleId ||= GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            this._swallowIdleId = 0;
            this._dropSwallowGrab();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Our Clutter event filter; it runs right after Mutter's. */
    _filter(event) {
        const swallowing = this._swallowing;
        if (!swallowing || event.type() !== swallowing.type || event.get_time_us() !== swallowing.time)
            return Clutter.EVENT_PROPAGATE;
        this._dropSwallowGrab();
        return Clutter.EVENT_STOP;
    }

    _dropSwallowGrab() {
        this._swallowing = null;
        if (this._swallowIdleId) {
            GLib.source_remove(this._swallowIdleId);
            this._swallowIdleId = 0;
        }
        if (this._swallowGrab) {
            const grab = this._swallowGrab;
            this._swallowGrab = null;
            grab.dismiss();
        }
        if (this._activateAfterSwallow) {
            const {window, time} = this._activateAfterSwallow;
            this._activateAfterSwallow = null;
            if (!window.has_focus())
                window.focus(time);
            if (this._wmPreferences.get_boolean('raise-on-click'))
                window.raise();
        }
    }

    _armWatch() {
        if (this._watchId)
            return;
        this._watchId = this._idleMonitor.add_user_active_watch(() => {
            this._watchId = 0;
            if (!this._session && !this._swallowedButtons.size)
                return;
            this._armWatch();
            const event = Clutter.get_current_event();
            if (event)
                this._onEvent(event);
        });
    }

    _disarmWatch() {
        if (this._watchId) {
            this._idleMonitor.remove_watch(this._watchId);
            this._watchId = 0;
        }
    }

    /**
     * Pins the pointer where it is and returns where that was.
     *
     * The pointer is moved to a whole pixel (L, T) and boxed in to
     * [L, L + 1] × [T, T + 1]. The left and top barriers only block moves out
     * of the box: the pointer sits right on them, and a two-way barrier there
     * could let it slip out. Mutter keeps reporting moves from a barrier while
     * the pointer is within 2 px of it on a side the barrier blocks; this box
     * is small enough that that's always true, so a barrier that has been hit
     * keeps reporting every move for the whole session.
     */
    _pin() {
        const [x, y] = global.get_pointer();
        const left = Math.floor(x);
        const top = Math.floor(y);
        const {POSITIVE_X, POSITIVE_Y} = Meta.BarrierDirection;
        const barrier = (x1, y1, x2, y2, directions) => {
            const b = new Meta.Barrier({backend: global.backend, x1, y1, x2, y2, directions});
            b.connectObject(
                'hit', (_barrier, event) => this._onBarrierEvent(b, event, false),
                'left', (_barrier, event) => this._onBarrierEvent(b, event, true),
                this);
            this._barriers.push(b);
        };
        try {
            barrier(left, top - PIN_REACH, left, top + PIN_REACH, POSITIVE_X);
            barrier(left + 1, top - PIN_REACH, left + 1, top + PIN_REACH, 0);
            barrier(left - PIN_REACH, top, left + PIN_REACH, top, POSITIVE_Y);
            barrier(left - PIN_REACH, top + 1, left + PIN_REACH, top + 1, 0);
            this._seat.warp_pointer(left, top);
        } catch (e) {
            logError(e, '[autoscroll] pinning the pointer');
            this._unpin();
        }
        return [x, y];
    }

    _unpin() {
        for (const barrier of this._barriers) {
            barrier.disconnectObject(this);
            barrier.destroy();
        }
        this._barriers = [];
        this._reportingBarrier = null;
    }

    /** Hides the real pointer (our pan cursor replaces it) without unfocusing the app. */
    _hideCursor() {
        if (this._cursorHidden)
            return;
        // A hidden pointer normally has no focus, so apps would get no scroll
        // events; the magnifier keeps it focused the same way.
        this._seat.inhibit_unfocus();
        this._cursorTracker.inhibit_cursor_visibility();
        this._cursorHidden = true;
    }

    _showCursor() {
        if (!this._cursorHidden)
            return;
        this._cursorTracker.uninhibit_cursor_visibility();
        this._seat.uninhibit_unfocus();
        this._cursorHidden = false;
    }

    _remember(time) {
        this._injected.push(time);
        if (this._injected.length > INJECTED_MEMORY)
            this._injected.shift();
    }

    _isInjected(event) {
        return this._injected.includes(event.get_time_us());
    }
}

export default class AutoscrollExtension extends Extension {
    enable() {
        // GNOME 46–48 can still run as an X11 compositor (GNOME 49 and later can't).
        if (Meta.is_wayland_compositor && !Meta.is_wayland_compositor()) {
            console.warn('[autoscroll] Autoscroll needs a Wayland session; on X11 apps get mouse clicks directly from the X server.');
            return;
        }
        this._engine = new Engine(this.getSettings());
    }

    disable() {
        this._engine?.destroy();
        this._engine = null;
    }
}
