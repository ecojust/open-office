#!/usr/bin/env python3
"""Read effective DOCX paragraph indentation without using the editor codec."""
import json
import sys
import zipfile
from xml.etree import ElementTree as E

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
q = lambda name: "{" + W + "}" + name


def value(node, default=None):
    return node.get(q("val"), default) if node is not None else default


def properties(node):
    result = {}
    if node is None:
        return result
    ind = node.find("w:ind", NS)
    if ind is not None:
        for logical, physical, field in [("start", "left", "left"), ("end", "right", "right")]:
            raw = ind.get(q(physical), ind.get(q(logical)))
            if raw is not None:
                result[field] = int(raw) / 20
        if ind.get(q("firstLine")) is not None:
            result["firstLine"] = int(ind.get(q("firstLine"))) / 20
        elif ind.get(q("hanging")) is not None:
            result["firstLine"] = -int(ind.get(q("hanging"))) / 20
    return result


def inspect(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            if name.endswith((".xml", ".rels")):
                E.fromstring(archive.read(name))
        sheet = E.fromstring(archive.read("word/styles.xml"))
        styles = {s.get(q("styleId")): s for s in sheet.findall("w:style", NS)}
        default_id = next((k for k, s in styles.items() if s.get(q("type")) == "paragraph" and s.get(q("default")) in ["1", "true"]), None)
        defaults = properties(sheet.find("w:docDefaults/w:pPrDefault/w:pPr", NS))

        def chain(style_id, seen=()):
            if style_id not in styles:
                return []
            assert style_id not in seen, "Circular style inheritance"
            style = styles[style_id]
            return chain(value(style.find("w:basedOn", NS)), (*seen, style_id)) + [style]

        document = E.fromstring(archive.read("word/document.xml"))
        paragraphs = []
        for paragraph in document.findall("w:body/w:p", NS):
            base = {"left": 0, "right": 0, "firstLine": 0, **defaults}
            for style in chain(value(paragraph.find("w:pPr/w:pStyle", NS), default_id)):
                base.update(properties(style.find("w:pPr", NS)))
            direct = properties(paragraph.find("w:pPr", NS))
            text = "".join((n.text or "") if n.tag == q("t") else "\n" if n.tag == q("br") else "\t" if n.tag == q("tab") else "" for n in paragraph.iter())
            paragraphs.append({"text": text, "indent": {**base, **direct}, "sourceIndent": base, "directIndent": direct})
        return {"paragraphs": paragraphs, "zipEntries": len(archive.namelist())}


if __name__ == "__main__":
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
