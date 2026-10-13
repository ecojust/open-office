"""Original 12-page fixture and independent saved-file checks for the Vue PDF UI.

This is not an Office/Acrobat fixture or a digital-signature test. It deliberately
includes an external URI as inert PDF metadata; the browser runner must not fetch it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pymupdf as fitz


EDITS = {0: "ROUND1 EDITED 中文", 4: "ROUND2 EDITED 旋转", 11: "ROUND3 EDITED 完成"}
TOC = [[1, "项目总览 Overview", 1], [2, "数据表格 Tables", 3],
       [1, "旋转页面 Rotation", 5], [2, "图文与批注 Notes", 9],
       [1, "附录 Appendix", 12]]


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def rect(value):
    return [round(float(number), 4) for number in value]


def snapshot(path: Path) -> dict:
    with fitz.open(path) as document:
        pages = []
        for page in document:
            links = [{key: rect(link[key]) if key in ("from", "to") else link[key]
                      for key in ("kind", "from", "page", "to", "uri", "zoom") if key in link}
                     for link in page.get_links()]
            annotations = [{"type": annotation.type[1], "rect": rect(annotation.rect),
                            "content": annotation.info.get("content", ""),
                            "title": annotation.info.get("title", "")}
                           for annotation in page.annots() or []]
            widgets = [{"name": widget.field_name, "type": widget.field_type,
                        "value": widget.field_value, "rect": rect(widget.rect),
                        "flags": widget.field_flags}
                       for widget in page.widgets() or []]
            image_hashes = sorted(digest(document.extract_image(image[0])["image"])
                                  for image in page.get_images(full=True))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False, annots=True)
            pages.append({"text": page.get_text(), "rotation": page.rotation,
                          "mediaBox": rect(page.mediabox), "cropBox": rect(page.cropbox),
                          "links": links, "annotations": annotations, "widgets": widgets,
                          "imageHashes": image_hashes, "drawingCount": len(page.get_drawings()),
                          "pixelSha256": digest(pixmap.samples)})
        return {"pageCount": len(document), "bookmarks": document.get_toc(),
                "metadata": {key: document.metadata.get(key) for key in ("title", "author", "subject")},
                "pages": pages, "fileSha256": digest(path.read_bytes()), "bytes": path.stat().st_size}


def generate(out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    diagram = fitz.open()
    image_page = diagram.new_page(width=260, height=120)
    image_page.draw_rect(image_page.rect, fill=(.92, .96, 1), color=None)
    for index, height in enumerate([36, 62, 46, 82]):
        image_page.draw_rect(fitz.Rect(25 + index * 55, 100 - height, 58 + index * 55, 100),
                             fill=(.15 + index * .06, .4, .68), color=None)
    image_page.insert_text((12, 15), "ORIGINAL LOCAL DIAGRAM", fontsize=8)
    png = image_page.get_pixmap(alpha=False).tobytes("png")
    (out / "complex-diagram.png").write_bytes(png)
    diagram.close()

    document = fitz.open()
    for index in range(12):
        number = index + 1
        page = document.new_page(width=595, height=842)
        page.draw_rect(fitz.Rect(32, 35, 563, 126), color=None, fill=(.91, .95, .99))
        page.insert_text((50, 61), f"LOCAL RESEARCH REPORT / PAGE {number:02d}",
                         fontsize=16, color=(.1, .23, .35))
        page.insert_text((50, 103), f"ORIGINAL-{number:02d}", fontsize=14, color=(.05, .15, .3))
        page.insert_text((50, 146), f"PRESERVE-{number:02d}: English content, quantities 123.45 and unit kg.", fontsize=10)
        page.insert_text((50, 173), f"第{number}页关键内容：本地文档、中文排版、原始记录。", fontname="china-s", fontsize=12)
        page.insert_text((50, 201), "English and Chinese are selectable text, not a scanned page.", fontsize=10)
        page.insert_image(fitz.Rect(50, 225, 310, 345), stream=png)
        page.insert_text((328, 249), f"IMAGE-NOTE-{number:02d}", fontsize=11)
        page.insert_text((328, 275), "Local vector and raster content", fontsize=9)
        # A real fixed-layout PDF table, with distinct selectable cell text.
        x0, y0, width, row_height = 50, 377, 495, 28
        for row in range(6):
            for column in range(3):
                cell = fitz.Rect(x0 + column * width / 3, y0 + row * row_height,
                                 x0 + (column + 1) * width / 3, y0 + (row + 1) * row_height)
                page.draw_rect(cell, color=(.48, .58, .65), width=.6,
                               fill=(.92, .95, .97) if row == 0 else None)
                value = ["Item", "Quantity", "Reference"][column] if row == 0 else [f"Row {row}", str(number * 10 + row), f"P{number:02d}-R{row}"][column]
                page.insert_text((cell.x0 + 8, cell.y0 + 18), value, fontsize=10)
        note = page.add_text_annot((554, 594), f"Original annotation on page {number:02d}")
        note.set_info(title="Original local fixture", content=f"PRESERVE-ANNOTATION-{number:02d}")
        note.update()
        page.insert_text((50, 625), f"LINK-LABEL-{number:02d}: inert URL metadata", fontsize=10)
        page.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(50, 608, 335, 632),
                          "uri": f"https://pdf-fixture.invalid/local-only/page-{number:02d}"})
        page.insert_text((50, 773), f"FOOTER-{number:02d} | Original content must survive each save", fontsize=9)
        if index == 2:
            field = fitz.Widget()
            field.field_type = fitz.PDF_WIDGET_TYPE_TEXT
            field.field_name = "original_customer_name"
            field.field_value = "Local customer 0123"
            field.rect = fitz.Rect(50, 664, 310, 692)
            field.text_font = "Helv"
            field.text_fontsize = 11
            page.add_widget(field)
        if index == 6:
            field = fitz.Widget()
            field.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
            field.field_name = "original_review_flag"
            field.field_value = "Off"
            field.rect = fitz.Rect(50, 665, 72, 687)
            page.add_widget(field)
    document[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(350, 650, 535, 672), "page": 11})
    document[11].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(350, 650, 535, 672), "page": 0})
    for index, rotation in ((4, 90), (8, 270), (10, 180)):
        document[index].set_rotation(rotation)
    document[9].set_cropbox(fitz.Rect(20, 25, 575, 810))
    document.set_toc(TOC)
    document.set_metadata({"title": "Original complex local PDF fixture", "author": "Open Office regression suite",
                           "subject": "12 pages, local content preservation; no certificate signature"})
    target = out / "complex-original.pdf"
    document.save(target, garbage=4, deflate=True)
    document.close()
    result = snapshot(target)
    assert result["pageCount"] == 12 and result["bookmarks"] == TOC
    assert sum(len(page["widgets"]) for page in result["pages"]) == 2
    assert all(page["imageHashes"] and len(page["annotations"]) == 1 for page in result["pages"])
    for index, page in enumerate(result["pages"]):
        assert f"ORIGINAL-{index + 1:02d}" in page["text"]
        assert f"第{index + 1}页关键内容" in page["text"]
    (out / "complex-baseline.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"fixture": str(target), "pageCount": 12, "bookmarks": len(TOC), "widgets": 2,
            "annotations": 12, "linkedUris": 12, "sha256": result["fileSha256"], "pymupdf": fitz.VersionBind}


def verify(out: Path, target: Path, round_number: int) -> dict:
    baseline = json.loads((out / "complex-baseline.json").read_text(encoding="utf-8"))
    actual = snapshot(target)
    assert actual["pageCount"] == 12, "Page count changed"
    assert actual["bookmarks"] == baseline["bookmarks"], "Bookmarks changed"
    assert actual["metadata"] == baseline["metadata"], "Document metadata changed"
    edited = list(EDITS)[:round_number]
    untouched = []
    for index, (before, after) in enumerate(zip(baseline["pages"], actual["pages"])):
        for field in ("rotation", "mediaBox", "cropBox", "links", "annotations", "widgets", "imageHashes"):
            assert after[field] == before[field], f"Page {index + 1}: {field} changed"
        number = index + 1
        assert f"PRESERVE-{number:02d}" in after["text"], f"Missing neighbor on page {number}"
        assert f"第{number}页关键内容" in after["text"], f"Missing Chinese on page {number}"
        for marker in (f"IMAGE-NOTE-{number:02d}", f"P{number:02d}-R5", f"FOOTER-{number:02d}"):
            assert marker in after["text"], f"Page {number}: missing {marker}"
        if index in edited:
            assert EDITS[index] in after["text"], f"Replacement missing from page {number}"
            assert f"ORIGINAL-{number:02d}" not in after["text"], f"Original text was only visually covered on page {number}"
            assert after["pixelSha256"] != before["pixelSha256"], f"Edited page {number} has unchanged pixels"
        else:
            assert after["text"] == before["text"], f"Untouched page {number} text changed"
            assert after["pixelSha256"] == before["pixelSha256"], f"Untouched page {number} pixels changed"
            assert after["drawingCount"] == before["drawingCount"], f"Untouched page {number} drawings changed"
            untouched.append(number)
    watermark_pages = [index + 1 for index, page in enumerate(actual["pages"]) if "本地复核" in page["text"]]
    assert watermark_pages == ([12] if round_number >= 3 else []), "Selected-page watermark leaked to other pages"
    return {"round": round_number, "pageCount": 12, "replacements": [EDITS[index] for index in edited],
            "untouchedPixelIdenticalPages": untouched, "bookmarksPreserved": True,
            "linksPreserved": True, "imagesPreserved": True, "widgetsPreserved": True,
            "annotationsPreserved": True, "rotationCropPreserved": True,
            "watermarkPages": watermark_pages, "fileSha256": actual["fileSha256"], "bytes": actual["bytes"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("generate", "verify"))
    parser.add_argument("output", type=Path)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--round", type=int, choices=(1, 2, 3), dest="round_number")
    arguments = parser.parse_args()
    if arguments.mode == "generate":
        print(json.dumps(generate(arguments.output), ensure_ascii=False))
    else:
        if arguments.file is None or arguments.round_number is None:
            parser.error("verify requires --file and --round")
        print(json.dumps(verify(arguments.output, arguments.file, arguments.round_number), ensure_ascii=False))
