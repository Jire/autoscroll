// SPDX-License-Identifier: GPL-2.0-or-later
// GTK 3 scroll test client: prints {"ev":"position","y":...} as it scrolls.
imports.gi.versions.Gtk = '3.0';
const {GLib, Gtk} = imports.gi;
const title = ARGV[0] ?? 'GTK3 test';
const started = GLib.get_monotonic_time();
const emit = f => print(JSON.stringify({t: Math.round((GLib.get_monotonic_time() - started) / 1000), ...f}));
Gtk.init(null);
const win = new Gtk.Window({title, default_width: 900, default_height: 700});
const area = new Gtk.DrawingArea();
area.set_size_request(4000, 40000);
const sw = new Gtk.ScrolledWindow({hexpand: true, vexpand: true});
sw.add(area);
win.add(sw);
const adj = sw.get_vadjustment();
adj.connect('value-changed', () => emit({ev: 'position', x: 0, y: Math.round(adj.value * 10) / 10}));
win.connect('destroy', () => Gtk.main_quit());
win.show_all();
emit({ev: 'ready'});
Gtk.main();
