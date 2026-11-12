// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Run by record.sh inside the headless shell: autoscrolls demo.html in Firefox
// with a virtual mouse and saves a screenshot of the window for every frame.
(async () => {
    await AS.ready();
    const w = global.get_window_actors().map(a => a.meta_window)
        .find(win => (win.get_title() ?? '').includes('field guide'));
    if (!w)
        return 'no demo window';
    w.activate(global.get_current_time());
    await AS.sleep(1200);
    const r = w.get_frame_rect();
    const dir = GLib.getenv('DEMO_DIR');
    const frames = [];
    let index = 0;
    const shoot = async () => {
        const t = GLib.get_monotonic_time();
        const name = `${dir}/frame-${String(index).padStart(3, '0')}.png`;
        const stream = Gio.File.new_for_path(name).replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot_area(r.x, r.y, r.width, r.height, stream);
        stream.close(null);
        const s = AS.state();
        frames.push({name, t, session: !!s.session, x: s.pointer.x - r.x, y: s.pointer.y - r.y});
        index++;
    };
    const frame = async (count, move = null) => {
        for (let k = 0; k < count; k++) {
            if (move)
                move();
            await AS.sleep(45);
            await shoot();
        }
    };

    AS.moveTo(r.x + 380, r.y + 210);
    await AS.sleep(150);
    await frame(10, () => AS.move(14, 6));     // hand moves in
    await frame(6);
    AS.press('middle');
    await AS.sleep(70);
    AS.release('middle');
    await frame(5);                             // marker appears
    await frame(9, () => AS.move(0, 15));       // down: slow, then steady
    await frame(22);
    await frame(8, () => AS.move(0, 13));       // further down: faster
    await frame(10);
    await frame(9, () => AS.move(0, -42));      // above the marker: back up
    await frame(14);
    await frame(6, () => AS.move(0, 12));       // back to the marker: stop
    await frame(4);
    AS.press('left');
    await AS.sleep(60);
    AS.release('left');
    await frame(12);
    return JSON.stringify(frames);
})();
