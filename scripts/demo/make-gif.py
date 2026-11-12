#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# SPDX-FileCopyrightText: 2026 Jire
"""Turns the frames saved by record.js into docs/demo.gif.

Screenshots of the headless shell don't include the mouse pointer, so the
normal Adwaita arrow is drawn in where it was, outside autoscroll. (During
autoscroll the pan cursor is part of the screenshot already.)"""
import json
import struct
import sys

from PIL import Image

WIDTH = 800


def adwaita_arrow():
    data = open('/usr/share/icons/Adwaita/cursors/default', 'rb').read()
    count = struct.unpack_from('<I', data, 12)[0]
    best = None
    for i in range(count):
        kind, _, pos = struct.unpack_from('<III', data, 16 + i * 12)
        if kind != 0xfffd0002:
            continue
        _, _, nominal, _, w, h, xhot, yhot, _ = struct.unpack_from('<9I', data, pos)
        if nominal == 24:
            best = (w, h, xhot, yhot, pos + 36)
    w, h, xhot, yhot, start = best
    argb = data[start:start + w * h * 4]
    pixels = bytearray()
    for i in range(0, len(argb), 4):
        b, g, r, a = argb[i:i + 4]
        if a:  # premultiplied -> straight alpha
            r, g, b = (min(255, c * 255 // a) for c in (r, g, b))
        pixels += bytes((r, g, b, a))
    return Image.frombytes('RGBA', (w, h), bytes(pixels)), xhot, yhot


def main(frames_json, out):
    raw = json.load(open(frames_json))
    frames = json.loads(raw) if isinstance(raw, str) else raw
    arrow, xhot, yhot = adwaita_arrow()
    images, durations = [], []
    for i, f in enumerate(frames):
        im = Image.open(f['name']).convert('RGBA')
        if not f['session']:
            im.alpha_composite(arrow, (round(f['x']) - xhot, round(f['y']) - yhot))
        scale = WIDTH / im.width
        im = im.resize((WIDTH, round(im.height * scale)), Image.LANCZOS).convert('RGB')
        images.append(im)
        nxt = frames[i + 1]['t'] if i + 1 < len(frames) else f['t'] + 80000
        durations.append(max(40, round((nxt - f['t']) / 1000)))
    durations[-1] = 1500  # pause before it loops
    # One palette for every frame (so colours don't flicker), built from a
    # sample of frames so it covers everything that scrolls past.
    sample = images[::max(1, len(images) // 12)]
    mosaic = Image.new('RGB', (WIDTH, sum(im.height for im in sample)))
    y = 0
    for im in sample:
        mosaic.paste(im, (0, y))
        y += im.height
    palette = mosaic.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
    frames_p = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in images]
    frames_p[0].save(out, save_all=True, append_images=frames_p[1:], duration=durations, loop=0, optimize=True, disposal=1)
    print(f'{out}: {len(images)} frames, {sum(durations) / 1000:.1f} s')


if __name__ == '__main__':
    main(*sys.argv[1:])
