#!/usr/bin/env python3
"""Read actual screenshot pixels at whitespace columns, not computed CSS.

Columns supplied by browser Range geometry lie inside spaces between glyphs.
Contiguous colored row bands therefore identify painted decorations without
confusing glyph strokes with underline or strike-through. No product imports.
"""
import json
import sys
from PIL import Image


def bands(rows):
    result = []
    for y in rows:
        if result and y == result[-1][-1] + 1:
            result[-1].append(y)
        else:
            result.append([y])
    return [[band[0], band[-1]] for band in result]


def inspect(filename, columns):
    image = Image.open(filename).convert('RGB')
    result = []
    for column in columns:
        x = round(column)
        rows = {key: [] for key in ['red', 'green', 'blue']}
        for y in range(image.height):
            pixels = [image.getpixel((min(image.width-1, max(0, x+dx)), y))
                      for dx in [-1, 0, 1]]
            for color, channel in [('red', 0), ('green', 1), ('blue', 2)]:
                if sum(p[channel] >= 140 and all(p[j] <= 100 for j in range(3) if j != channel)
                       for p in pixels) >= 2:
                    rows[color].append(y)
        result.append({'x': x, **{color: bands(ys) for color, ys in rows.items()}})
    return {'width': image.width, 'height': image.height, 'columns': result}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1], json.loads(sys.argv[2]))))
