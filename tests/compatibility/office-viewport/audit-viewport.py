#!/usr/bin/env python3
"""Read screenshots with Pillow and exported packages with stdlib ZIP/XML only."""
import json
import math
import sys
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def markers(file, geometry, colors):
    from PIL import Image, ImageChops
    image = Image.open(file).convert("RGB")
    scale = image.width / geometry["viewportWidth"]
    frame = geometry["iframe"]
    left = max(0, math.ceil(frame["x"] * scale))
    top = max(0, math.ceil(frame["y"] * scale))
    right = min(image.width, math.floor((frame["x"] + frame["width"]) * scale))
    bottom = min(image.height, math.floor((frame["y"] + frame["height"]) * scale))
    channels = image.crop((left, top, right, bottom)).split()
    found = {}
    for name, color in colors.items():
        rgb = tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))
        masks = [channel.point([255 if abs(value - rgb[i]) <= 2 else 0 for value in range(256)]) for i, channel in enumerate(channels)]
        mask = ImageChops.multiply(ImageChops.multiply(masks[0], masks[1]), masks[2])
        count = mask.histogram()[255]
        if count < 12:
            raise ValueError(f"Marker {name} has only {count} visible pixels")
        bx1, by1, bx2, by2 = mask.getbbox()
        x1, x2, y1, y2 = bx1 + left, bx2 + left, by1 + top, by2 + top
        found[name] = {"x": x1 / scale, "y": y1 / scale,
                       "width": (x2 - x1) / scale, "height": (y2 - y1) / scale,
                       "center": {"x": (x1 + x2) / (2 * scale), "y": (y1 + y2) / (2 * scale)},
                       "pixels": count, "aspectRatio": (x2 - x1) / (y2 - y1)}
    return {"image": {"width": image.width, "height": image.height, "scale": scale}, "markers": found}


def exported(file):
    with ZipFile(file) as archive:
        if Path(file).suffix == ".docx":
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            root = ET.fromstring(archive.read("word/document.xml"))
            paragraphs = ["".join(t.text or "" for t in p.findall(".//w:t", ns)) for p in root.findall(".//w:body/w:p", ns)]
            return {"kind": "word", "paragraphs": paragraphs}
        ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(t.text or "" for t in node.findall(".//s:t", ns)) for node in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", ns)]
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        cells = {}
        for cell in root.findall(".//s:sheetData/s:row/s:c", ns):
            kind = cell.get("t", "n")
            raw = cell.findtext("s:v", "", ns)
            value = strings[int(raw)] if kind == "s" else "".join(t.text or "" for t in cell.findall("s:is/s:t", ns)) if kind == "inlineStr" else raw
            cells[cell.get("r")] = {"type": kind, "value": value, "formula": cell.findtext("s:f", "", ns)}
        return {"kind": "calc", "cells": cells}


if __name__ == "__main__":
    command, file = sys.argv[1:3]
    result = markers(file, json.loads(sys.argv[3]), json.loads(sys.argv[4])) if command == "markers" else exported(file)
    print(json.dumps(result))
