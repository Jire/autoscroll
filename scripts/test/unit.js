// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Unit tests for the parts that don't need GNOME Shell. Run: gjs -m scripts/test/unit.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// GNOME Shell adds connectObject() to every GObject; stand in for it.
Gio.Settings.prototype.connectObject ??= function () {};
Gio.Settings.prototype.disconnectObject ??= function () {};
globalThis.logError ??= (e, msg) => printerr(`${msg}: ${e}`);

const here = GLib.path_get_dirname(System.programPath);
const ext = GLib.build_filenamev([here, '..', '..', 'extension']);
const {AppRules, globToRegExp} = await import(`file://${ext}/apps.js`);
const {CursorShapes} = await import(`file://${ext}/cursorShapes.js`);

let failures = 0;
const check = (cond, msg) => {
    if (!cond) {
        failures++;
        printerr(`FAIL ${msg}`);
    } else {
        print(`ok   ${msg}`);
    }
};

// ---- AppRules
const rules = new AppRules(['org.gnome.Ptyxis.desktop', 'wmclass:steam_app_*', 'wmclass:*.exe', 'wmclass:RuneLite', '  ']);
check(rules.match({appIds: ['org.gnome.Ptyxis.desktop'], wmClasses: []}) === 'org.gnome.Ptyxis.desktop', 'app id matches');
check(rules.match({appIds: ['ORG.GNOME.PTYXIS.DESKTOP'], wmClasses: []}) !== null, 'app ids match case-insensitively');
check(rules.match({appIds: ['window:12'], wmClasses: ['steam_app_1343370']}) === 'wmclass:steam_app_*', 'wildcard window class');
check(rules.match({appIds: [], wmClasses: ['notepad++.exe']}) === 'wmclass:*.exe', 'Wine window class');
check(rules.match({appIds: [], wmClasses: ['runelite']}) === 'wmclass:RuneLite', 'window classes match case-insensitively');
check(rules.match({appIds: ['org.mozilla.firefox.desktop'], wmClasses: ['firefox']}) === null, 'other apps do not match');
check(globToRegExp('a.b?c*').test('a.bXcYZ') && !globToRegExp('a.b').test('aXb'), 'globs escape dots');

// ---- CursorShapes against the installed Adwaita theme
// Expected sizes and hotspots are read from the theme files here (Adwaita's
// cursors changed in GNOME 47), independently of cursorShapes.js.
const imagesOf = name => {
    const [, bytes] = GLib.file_get_contents(`/usr/share/icons/Adwaita/cursors/${name}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(12, true);
    const images = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(16 + i * 12, true) !== 0xfffd0002)
            continue;
        const pos = view.getUint32(16 + i * 12 + 8, true);
        images.push([16, 20, 24, 28].map(o => view.getUint32(pos + o, true)));
    }
    return images.sort((a, b) => a[0] - b[0]);
};
const firstImage = name => imagesOf(name)[0];
const sprite = ([w, h, x, y]) => ({
    get_sprite: () => ({get_width: () => w, get_height: () => h}),
    get_hot: () => [x, y],
});
const shapes = new CursorShapes(sprite([24, 24, 0, 0]), () => {});
shapes._interface = {get_string: () => 'Adwaita'};
shapes.load();
await shapes._loading;
const classify = image => {
    shapes._tracker = sprite(image);
    return shapes.classify();
};
check(classify(firstImage('pointer')) === 'pointer', `Adwaita hand ${firstImage('pointer')} is a link pointer`);
check(classify(firstImage('text')) === 'text', `Adwaita I-beam ${firstImage('text')} is text`);
check(classify(firstImage('default')) === 'other', `Adwaita arrow ${firstImage('default')} is other`);
check(classify(firstImage('grab')) !== 'pointer', 'Adwaita open hand (grab) is not a link pointer');
check(imagesOf('pointer').every(image => classify(image) === 'pointer'),
    `Adwaita hand is a link pointer at every size (${imagesOf('pointer').map(i => i[0]).join(', ')} px)`);
shapes._tracker = {get_sprite: () => null, get_hot: () => [0, 0]};
check(shapes.classify() === 'hidden', 'no sprite means the app hid the pointer');

print(failures ? `${failures} failed` : 'all passed');
System.exit(failures ? 1 : 0);
