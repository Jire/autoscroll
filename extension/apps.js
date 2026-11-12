// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// The "apps without autoscroll" list: matching windows against it, and the
// names shown for its entries. Also imported by prefs.js, so it must not
// import anything from GNOME Shell.

export const WMCLASS_PREFIX = 'wmclass:';

// Friendly names for the window-class patterns in the default list.
export const PATTERN_NAMES = {
    'wmclass:steam_app_*': 'Steam games',
    'wmclass:gamescope': 'Gamescope',
    'wmclass:*.exe': 'Windows apps (Wine and Proton)',
    'wmclass:VirtualBox Machine': 'VirtualBox virtual machines',
    'wmclass:RuneLite': 'RuneLite',
    'wmclass:net-runelite-*': 'RuneLite (launcher)',
};

/** Turns a pattern with * and ? wildcards into an anchored, case-insensitive RegExp. */
export function globToRegExp(glob) {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

export class AppRules {
    /** @param {string[]} entries - the excluded-apps setting */
    constructor(entries) {
        this._appIds = new Map();
        this._patterns = [];
        for (const raw of entries) {
            const entry = raw.trim();
            if (entry.startsWith(WMCLASS_PREFIX)) {
                const pattern = entry.slice(WMCLASS_PREFIX.length).trim();
                if (pattern)
                    this._patterns.push({entry, regexp: globToRegExp(pattern)});
            } else if (entry) {
                this._appIds.set(entry.toLowerCase(), entry);
            }
        }
    }

    /**
     * @param {{appIds: string[], wmClasses: string[]}} ids - what the window is known as
     * @returns {string|null} the entry that matches, if any
     */
    match({appIds, wmClasses}) {
        for (const id of appIds) {
            const entry = this._appIds.get(id.toLowerCase());
            if (entry)
                return entry;
        }
        for (const {entry, regexp} of this._patterns) {
            if (wmClasses.some(wmClass => regexp.test(wmClass)))
                return entry;
        }
        return null;
    }
}
