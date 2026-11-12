// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PATTERN_NAMES, WMCLASS_PREFIX} from './apps.js';

const ACTIVATIONS = [
    ['click-or-hold', 'Click or hold',
        'Click the middle button, move the mouse to scroll, click again to stop. Or hold the button, move, and let go. Like Windows.'],
    ['hold', 'Hold only',
        'Scrolls only while the middle button is held down, so a quick middle-click still pastes, opens links and closes tabs.'],
];

const MODIFIERS = [
    ['none', 'No key'],
    ['ctrl', 'Ctrl'],
    ['shift', 'Shift'],
    ['alt', 'Alt'],
    ['super', 'Super'],
];

/** A combo row bound to a string setting with fixed choices. */
function choiceRow(settings, key, title, choices, subtitleFor = null) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const value = settings.get_string(key);
        const index = choices.findIndex(([id]) => id === value);
        row.selected = Math.max(index, 0);
        if (subtitleFor)
            row.subtitle = subtitleFor(choices[row.selected]);
    };
    sync();
    const changedId = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const id = choices[row.selected]?.[0];
        if (id && id !== settings.get_string(key))
            settings.set_string(key, id);
    });
    row.connect('destroy', () => settings.disconnect(changedId));
    return row;
}

function installedApps() {
    const apps = new Map();
    for (const info of Gio.AppInfo.get_all()) {
        const id = info.get_id();
        if (id)
            apps.set(id.toLowerCase(), info);
    }
    return apps;
}

export default class AutoscrollPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 860);
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'Autoscroll',
            icon_name: 'input-mouse-symbolic',
        });
        window.add(page);

        if (GLib.getenv('XDG_SESSION_TYPE') === 'x11') {
            const warning = new Adw.PreferencesGroup();
            warning.add(new Adw.ActionRow({
                title: 'Autoscroll needs GNOME on Wayland',
                subtitle: 'On an X11 session apps get mouse clicks directly from the X server, so GNOME Shell can\'t turn a middle-click into autoscroll. Choose “GNOME” rather than “GNOME on Xorg” on the login screen.',
                icon_name: 'dialog-warning-symbolic',
                css_classes: ['error'],
            }));
            page.add(warning);
        }

        page.add(this._tryItGroup());
        page.add(this._behaviourGroup(settings));
        page.add(this._passThroughGroup(settings));
        page.add(this._appsGroup(settings, window));

        const troubleshooting = new Adw.PreferencesGroup({title: 'Troubleshooting'});
        const debug = new Adw.SwitchRow({
            title: 'Debug logging',
            subtitle: 'Log why each middle-click did or didn’t start autoscroll (journalctl --user -f -g autoscroll)',
        });
        settings.bind('debug', debug, 'active', Gio.SettingsBindFlags.DEFAULT);
        troubleshooting.add(debug);
        page.add(troubleshooting);
    }

    _tryItGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Try It Here',
            description: 'Click the middle mouse button in the box below, then move the mouse up or down. The further you move, the faster it scrolls. Click again to stop.',
        });
        const lines = [];
        for (let i = 1; i <= 120; i++) {
            const hint = [
                'Move the mouse down to scroll down, up to scroll up.',
                'Move a little for a slow, steady scroll; further for faster.',
                'Any click or key press stops it.',
                'Hold the middle button instead to scroll only while it’s held.',
            ][i % 4];
            lines.push(`${String(i).padStart(3, ' ')}   ${hint}`);
        }
        const label = new Gtk.Label({
            label: lines.join('\n'),
            xalign: 0,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14,
            css_classes: ['monospace', 'dim-label'],
        });
        const scrolled = new Gtk.ScrolledWindow({
            child: label,
            height_request: 170,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        const frame = new Gtk.Frame({child: scrolled, css_classes: ['view']});
        group.add(frame);
        return group;
    }

    _behaviourGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Scrolling'});

        group.add(choiceRow(settings, 'activation', 'Middle button', ACTIVATIONS,
            ([, , description]) => description));

        const speedRow = new Adw.ActionRow({
            title: 'Speed',
            subtitle: 'How fast it scrolls for a given distance from where you clicked',
        });
        // The slider works in powers of two, so 1× (the Windows speed) is in the middle.
        const adjustment = new Gtk.Adjustment({lower: -2, upper: 2, step_increment: 0.05, page_increment: 0.5});
        const syncSlider = () => {
            const value = Math.log2(settings.get_double('speed'));
            if (Math.abs(adjustment.value - value) > 1e-6)
                adjustment.value = value;
        };
        syncSlider();
        const speedChanged = settings.connect('changed::speed', syncSlider);
        speedRow.connect('destroy', () => settings.disconnect(speedChanged));
        adjustment.connect('value-changed', () => {
            const speed = Math.round(2 ** adjustment.value * 100) / 100;
            if (Math.abs(speed - settings.get_double('speed')) > 1e-6)
                settings.set_double('speed', speed);
        });
        const scale = new Gtk.Scale({
            adjustment,
            digits: 2,
            draw_value: true,
            value_pos: Gtk.PositionType.LEFT,
            hexpand: true,
            width_request: 260,
            valign: Gtk.Align.CENTER,
        });
        scale.set_format_value_func((_scale, value) => `${(2 ** value).toFixed(2).replace(/\.?0+$/, '')}×`);
        scale.add_mark(-2, Gtk.PositionType.BOTTOM, 'Slower');
        scale.add_mark(0, Gtk.PositionType.BOTTOM, 'Windows');
        scale.add_mark(2, Gtk.PositionType.BOTTOM, 'Faster');
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to the Windows speed',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.reset('speed'));
        speedRow.add_suffix(scale);
        speedRow.add_suffix(reset);
        group.add(speedRow);

        const vertical = new Adw.SwitchRow({
            title: 'Vertical scrolling only',
            subtitle: 'Ignore sideways mouse movement',
        });
        settings.bind('vertical-only', vertical, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(vertical);
        return group;
    }

    _passThroughGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Normal Middle-Click',
            description: 'In these cases a middle-click goes to the app as usual instead of starting autoscroll.',
        });

        const links = new Adw.SwitchRow({
            title: 'On links',
            subtitle: 'When the pointer is a hand, so links still open in a new tab',
        });
        settings.bind('pass-through-links', links, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(links);

        const top = new Adw.ExpanderRow({
            title: 'Near the top of windows',
            subtitle: 'Title bars and browser tabs, so middle-clicking a tab still closes it',
            show_enable_switch: true,
        });
        settings.bind('pass-through-top', top, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        const height = new Adw.SpinRow({
            title: 'Height',
            subtitle: 'Pixels from the top edge of the window',
            adjustment: new Gtk.Adjustment({lower: 8, upper: 240, step_increment: 4, page_increment: 16}),
        });
        settings.bind('top-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);
        top.add_row(height);
        group.add(top);

        const text = new Adw.SwitchRow({
            title: 'On text',
            subtitle: 'When the pointer is a text cursor, for middle-click paste. Web pages show it over all their text, so autoscroll won’t start there either.',
        });
        settings.bind('pass-through-text', text, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(text);

        group.add(choiceRow(settings, 'pass-through-modifier', 'While holding', MODIFIERS,
            ([id, label]) => id === 'none'
                ? 'No key sends a normal middle-click'
                : `Hold ${label} while middle-clicking to send a normal middle-click`));
        return group;
    }

    _appsGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Apps Without Autoscroll',
            description: 'These apps keep the middle button to themselves: terminals paste with it, and drawing, 3D and remote-desktop apps pan or pass it on.',
        });

        const buttons = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        const add = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Add App'}),
            css_classes: ['flat'],
        });
        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Restore the default list',
            css_classes: ['flat'],
        });
        buttons.append(add);
        buttons.append(resetButton);
        group.set_header_suffix(buttons);

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];

            const apps = installedApps();
            const entries = settings.get_strv('excluded-apps');
            const shown = [];
            for (const entry of entries) {
                if (entry.startsWith(WMCLASS_PREFIX)) {
                    const pattern = entry.slice(WMCLASS_PREFIX.length);
                    shown.push({entry, name: PATTERN_NAMES[entry] ?? pattern, subtitle: `Windows with class “${pattern}”`});
                } else {
                    const info = apps.get(entry.toLowerCase());
                    // Default entries for apps that aren't installed are kept but not shown.
                    if (info)
                        shown.push({entry, name: info.get_name(), subtitle: entry, gicon: info.get_icon()});
                }
            }
            shown.sort((a, b) => a.name.localeCompare(b.name));

            for (const item of shown) {
                const row = new Adw.ActionRow({title: item.name, subtitle: item.subtitle});
                row.add_prefix(item.gicon
                    ? new Gtk.Image({gicon: item.gicon, pixel_size: 32})
                    : new Gtk.Image({icon_name: 'application-x-executable-symbolic', pixel_size: 32}));
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Use autoscroll in this app',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv('excluded-apps',
                        settings.get_strv('excluded-apps').filter(e => e !== item.entry));
                });
                row.add_suffix(remove);
                group.add(row);
                rows.push(row);
            }

            if (!rows.length) {
                const empty = new Adw.ActionRow({
                    title: 'Autoscroll works in every app',
                    subtitle: 'Use “Add App” to leave the middle button alone in an app.',
                    sensitive: false,
                });
                group.add(empty);
                rows.push(empty);
            }
        };
        rebuild();
        const changedId = settings.connect('changed::excluded-apps', rebuild);
        group.connect('destroy', () => settings.disconnect(changedId));

        add.connect('clicked', () => this._showAppPicker(window, settings));
        resetButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: 'Restore the default list?',
                body: 'Terminals, drawing, 3D, CAD and remote-desktop apps, Steam games and Wine apps will be on the list again, and apps you added will be removed from it.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('reset', 'Restore');
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_dialog, response) => {
                if (response === 'reset')
                    settings.reset('excluded-apps');
            });
            dialog.present(window);
        });
        return group;
    }

    _showAppPicker(window, settings) {
        const dialog = new Adw.Dialog({
            title: 'Add App',
            content_width: 440,
            content_height: 620,
        });
        const view = new Adw.ToolbarView();
        view.add_top_bar(new Adw.HeaderBar());

        const search = new Gtk.SearchEntry({placeholder_text: 'Search apps', hexpand: true});
        const searchBar = new Gtk.Box({margin_start: 12, margin_end: 12, margin_top: 6, margin_bottom: 6});
        searchBar.append(search);
        view.add_top_bar(searchBar);

        const excluded = new Set(settings.get_strv('excluded-apps').map(e => e.toLowerCase()));
        const add = entry => {
            const current = settings.get_strv('excluded-apps');
            if (!current.some(e => e.toLowerCase() === entry.toLowerCase()))
                settings.set_strv('excluded-apps', [...current, entry]);
            dialog.close();
        };

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 12,
        });
        const apps = Gio.AppInfo.get_all()
            .filter(info => info.should_show() && info.get_id() && !excluded.has(info.get_id().toLowerCase()))
            .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        for (const info of apps) {
            const row = new Adw.ActionRow({title: info.get_name(), activatable: true});
            row._search = `${info.get_name()} ${info.get_id()} ${info.get_description() ?? ''}`.toLowerCase();
            row.add_prefix(new Gtk.Image({gicon: info.get_icon(), pixel_size: 32}));
            row.connect('activated', () => add(info.get_id()));
            list.append(row);
        }
        list.set_filter_func(row => {
            const query = search.text.trim().toLowerCase();
            return !query || row._search.includes(query);
        });
        search.connect('search-changed', () => list.invalidate_filter());
        search.connect('activate', () => {
            for (let row = list.get_first_child(); row; row = row.get_next_sibling()) {
                if (row.get_child_visible()) {
                    row.emit('activated');
                    return;
                }
            }
        });

        const advanced = new Adw.PreferencesGroup({
            title: 'By Window Class',
            description: 'For apps that aren’t listed (games, Wine and Java apps). Use * and ? as wildcards.',
            margin_start: 12,
            margin_end: 12,
            margin_bottom: 18,
        });
        const classRow = new Adw.EntryRow({title: 'Window class', show_apply_button: true});
        classRow.connect('apply', () => {
            const pattern = classRow.text.trim();
            if (pattern)
                add(`${WMCLASS_PREFIX}${pattern}`);
        });
        advanced.add(classRow);

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(list);
        content.append(advanced);
        view.content = new Gtk.ScrolledWindow({
            child: content,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vexpand: true,
        });
        dialog.child = view;
        dialog.present(window);
        search.grab_focus();
    }
}
