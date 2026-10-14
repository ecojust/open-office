#!/usr/bin/env python3
"""Independently audit real UI downloads; never use the Writer RPC to inspect them.

Run from the project root after word decoration UI tests have produced downloads:
  python tests/browser/audit-word-decorations.py [output-directory]
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"
XML = "http://www.w3.org/XML/1998/namespace"
NS = {"w": W, "r": R, "p": P}
FILES = ["ui-baseline.docx", "ui-edited.docx", "ui-rejected.docx",
         "ui-reopened.docx", "ui-from-odt.docx"]
BOOLEAN_PROPERTIES = {
    "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike",
    "outline", "shadow", "emboss", "imprint", "vanish", "webHidden",
    "rtl", "cs", "noProof", "snapToGrid", "specVanish", "oMath",
}


def parse(data):
    return etree.fromstring(data, etree.XMLParser(resolve_entities=False,
        no_network=True, remove_blank_text=False, huge_tree=False))


def canonical(node):
    return etree.tostring(node, method="c14n", exclusive=True).decode()


def structure(node):
    """Namespace-aware XML value without arbitrary namespace-prefix differences."""
    return [node.tag, sorted(node.attrib.items()), node.text or "",
            [structure(child) for child in node]]


def properties(node):
    result = {}
    if node is None:
        return result
    for child in node:
        name = etree.QName(child).localname
        if child.tag == f"{{{W}}}rStyle":
            continue  # Resolved separately, never discarded without resolution.
        if child.tag.startswith("{" + W + "}") and name in BOOLEAN_PROPERTIES:
            result[child.tag] = child.get(f"{{{W}}}val", "true").lower() not in {"0", "false", "off"}
        else:
            result[child.tag] = structure(child)
    return result


def pure_text_run(run):
    return run.tag == f"{{{W}}}r" and all(
        child.tag in {f"{{{W}}}rPr", f"{{{W}}}t"} for child in run
    ) and any(child.tag == f"{{{W}}}t" for child in run)


def normalized_xml(root, substitutions=None):
    node = copy.deepcopy(root)
    for text in node.findall(".//w:t", NS):
        value = text.text or ""
        for source, target in (substitutions or {}).items():
            value = value.replace(source, target)
        text.text = value
    # Native edits may split a plain run. Merge only adjacent plain runs with
    # exactly equal attributes and complete rPr; fields/links remain barriers.
    for parent in reversed(list(node.iter())):
        previous = None
        for child in list(parent):
            if pure_text_run(child) and previous is not None and pure_text_run(previous):
                left, right = previous.find("w:rPr", NS), child.find("w:rPr", NS)
                if previous.attrib == child.attrib and (
                    canonical(left) if left is not None else ""
                ) == (canonical(right) if right is not None else ""):
                    for text in list(child):
                        if text.tag == f"{{{W}}}t":
                            previous.append(copy.deepcopy(text))
                    parent.remove(child)
                    continue
            previous = child
    for run in node.findall(".//w:r", NS):
        if not pure_text_run(run):
            continue
        texts = run.findall("w:t", NS)
        value = "".join(text.text or "" for text in texts)
        for text in texts[1:]:
            run.remove(text)
        texts[0].text = value
    for text in node.findall(".//w:t", NS):
        value = text.text or ""
        if value and (value[0].isspace() or value[-1].isspace()):
            text.set(f"{{{XML}}}space", "preserve")
        else:
            text.attrib.pop(f"{{{XML}}}space", None)
    return canonical(node)


def read_document(path):
    record = {"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "parts": []}
    with ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(item.file_size for item in entries) > 64 * 1024 * 1024:
            raise ValueError("Fixture exceeds independent audit budget")
        if len({item.filename for item in entries}) != len(entries):
            raise ValueError("Duplicate ZIP part names")
        names = set(archive.namelist())
        styles_root = parse(archive.read("word/styles.xml"))
        style_map = {s.get(f"{{{W}}}styleId"): s for s in styles_root.findall("w:style", NS)}
        defaults = properties(styles_root.find("w:docDefaults/w:rPrDefault/w:rPr", NS))

        def inherited(style_id, seen=()):
            if not style_id:
                return {}
            if style_id in seen or len(seen) > 32:
                raise ValueError(f"Unresolvable style chain: {style_id}")
            if style_id not in style_map:
                # Native exports can retain an unresolved rStyle reference.
                # Keep its exact identity in the signature rather than assume
                # default formatting or silently drop it.
                return {"unresolvedStyleReference": style_id}
            style = style_map[style_id]
            parent = style.find("w:basedOn", NS)
            result = inherited(parent.get(f"{{{W}}}val"), (*seen, style_id)) if parent is not None else {}
            result.update(properties(style.find("w:rPr", NS)))
            return result

        def effective(run):
            result = dict(defaults)
            paragraph = next((p for p in run.iterancestors() if p.tag == f"{{{W}}}p"), None)
            paragraph_style = paragraph.find("w:pPr/w:pStyle", NS) if paragraph is not None else None
            if paragraph_style is not None:
                result.update(inherited(paragraph_style.get(f"{{{W}}}val")))
            char_style = run.find("w:rPr/w:rStyle", NS)
            if char_style is not None:
                result.update(inherited(char_style.get(f"{{{W}}}val")))
            result.update(properties(run.find("w:rPr", NS)))
            return result

        for name in sorted(n for n in names if re.fullmatch(r"word/(?:header|footer)\d+\.xml", n)):
            root = parse(archive.read(name))
            rel_name = "word/_rels/" + Path(name).name + ".rels"
            rel_root = parse(archive.read(rel_name)) if rel_name in names else None
            relationships = {} if rel_root is None else {
                rel.get("Id"): {"type": rel.get("Type"), "target": rel.get("Target"),
                                "mode": rel.get("TargetMode", "Internal")}
                for rel in rel_root
            }
            part = {"part": name, "kind": "header" if "/header" in name else "footer",
                    "xml": normalized_xml(root), "editedBaselineXml": normalized_xml(root, {"Memo": "Note", "Report": "Review"}),
                    "relationships": relationships, "text": "".join(root.xpath(".//w:t/text()", namespaces=NS)),
                    "fields": [], "hyperlinks": [], "paragraphs": []}
            for field in root.xpath(".//w:instrText | .//w:fldChar | .//w:fldSimple", namespaces=NS):
                if field.tag == f"{{{W}}}instrText":
                    part["fields"].append({"instruction": " ".join((field.text or "").split())})
                elif field.tag == f"{{{W}}}fldChar":
                    part["fields"].append({"marker": field.get(f"{{{W}}}fldCharType")})
                else:
                    part["fields"].append({"simple": " ".join(field.get(f"{{{W}}}instr", "").split())})
            for link in root.findall(".//w:hyperlink", NS):
                rid = link.get(f"{{{R}}}id")
                if rid and rid not in relationships:
                    raise ValueError(f"Unresolved hyperlink {name}:{rid}")
                part["hyperlinks"].append({"relationship": relationships.get(rid),
                    "properties": sorted((k, v) for k, v in link.attrib.items() if k != f"{{{R}}}id"),
                    "text": "".join(link.xpath(".//w:t/text()", namespaces=NS))})
            for paragraph in root.findall(".//w:p", NS):
                runs = []
                for run in paragraph.findall(".//w:r", NS):
                    visible = "".join(run.xpath("./w:t/text()", namespaces=NS))
                    if not visible:
                        continue
                    link = next((p for p in run.iterancestors() if p.tag == f"{{{W}}}hyperlink"), None)
                    url = relationships.get(link.get(f"{{{R}}}id")) if link is not None else None
                    item = {"text": visible, "format": effective(run), "hyperlink": url}
                    if runs and {k: v for k, v in runs[-1].items() if k != "text"} == {k: v for k, v in item.items() if k != "text"}:
                        runs[-1]["text"] += visible
                    else:
                        runs.append(item)
                part["paragraphs"].append(runs)
            record["parts"].append(part)
    if not record["parts"]:
        raise ValueError(f"{path.name} contains no header/footer parts")
    return record


def semantic(record, kind):
    # A reimport may duplicate the same content for default/even page styles.
    # Ignore empty placeholders, but retain every distinct nonempty signature.
    values = []
    for part in record["parts"]:
        if part["kind"] != kind or not (part["text"] or part["fields"] or part["hyperlinks"]):
            continue
        values.append(json.dumps({key: part[key] for key in ["fields", "hyperlinks", "paragraphs"]}, ensure_ascii=False, sort_keys=True))
    return sorted(set(values))


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("test-results/decoration-word-followup")
    report = {"scope": "Independent Python/lxml audit of actual Writer UI DOCX downloads; no native RPC inspection", "files": [], "checks": [], "errors": [], "ok": False}
    try:
        report["files"] = [read_document(folder / name) for name in FILES]
        records = {record["file"]: record for record in report["files"]}
        baseline, edited = records[FILES[0]], records[FILES[1]]
        def check(condition, name, detail=None):
            report["checks"].append({"name": name, "ok": bool(condition)})
            if not condition:
                report["errors"].append({"name": name, "detail": detail})
        for record in report["files"]:
            for kind, label in [("header", "Memo" if record is baseline else "Note"), ("footer", "Report" if record is baseline else "Review")]:
                relevant = [part for part in record["parts"] if part["kind"] == kind and part["text"]]
                check(bool(relevant) and all(label in part["text"] for part in relevant), f"{record['file']}: {kind} expected edited text")
                check(bool(relevant) and all(any(item.get("instruction") == "PAGE" or item.get("simple") == "PAGE" for item in part["fields"]) for part in relevant), f"{record['file']}: {kind} retains PAGE field")
                check(bool(relevant) and all(part["hyperlinks"] for part in relevant), f"{record['file']}: {kind} retains hyperlink")
        for source, target, rename in [(baseline, edited, True), (edited, records[FILES[2]], False)]:
            before = {part["part"]: part for part in source["parts"]}
            after = {part["part"]: part for part in target["parts"]}
            check(before.keys() == after.keys(), f"{source['file']} → {target['file']}: same decoration part roster")
            for name in sorted(before.keys() & after.keys()):
                check(before[name]["editedBaselineXml" if rename else "xml"] == after[name]["xml"], f"{target['file']}: {name} only allowed text changed")
                check(before[name]["relationships"] == after[name]["relationships"], f"{target['file']}: {name} relationships preserved")
        for name in FILES[2:]:
            for kind in ["header", "footer"]:
                expected, actual = semantic(edited, kind), semantic(records[name], kind)
                check(bool(expected) and expected == actual, f"{name}: {kind} full visible formatting / fields / links preserved", {"expected": expected, "actual": actual} if expected != actual else None)
        report["ok"] = not report["errors"]
    except Exception as error:
        report["errors"].append({"error": str(error), "type": type(error).__name__})
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / "independent-decoration-audit.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": report["ok"], "checks": len(report["checks"]), "errors": report["errors"], "report": str(output)}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
