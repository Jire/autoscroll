// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 Jire
//
// Run with P = {wmClass}, in a browser showing page.html. Regression test for
// "the second autoscroll scrolls on its own": apps fling a scroll gesture on
// when it ends, and Chromium used to fling at the speed of the previous
// autoscroll when the next one started. A real hand is never perfectly still,
// so the mouse jitters by a pixel while "resting".
//
// Returns, for each moment where nothing should move, the page position every
// 100 ms relative to the start of that moment. Browsers show the last few
// scroll events up to ~150 ms late, so only movement after that counts.
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
    const y = () => Number(/Y=(-?\d+)/.exec(find().get_title())[1]);
    const rest = async ms => {
        const start = y();
        const samples = [];
        for (let t = 0; t < ms; t += 100) {
            for (let k = 0; k < 2; k++) {
                AS.move(k ? 1 : -1, 0);
                await AS.sleep(50);
            }
            samples.push(y() - start);
        }
        return samples;
    };
    AS.moveTo(r.x + Math.round(r.width / 2), r.y + 260);
    await AS.sleep(200);
    await AS.key(AS.Clutter.KEY_Home);
    await AS.sleep(600);

    const out = {};
    // 1. Scroll down, and click to stop while still scrolling.
    await AS.click('middle');
    await AS.glide(0, 180, 60, 6);
    await AS.sleep(900);
    await AS.click('left');
    out.afterStop = await rest(1200);
    // 2. Move somewhere else, middle-click again, and keep the mouse there.
    await AS.glide(40, 220, 200, 12);
    await AS.sleep(80);
    await AS.click('middle');
    out.afterSecondClick = await rest(1500);
    // 3. Scroll up a little, come back to the marker and rest there.
    await AS.glide(0, -160, 60, 6);
    await AS.sleep(700);
    await AS.glide(0, 160, 60, 6);
    out.restingOnMarker = await rest(1500);
    await AS.click('left');
    out.afterFinalStop = await rest(800);
    out.state = AS.state();
    return JSON.stringify(out);
})();
