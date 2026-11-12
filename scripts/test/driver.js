// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Prepended to every `headless.sh eval`. Defines AS, a helper for driving the
// headless shell with a virtual mouse and keyboard, the same way real input
// arrives (through Mutter's input thread).
globalThis.AS ??= (() => {
    const Clutter = imports.gi.Clutter;
    const seat = (global.stage.context?.get_backend() ?? Clutter.get_default_backend()).get_default_seat();
    const mouse = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const BUTTONS = {left: 1, middle: 2, right: 3}; // Clutter button numbers
    const now = () => GLib.get_monotonic_time();
    const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

    return {
        Clutter,
        sleep,
        /** Closes the overview and moves the pointer off the hot corner. */
        async ready() {
            if (Main.overview.visible) {
                Main.overview.hide();
                await sleep(600);
            }
        },
        moveTo(x, y) {
            mouse.notify_absolute_motion(now(), x, y);
        },
        move(dx, dy) {
            mouse.notify_relative_motion(now(), dx, dy);
        },
        /** Moves by (dx, dy) in small steps over `ms`, like a hand would. */
        async glide(dx, dy, ms = 150, steps = 15) {
            for (let i = 0; i < steps; i++) {
                mouse.notify_relative_motion(now(), dx / steps, dy / steps);
                await sleep(ms / steps);
            }
        },
        press(button = 'middle') {
            mouse.notify_button(now(), BUTTONS[button], Clutter.ButtonState.PRESSED);
        },
        release(button = 'middle') {
            mouse.notify_button(now(), BUTTONS[button], Clutter.ButtonState.RELEASED);
        },
        async click(button = 'middle', holdMs = 70) {
            this.press(button);
            await sleep(holdMs);
            this.release(button);
            await sleep(30);
        },
        wheel(dy) {
            mouse.notify_discrete_scroll(now(),
                dy > 0 ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP,
                Clutter.ScrollSource.WHEEL);
        },
        async keyDown(keyval) {
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
            await sleep(30);
        },
        async keyUp(keyval) {
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
            await sleep(30);
        },
        async key(keyval) {
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
            await sleep(30);
            keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
            await sleep(30);
        },
        engine() {
            return Main.extensionManager.lookup('autoscroll@jire.github.io')?.stateObj?._engine ?? null;
        },
        state() {
            const engine = this.engine();
            const session = engine?._session;
            const [x, y, mods] = global.get_pointer();
            return {
                session: session ? {state: session.state, x: Math.round(session.x), y: Math.round(session.y)} : null,
                pointer: {x, y, mods},
                barriers: engine?._barriers.length ?? -1,
                cursorHidden: engine?._cursorHidden ?? null,
                grab: !!engine?._swallowGrab,
                watch: engine?._watchId ?? 0,
                held: engine ? [...engine._swallowedButtons] : null,
                overlay: engine?._overlay._group.visible ?? null,
            };
        },
        windows() {
            return global.get_window_actors().map(actor => {
                const w = actor.meta_window;
                const r = w.get_frame_rect();
                return {
                    title: w.get_title(), wmClass: w.get_wm_class(), type: w.get_window_type(),
                    x: r.x, y: r.y, width: r.width, height: r.height, focus: w.has_focus(),
                };
            });
        },
        window(match) {
            return global.get_window_actors().map(a => a.meta_window)
                .find(w => (w.get_title() ?? '').includes(match) || w.get_wm_class() === match) ?? null;
        },
    };
})();
