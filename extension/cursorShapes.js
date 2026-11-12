// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Tells what the mouse pointer currently looks like: a hand (over a link or
// button), a text cursor, hidden, or anything else.
//
// GNOME Shell can't ask an app what's under the pointer, but apps change the
// pointer to a hand over links, which is exactly when Windows lets a
// middle-click open the link instead of autoscrolling. Mutter only exposes the
// current pointer image, so we recognise it by its size and hotspot: every
// image in the cursor theme has its own, and they're read here from the
// theme's Xcursor files. A size and hotspot that the hand shares with any other
// common pointer counts as "other", so an ambiguous theme can only make link
// detection miss, never block autoscroll.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const XCURSOR_MAGIC = 0x72756358; // "Xcur"
const XCURSOR_IMAGE_TYPE = 0xfffd0002;

const SHAPES = {
    pointer: [
        'pointer', 'hand2', 'hand', 'pointing_hand',
        'e29285e634086352946a0e7090d73106', '9d800788f1b08800ae810202380a0822',
    ],
    text: ['text', 'xterm', 'ibeam'],
};

// Other common pointers, only used to rule out look-alikes.
const OTHERS = [
    'default', 'left_ptr', 'arrow', 'top_left_arrow', 'context-menu', 'help', 'question_arrow',
    'progress', 'left_ptr_watch', 'wait', 'watch', 'cell', 'plus', 'crosshair', 'cross',
    'vertical-text', 'alias', 'copy', 'move', 'fleur', 'no-drop', 'not-allowed', 'crossed_circle',
    'grab', 'hand1', 'openhand', 'grabbing', 'closedhand', 'all-scroll', 'col-resize', 'row-resize',
    'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize',
    'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'all-resize',
    'zoom-in', 'zoom-out', 'dnd-move', 'dnd-copy', 'dnd-link', 'dnd-none', 'dnd-ask',
];

/** Reads "WxH@x,y" for every image in an Xcursor file. */
function xcursorSignatures(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 16 || view.getUint32(0, true) !== XCURSOR_MAGIC)
        return [];

    const signatures = [];
    const count = view.getUint32(12, true);
    for (let i = 0; i < count; i++) {
        const entry = 16 + i * 12;
        if (entry + 12 > bytes.byteLength)
            break;
        if (view.getUint32(entry, true) !== XCURSOR_IMAGE_TYPE)
            continue;
        const pos = view.getUint32(entry + 8, true);
        if (pos + 32 > bytes.byteLength)
            continue;
        const width = view.getUint32(pos + 16, true);
        const height = view.getUint32(pos + 20, true);
        const xhot = view.getUint32(pos + 24, true);
        const yhot = view.getUint32(pos + 28, true);
        signatures.push(`${width}x${height}@${xhot},${yhot}`);
        // On HiDPI screens Mutter rounds the hotspot to a multiple of the scale.
        for (const scale of [2, 3, 4]) {
            const x = Math.round(xhot / scale) * scale;
            const y = Math.round(yhot / scale) * scale;
            if (x !== xhot || y !== yhot)
                signatures.push(`${width}x${height}@${x},${y}`);
        }
    }
    return signatures;
}

function themeDirs(theme) {
    const bases = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']),
        GLib.build_filenamev([GLib.get_home_dir(), '.icons']),
        ...GLib.get_system_data_dirs().map(dir => GLib.build_filenamev([dir, 'icons'])),
        '/usr/share/pixmaps',
    ];
    return bases.map(base => GLib.build_filenamev([base, theme]));
}

/** The theme followed by everything it inherits from, ending with the usual fallbacks. */
function themeChain(theme) {
    const chain = [];
    const visit = name => {
        if (!name || chain.includes(name) || chain.length > 12)
            return;
        chain.push(name);
        for (const dir of themeDirs(name)) {
            const keyFile = new GLib.KeyFile();
            try {
                keyFile.load_from_file(GLib.build_filenamev([dir, 'index.theme']), GLib.KeyFileFlags.NONE);
                const inherits = keyFile.get_string('Icon Theme', 'Inherits');
                for (const parent of inherits.split(','))
                    visit(parent.trim());
                break;
            } catch {
                // No index.theme here, or no Inherits key.
            }
        }
    };
    visit(theme);
    visit('default');
    visit('Adwaita');
    return chain;
}

export class CursorShapes {
    /**
     * @param {Meta.CursorTracker} tracker
     * @param {Function} log - debug logger
     */
    constructor(tracker, log) {
        this._tracker = tracker;
        this._log = log;
        this._signatures = new Map();
        this._loadedTheme = null;
        this._loading = null;
        this._destroyed = false;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::cursor-theme', () => {
            if (this._loadedTheme !== null)
                this.load();
        }, this);
    }

    /** Starts reading the cursor theme in the background (once). */
    ensureLoaded() {
        if (this._loadedTheme === null && !this._loading)
            this.load();
    }

    load() {
        const theme = this._interface.get_string('cursor-theme') || 'default';
        this._loadedTheme = theme;
        const loading = this._read(theme).then(signatures => {
            if (this._destroyed || this._loading !== loading)
                return;
            this._signatures = signatures;
            this._loading = null;
            const counts = {pointer: 0, text: 0};
            for (const shape of signatures.values())
                counts[shape]++;
            this._log(`cursor theme "${theme}": ${counts.pointer} hand and ${counts.text} text pointer images recognised`);
        }).catch(e => {
            if (this._loading === loading)
                this._loading = null;
            logError(e, '[autoscroll] reading the cursor theme');
        });
        this._loading = loading;
    }

    /** @returns {'hidden'|'pointer'|'text'|'other'} */
    classify() {
        const sprite = this._tracker.get_sprite();
        if (!sprite)
            return 'hidden';
        const [x, y] = this._tracker.get_hot();
        return this._signatures.get(`${sprite.get_width()}x${sprite.get_height()}@${x},${y}`) ?? 'other';
    }

    /** The current pointer's size and hotspot, for debug logging. */
    describe() {
        const sprite = this._tracker.get_sprite();
        if (!sprite)
            return 'no pointer image';
        const [x, y] = this._tracker.get_hot();
        return `${sprite.get_width()}x${sprite.get_height()}@${x},${y}`;
    }

    destroy() {
        this._destroyed = true;
        this._interface.disconnectObject(this);
    }

    async _read(theme) {
        const chain = themeChain(theme);
        const owners = new Map();
        const add = (signature, shape) => {
            const owner = owners.get(signature);
            if (owner === undefined)
                owners.set(signature, shape);
            else if (owner !== shape)
                owners.set(signature, 'other');
        };

        const lookups = [];
        for (const [shape, names] of Object.entries(SHAPES))
            lookups.push(...names.map(name => ({name, shape})));
        lookups.push(...OTHERS.map(name => ({name, shape: 'other'})));

        await Promise.all(lookups.map(async ({name, shape}) => {
            const bytes = await this._load(chain, name);
            if (bytes)
                xcursorSignatures(bytes).forEach(sig => add(sig, shape));
        }));

        const signatures = new Map();
        for (const [signature, shape] of owners) {
            if (shape !== 'other')
                signatures.set(signature, shape);
        }
        return signatures;
    }

    /** The first file called `name` in the theme chain, like libXcursor looks it up. */
    async _load(chain, name) {
        for (const theme of chain) {
            for (const dir of themeDirs(theme)) {
                const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'cursors', name]));
                try {
                    const [bytes] = await file.load_contents_async(null);
                    return bytes;
                } catch {
                    // Not in this directory; keep looking.
                }
            }
        }
        return null;
    }
}
