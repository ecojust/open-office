"""Independent OOXML oracle for browser/native spreadsheet acceptance.

Uses Python's ZIP/XML readers, never the application or GridCraft serializers.
The --fixture mode writes a small, independently authored XLSX source package.
"""
import json
import math
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
P = "{http://schemas.openxmlformats.org/package/2006/relationships}"
# OOXML reserves these format IDs without a corresponding <numFmt> element.
BUILTIN_FORMATS = {0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
                   9: "0%", 10: "0.00%", 11: "0.00E+00", 49: "@"}


def inspect(filename):
    with zipfile.ZipFile(filename) as package:
        infos = package.infolist()
        names = [entry.filename for entry in infos]
        if len(names) != len(set(names)):
            raise ValueError("Duplicate ZIP entries")
        if any(name.startswith("/") or ".." in name.split("/") or "\\" in name for name in names):
            raise ValueError("Unsafe ZIP entry path")
        if sum(entry.file_size for entry in infos) > 64 * 1024 * 1024:
            raise ValueError("Fixture exceeds 64 MiB uncompressed inspection limit")
        def xml(name):
            payload = package.read(name)
            if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
                raise ValueError("Unexpected XML entity declaration")
            return ET.fromstring(payload)
        workbook = xml("xl/workbook.xml")
        relations = {node.get("Id"): node for node in xml("xl/_rels/workbook.xml.rels")}
        strings = ["".join(text.text or "" for text in node.iter(S + "t")) for node in xml("xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in names else []
        styles = xml("xl/styles.xml") if "xl/styles.xml" in names else ET.Element(S + "styleSheet")
        fonts = styles.findall(S + "fonts/" + S + "font")
        formats = {int(node.get("numFmtId")): node.get("formatCode") for node in styles.findall(S + "numFmts/" + S + "numFmt")}
        xfs = styles.findall(S + "cellXfs/" + S + "xf")
        def cell_style(index):
            xf = xfs[index] if index < len(xfs) else ET.Element(S + "xf")
            font_index = int(xf.get("fontId", "0"))
            font = fonts[font_index] if font_index < len(fonts) else ET.Element(S + "font")
            def flag(name):
                child = font.find(S + name)
                return child is not None and child.get("val", "1") not in ("0", "false")
            size = font.find(S + "sz")
            color = font.find(S + "color")
            fmt = int(xf.get("numFmtId", "0"))
            alignment = xf.find(S + "alignment")
            return {"bold": flag("b"), "italic": flag("i"), "underline": flag("u"),
                    "fontSize": float(size.get("val")) if size is not None else None,
                    "color": color.get("rgb", "")[-6:].upper() if color is not None else None,
                    "numberFormat": formats.get(fmt, BUILTIN_FORMATS.get(fmt, fmt)),
                    "alignment": dict(alignment.attrib) if alignment is not None else {}}
        sheets = []
        for node in workbook.findall(S + "sheets/" + S + "sheet"):
            relation = relations[node.get(R + "id")]
            if relation.get("TargetMode") == "External":
                raise ValueError("Worksheet relationship must be internal")
            target = relation.get("Target", "")
            target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
            if not target.startswith("xl/"):
                raise ValueError("Worksheet relationship leaves workbook directory")
            sheet = xml(target)
            cells = {}
            for cell in sheet.findall(".//" + S + "sheetData/" + S + "row/" + S + "c"):
                kind = cell.get("t", "n")
                raw = cell.findtext(S + "v")
                if kind == "s":
                    value = strings[int(raw)]
                elif kind == "inlineStr":
                    value = "".join(text.text or "" for text in cell.find(S + "is").iter(S + "t"))
                elif kind == "b":
                    value = raw == "1"
                elif kind in ("str", "e", "d"):
                    value = raw
                elif raw is None or raw == "":
                    value = None
                else:
                    value = float(raw)
                    if not math.isfinite(value):
                        raise ValueError("Non-finite numeric cell")
                    if value.is_integer():
                        value = int(value)
                formula = cell.findtext(S + "f")
                cells[cell.get("r")] = {"value": value, "formula": "=" + formula if formula is not None else None,
                                        "type": kind, "style": cell_style(int(cell.get("s", "0")))}
            sheets.append({"name": node.get("name"), "state": node.get("state", "visible"), "cells": cells,
                           "merges": [merge.get("ref") for merge in sheet.findall(S + "mergeCells/" + S + "mergeCell")],
                           "columns": [dict(column.attrib) for column in sheet.findall(S + "cols/" + S + "col")],
                           "pane": [dict(pane.attrib) for pane in sheet.findall(S + "sheetViews/" + S + "sheetView/" + S + "pane")]})
        return {"sheets": sheets, "entries": len(names)}


def fixture(filename):
    namespace = S[1:-1]
    contents = {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'<workbook xmlns="{namespace}" xmlns:r="{R[1:-1]}"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="预算" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{P[1:-1]}"><Relationship Id="rId1" Type="{R[1:-1]}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{R[1:-1]}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="{R[1:-1]}/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<styleSheet xmlns="{namespace}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FF336699"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{namespace}"><dimension ref="A1:C3"/><cols><col min="1" max="1" width="20" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr" s="1"><is><t>地区 中文</t></is></c><c r="B1" t="inlineStr"><is><t>销售</t></is></c><c r="C1"><f>SUM(B2:B3)</f><v>42</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>华东</t></is></c><c r="B2" s="2"><v>12</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>华南</t></is></c><c r="B3" s="2"><v>30</v></c></row></sheetData></worksheet>',
        "xl/worksheets/sheet2.xml": f'<worksheet xmlns="{namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>预算副表</t></is></c></row><row r="2"><c r="C2"><f>\'销售\'!C1</f><v>42</v></c></row></sheetData></worksheet>',
    }
    with zipfile.ZipFile(filename, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for name, content in contents.items():
            package.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + content)


if __name__ == "__main__":
    # ASCII JSON survives Windows redirected stdout code pages; consumers still
    # recover the exact Unicode sheet names and cell text when decoding JSON.
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        fixture(sys.argv[2])
        print(json.dumps(inspect(sys.argv[2]), ensure_ascii=True))
    else:
        print(json.dumps(inspect(sys.argv[1]), ensure_ascii=True))
