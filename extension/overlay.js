// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// What you see while autoscrolling, drawn the way Windows does it:
//
//  * the origin marker, a white disc with arrows that stays where you clicked
//    (two arrows when only vertical scrolling is on, four otherwise);
//  * the pan cursor that replaces the mouse pointer: a dot, plus an arrow
//    showing which way the window is scrolling once you've moved out of the
//    dead zone around the marker.
//
// Everything is drawn with Cairo at the current cursor size and display
// scale, so it stays sharp with large cursors and on HiDPI screens.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAU = Math.PI * 2;

// Everything below is measured at the default 24 px cursor size and scaled
// with the cursor size setting.
const BASE_CURSOR_SIZE = 24;

const MARKER_RADIUS = 14;
const MARKER_PAD = 4;
// The arrows and centre dot on the marker.
const GLYPH_TIP = 10.5;
const GLYPH_BASE = 6.5;
const GLYPH_HALF_WIDTH = 3.75;
const GLYPH_DOT = 2;
// The pan cursor's dot and arrow.
const ARROW_TIP = 15.5;
const ARROW_BASE = 7;
const ARROW_HALF_WIDTH = 6.5;
const ARROW_DOT = 2.75;
const CURSOR_EXTENT = 21;

const INK = [0.12, 0.12, 0.12];

const ANGLES = {
    n: -TAU / 4, ne: -TAU / 8, e: 0, se: TAU / 8,
    s: TAU / 4, sw: TAU * 3 / 8, w: TAU / 2, nw: -TAU * 3 / 8,
};

/** Adds a triangle pointing at `angle`, with its tip `tip` away from (cx, cy). */
function triangle(cr, cx, cy, angle, tip, base, halfWidth) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const at = (along, across) => [cx + cos * along - sin * across, cy + sin * along + cos * across];
    cr.moveTo(...at(tip, 0));
    cr.lineTo(...at(base, halfWidth));
    cr.lineTo(...at(base, -halfWidth));
    cr.closePath();
}

/** The marker's four (or, for vertical scrolling only, two) arrows and centre dot. */
function glyphPath(cr, c, u, verticalOnly) {
    const angles = verticalOnly ? [ANGLES.n, ANGLES.s] : [ANGLES.n, ANGLES.e, ANGLES.s, ANGLES.w];
    for (const angle of angles)
        triangle(cr, c, c, angle, GLYPH_TIP * u, GLYPH_BASE * u, GLYPH_HALF_WIDTH * u);
    cr.newSubPath();
    cr.arc(c, c, GLYPH_DOT * u, 0, TAU);
}

/**
 * The pan cursor: a dot at the hotspot, plus an arrow pointing the way the
 * window scrolls once you've moved out of the dead zone. At rest the dot sits
 * right on the marker's centre dot.
 */
function cursorPath(cr, c, u, angle) {
    if (angle !== undefined)
        triangle(cr, c, c, angle, ARROW_TIP * u, ARROW_BASE * u, ARROW_HALF_WIDTH * u);
    cr.newSubPath();
    cr.arc(c, c, ARROW_DOT * u, 0, TAU);
}

/** Black shape with a white outline and a soft shadow, like a mouse pointer. */
function paintPointerShape(cr, u, path) {
    cr.setLineJoin(Cairo.LineJoin.ROUND);

    cr.save();
    cr.translate(0, 0.9 * u);
    path();
    cr.setSourceRGBA(0, 0, 0, 0.22);
    cr.setLineWidth(3.6 * u);
    cr.strokePreserve();
    cr.setLineWidth(5 * u);
    cr.setSourceRGBA(0, 0, 0, 0.08);
    cr.stroke();
    cr.restore();

    path();
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.setLineWidth(2.6 * u);
    cr.strokePreserve();
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.fill();
}

export class Overlay {
    constructor() {
        this._verticalOnly = false;
        this._direction = null;
        this._unit = 1;

        this._group = new Clutter.Actor({reactive: false, visible: false});
        this._marker = new St.DrawingArea({reactive: false});
        this._cursor = new St.DrawingArea({reactive: false});
        this._group.add_child(this._marker);
        this._group.add_child(this._cursor);
        Main.layoutManager.uiGroup.add_child(this._group);

        this._marker.connect('repaint', area => this._paintMarker(area));
        this._cursor.connect('repaint', area => this._paintCursor(area));

        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::cursor-size', () => this._updateSize(), this);
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._themeContext.connectObject('notify::scale-factor', () => this._updateSize(), this);
        this._updateSize();
    }

    /** The cursor actor; autoscroll's frame clock follows the monitor it's on. */
    get cursorActor() {
        return this._cursor;
    }

    show(x, y, verticalOnly) {
        this._group.remove_all_transitions();
        this._group.opacity = 255;
        if (verticalOnly !== this._verticalOnly) {
            this._verticalOnly = verticalOnly;
            this._marker.queue_repaint();
        }
        this._direction = null;
        this._cursor.queue_repaint();
        this._place(this._marker, x, y);
        this._place(this._cursor, x, y);

        const parent = this._group.get_parent();
        parent.set_child_above_sibling(this._group, null);
        this._group.show();
    }

    /**
     * @param {number} x - pointer position
     * @param {number} y - pointer position
     * @param {string|null} direction - n, ne, e, se, s, sw, w, nw, or null in the dead zone
     */
    moveCursor(x, y, direction) {
        this._place(this._cursor, x, y);
        if (direction !== this._direction) {
            this._direction = direction;
            this._cursor.queue_repaint();
        }
    }

    hide() {
        if (!this._group.visible)
            return;
        this._group.ease({
            opacity: 0,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                this._group.hide();
                this._group.opacity = 255;
            },
        });
    }

    destroy() {
        this._interface.disconnectObject(this);
        this._themeContext.disconnectObject(this);
        this._group.destroy();
    }

    _updateSize() {
        const cursorSize = this._interface.get_int('cursor-size') || BASE_CURSOR_SIZE;
        this._unit = cursorSize / BASE_CURSOR_SIZE * this._themeContext.scale_factor;

        const markerSize = Math.ceil(2 * (MARKER_RADIUS + MARKER_PAD) * this._unit);
        const cursorSize2 = Math.ceil(2 * CURSOR_EXTENT * this._unit);
        this._marker.set_size(markerSize, markerSize);
        this._cursor.set_size(cursorSize2, cursorSize2);
        this._marker.queue_repaint();
        this._cursor.queue_repaint();
    }

    _place(actor, x, y) {
        actor.set_position(Math.round(x - actor.width / 2), Math.round(y - actor.height / 2));
    }

    _paintMarker(area) {
        const cr = area.get_context();
        const [width] = area.get_surface_size();
        const u = this._unit;
        const c = width / 2;
        const r = MARKER_RADIUS * u;

        // Soft shadow under the disc.
        const shadow = new Cairo.RadialGradient(c, c + u, r - 2 * u, c, c + u, r + MARKER_PAD * u);
        shadow.addColorStopRGBA(0, 0, 0, 0, 0.26);
        shadow.addColorStopRGBA(1, 0, 0, 0, 0);
        cr.setSource(shadow);
        cr.arc(c, c + u, r + MARKER_PAD * u, 0, TAU);
        cr.fill();

        // White disc with a thin grey rim.
        cr.arc(c, c, r - 0.5 * u, 0, TAU);
        cr.setSourceRGBA(1, 1, 1, 0.97);
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, 0.38);
        cr.setLineWidth(Math.max(1, u));
        cr.stroke();

        // Arrows and centre dot.
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        glyphPath(cr, c, u, this._verticalOnly);
        cr.setSourceRGBA(...INK, 1);
        cr.setLineWidth(0.6 * u);
        cr.strokePreserve();
        cr.fill();

        cr.$dispose();
    }

    _paintCursor(area) {
        const cr = area.get_context();
        const [width] = area.get_surface_size();
        const u = this._unit;
        const c = width / 2;

        paintPointerShape(cr, u, () => cursorPath(cr, c, u, ANGLES[this._direction]));

        cr.$dispose();
    }
}
