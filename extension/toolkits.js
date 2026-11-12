// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Makes every app scroll at the same speed.
//
// Apps turn the same scroll event into very different distances: GTK 4
// multiplies touchpad-style scrolling by 2.5, Chromium treats it like wheel
// steps of 100 px, GTK 3 scales it with the height of the scrolled view, and so
// on. So the toolkit a window uses is worked out from what its process has
// mapped (/proc/PID/maps: every Chromium-based app maps icudtl.dat, Firefox
// maps libxul.so, ...), and the scroll amounts are divided by how many pixels
// that toolkit scrolls per unit. The numbers were measured on GNOME 51 with
// scripts/test/calibrate.sh and match each toolkit's source code.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// Checked in this order: Chromium, Firefox, Qt (through its GNOME platform
// theme) and Java (with the GTK look and feel) can all load GTK too.
const TOOLKITS = [
    ['chromium', /\/(?:icudtl\.dat|v8_context_snapshot\.bin|snapshot_blob\.bin)$|\/libcef\.so$/m],
    ['gecko', /\/libxul\.so$/m],
    ['qt', /\/libQt[56](?:Core|Gui|Widgets)\.so[.\d]*$/m],
    ['java', /\/libjvm\.so$/m],
    ['gtk4', /\/libgtk-4\.so[.\d]*$/m],
    ['gtk3', /\/libgtk-3\.so[.\d]*$/m],
];

/** GTK's scroll step for a view this tall, per unit (it scales with the view's height). */
function gtkStep(viewHeight) {
    return Math.max(viewHeight, 100) ** (2 / 3) / 10;
}

export class Toolkits {
    constructor() {
        this._byPid = new Map();
    }

    /** @returns {string} chromium, gecko, gtk4, gtk3, qt, java or unknown */
    detect(window) {
        const pid = window.get_pid();
        if (pid <= 0)
            return 'unknown';
        let toolkit = this._byPid.get(pid);
        if (toolkit === undefined) {
            toolkit = 'unknown';
            try {
                const [, bytes] = GLib.file_get_contents(`/proc/${pid}/maps`);
                const maps = new TextDecoder().decode(bytes);
                toolkit = TOOLKITS.find(([, regexp]) => regexp.test(maps))?.[0] ?? 'unknown';
            } catch {
                // The process is gone, or /proc isn't readable.
            }
            this._byPid.set(pid, toolkit);
        }
        return toolkit;
    }

    forget(window) {
        this._byPid.delete(window.get_pid());
    }

    /**
     * How many logical pixels `window` scrolls per unit of a touchpad-style
     * (finger) scroll event.
     */
    pixelsPerUnit(window) {
        const toolkit = this.detect(window);
        const x11 = window.get_client_type() === Meta.WindowClientType.X11;
        // The scrolled view is roughly the window minus its header bar.
        const viewHeight = window.get_frame_rect().height - 60;
        switch (toolkit) {
        case 'chromium':
            return x11 ? 12.4 : 10.3;
        case 'gecko':
            return x11 ? 13.3 : 4;
        case 'gtk4':
            return x11 ? gtkStep(viewHeight) : 2.5;
        case 'gtk3':
            return gtkStep(viewHeight);
        case 'qt':
            return 6;
        case 'java':
            return 5;
        default:
            return 6;
        }
    }
}
