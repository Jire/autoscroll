// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Run by measure-browser.sh with P = {wmClass, source, distance, seconds}.
// Autoscrolls in the browser window showing page.html and reports, from the
// page's title, how far it scrolled and which mouse events the page received.
(async () => {
    await AS.ready();
    const find = () => global.get_window_actors().map(a => a.meta_window)
        .find(w => (w.get_wm_class() ?? '').toLowerCase().includes(P.wmClass) &&
            (w.get_title() ?? '').startsWith('Y='));
    const w = find();
    if (!w)
        return 'no browser window';
    w.activate(global.get_current_time());
    await AS.sleep(300);
    const r = w.get_frame_rect();
    const read = () => {
        const m = /Y=(-?\d+) X=(-?\d+) E=([^ ]*)/.exec(find().get_title());
        return {y: Number(m[1]), x: Number(m[2]), e: m[3]};
    };

    AS.moveTo(r.x + Math.round(r.width / 2), r.y + (P.y ?? 300));
    await AS.sleep(200);
    if (!P.keepPosition) {
        await AS.key(AS.Clutter.KEY_Home);
        await AS.sleep(500);
    }
    const before = read();
    if (P.source)
        AS.engine()._scrollSource = AS.Clutter.ScrollSource[P.source];
    const t0 = GLib.get_monotonic_time();
    await AS.click('middle');
    await AS.glide(P.dx ?? 0, P.distance, 60, 6);
    // Steady-state speed: sample the position 0.3 s and 0.3 + P.seconds s later.
    await AS.sleep(300);
    const s1 = {y: read().y, t: GLib.get_monotonic_time()};
    await AS.sleep(Math.round(P.seconds * 1000));
    const s2 = {y: read().y, t: GLib.get_monotonic_time()};
    const t1 = GLib.get_monotonic_time();
    await AS.click('left');
    const atEnd = read();
    await AS.sleep(1500);
    const after = read();
    return JSON.stringify({before, atEnd, after, seconds: (t1 - t0) / 1e6, steady: (s2.y - s1.y) / ((s2.t - s1.t) / 1e6), state: AS.state()});
})();
