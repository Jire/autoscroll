// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// A GTK 4 window for the headless tests. It prints one JSON line per input
// event it receives (so tests can check that a middle-click never reached it),
// and its scroll position whenever that changes.
//
//   gjs -m scripts/test/test-app.js [title]
//
// Layout (logical px, inside the window): a link button and a text entry at
// the top, and below them a big scrollable canvas.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const title = System.programArgs[0] ?? 'Autoscroll test';
const started = GLib.get_monotonic_time();
const emit = fields => print(JSON.stringify({t: Math.round((GLib.get_monotonic_time() - started) / 1000), ...fields}));

const TYPES = {
    [Gdk.EventType.BUTTON_PRESS]: 'press',
    [Gdk.EventType.BUTTON_RELEASE]: 'release',
    [Gdk.EventType.SCROLL]: 'scroll',
    [Gdk.EventType.ENTER_NOTIFY]: 'enter',
    [Gdk.EventType.LEAVE_NOTIFY]: 'leave',
    [Gdk.EventType.KEY_PRESS]: 'key-press',
    [Gdk.EventType.KEY_RELEASE]: 'key-release',
    [Gdk.EventType.FOCUS_CHANGE]: 'focus',
    [Gdk.EventType.MOTION_NOTIFY]: 'motion',
};

const app = new Gtk.Application({
    application_id: 'test.autoscroll.TestApp',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app, title, default_width: 900, default_height: 700});

    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    const top = new Gtk.Box({spacing: 12, margin_start: 12, margin_top: 12, margin_bottom: 6});
    top.append(new Gtk.LinkButton({uri: 'https://example.com', label: 'A link to click'}));
    top.append(new Gtk.Entry({text: 'Some text', hexpand: true}));
    box.append(top);

    const canvas = new Gtk.DrawingArea({content_width: 4000, content_height: 40000});
    canvas.set_draw_func((_area, cr, width, height) => {
        for (let y = 0; y < height; y += 100) {
            cr.setSourceRGB(...((y / 100) % 2 ? [0.93, 0.95, 1] : [1, 1, 1]));
            cr.rectangle(0, y, width, 100);
            cr.fill();
        }
        cr.setSourceRGB(0.2, 0.2, 0.2);
        for (let y = 0; y < height; y += 100) {
            for (let x = 0; x < width; x += 400) {
                cr.moveTo(x + 10, y + 55);
                cr.showText(`${x}, ${y}`);
            }
        }
        cr.$dispose();
    });
    const scrolled = new Gtk.ScrolledWindow({vexpand: true, hexpand: true, child: canvas});
    box.append(scrolled);
    window.set_child(box);

    const vadj = scrolled.get_vadjustment();
    const hadj = scrolled.get_hadjustment();
    let lastScroll = '';
    const reportScroll = () => {
        const now = `${Math.round(hadj.value)},${Math.round(vadj.value)}`;
        if (now !== lastScroll) {
            lastScroll = now;
            emit({ev: 'position', x: Math.round(hadj.value * 10) / 10, y: Math.round(vadj.value * 10) / 10});
        }
    };
    vadj.connect('value-changed', reportScroll);
    hadj.connect('value-changed', reportScroll);

    let lastMotion = 0;
    const legacy = new Gtk.EventControllerLegacy();
    legacy.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    legacy.connect('event', (_controller, event) => {
        const type = event.get_event_type();
        const name = TYPES[type];
        if (!name)
            return Gdk.EVENT_PROPAGATE;
        const fields = {ev: name};
        const [hasPosition, x, y] = event.get_position();
        if (hasPosition) {
            fields.x = Math.round(x);
            fields.y = Math.round(y);
        }
        if (type === Gdk.EventType.MOTION_NOTIFY) {
            const t = GLib.get_monotonic_time();
            if (t - lastMotion < 100000)
                return Gdk.EVENT_PROPAGATE;
            lastMotion = t;
        }
        if (type === Gdk.EventType.BUTTON_PRESS || type === Gdk.EventType.BUTTON_RELEASE)
            fields.button = event.get_button();
        if (type === Gdk.EventType.SCROLL) {
            const [dx, dy] = event.get_deltas();
            fields.dx = Math.round(dx * 1000) / 1000;
            fields.dy = Math.round(dy * 1000) / 1000;
            fields.unit = event.get_unit();
            fields.stop = event.is_stop();
            fields.source = event.get_device()?.get_source();
        }
        if (type === Gdk.EventType.FOCUS_CHANGE)
            fields.in = event.get_in();
        emit(fields);
        return Gdk.EVENT_PROPAGATE;
    });
    window.add_controller(legacy);

    window.connect('notify::is-active', () => emit({ev: 'active', value: window.is_active}));
    window.present();
    emit({ev: 'ready'});
});
app.run([]);
