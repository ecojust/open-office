#!/usr/bin/env python3
"""Generate controlled ODT sources and preserve real LibreOffice DOCX outputs.

Uses only Python's standard library and an installed LibreOffice. No DOCX part
is removed or rewritten after conversion. Sources are authored for this project.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "svg": "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
}
NS_ATTRS = " ".join(f'xmlns:{key}="{value}"' for key, value in NS.items())
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML = "http://www.w3.org/XML/1998/namespace"

STYLES = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles {NS_ATTRS} office:version="1.3">
 <office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="'Liberation Serif'"/></office:font-face-decls>
 <office:styles>
  <style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt"/></style:default-style>
  <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
  <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="1" style:class="text"><style:paragraph-properties fo:margin-top="0.3cm" fo:margin-bottom="0.15cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="20pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:default-outline-level="2" style:class="text"><style:paragraph-properties fo:margin-top="0.2cm" fo:margin-bottom="0.1cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="16pt" fo:font-weight="bold"/></style:style>
 </office:styles>
 <office:automatic-styles><style:page-layout style:name="Page"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="2.54cm" fo:margin-bottom="2.54cm" fo:margin-left="2.54cm" fo:margin-right="2.54cm"/></style:page-layout></office:automatic-styles>
 <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="Page"/></office:master-styles>
</office:document-styles>'''

EXPLICIT_STYLES = '''
<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
<style:style style:name="Underline" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="ColorSize" style:family="text"><style:text-properties fo:color="#c00000" fo:font-size="16pt"/></style:style>
<style:style style:name="Centered" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.25cm" fo:margin-bottom="0.5cm"/></style:style>
<style:style style:name="Right" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="end"/></style:style>
'''

CASES = [
    {
        "name": "plain-text", "purpose": "Ordinary paragraphs, including an empty paragraph.",
        "body": '<text:p text:style-name="Standard">Plain LibreOffice document.</text:p><text:p text:style-name="Standard">Second paragraph with 123 and punctuation.</text:p><text:p text:style-name="Standard"/><text:p text:style-name="Standard">Final paragraph.</text:p>',
        "paragraphs": ["Plain LibreOffice document.", "Second paragraph with 123 and punctuation.", "", "Final paragraph."],
    },
    {
        "name": "explicit-styles", "purpose": "Basic run formatting plus alignment and paragraph spacing.",
        "automaticStyles": EXPLICIT_STYLES,
        "body": '<text:p text:style-name="Standard">Normal <text:span text:style-name="Bold">bold</text:span> <text:span text:style-name="Italic">italic</text:span> <text:span text:style-name="Underline">underline</text:span> <text:span text:style-name="ColorSize">red sixteen</text:span>.</text:p><text:p text:style-name="Centered">Centered paragraph.</text:p><text:p text:style-name="Right">Right aligned paragraph.</text:p>',
        "paragraphs": ["Normal bold italic underline red sixteen.", "Centered paragraph.", "Right aligned paragraph."],
        "expectedSemantics": {"bold": "bold", "italic": "italic", "underline": "underline", "colorSize": {"text": "red sixteen", "color": "#C00000", "fontSizePt": 16}, "alignment": ["left", "center", "right"], "centeredSpacingCm": {"before": 0.25, "after": 0.5}},
    },
    {
        "name": "headings", "purpose": "Heading outline levels, inherited sizes/weight, and keep-with-next.",
        "body": '<text:h text:style-name="Heading_20_1" text:outline-level="1">A heading</text:h><text:p text:style-name="Standard">Body below heading.</text:p><text:h text:style-name="Heading_20_2" text:outline-level="2">A subheading</text:h><text:p text:style-name="Standard">Another body paragraph.</text:p>',
        "paragraphs": ["A heading", "Body below heading.", "A subheading", "Another body paragraph."],
        "expectedSemantics": {"outlineLevels": [1, None, 2, None], "headingSizesPt": [20, 16], "keepWithNext": [True, False, True, False]},
    },
    {
        "name": "unicode-breaks", "purpose": "Chinese, supplementary Unicode, tabs, soft breaks and preserved spaces.",
        "body": '<text:p text:style-name="Standard">中文排班与文档 😀🚀</text:p><text:p text:style-name="Standard">Line one<text:line-break/>第二行<text:tab/>Tab stop</text:p><text:p text:style-name="Standard"><text:s text:c="2"/>leading<text:s text:c="3"/>middle<text:s text:c="2"/></text:p>',
        "paragraphs": ["中文排班与文档 😀🚀", "Line one\n第二行\tTab stop", "  leading   middle  "],
    },
    {
        "name": "unsupported-table", "purpose": "Negative control: real table structure must remain unsupported until implemented.",
        "body": '<text:p text:style-name="Standard">A table follows.</text:p><table:table table:name="Example"><table:table-column/><table:table-row><table:table-cell office:value-type="string"><text:p text:style-name="Standard">Cell content</text:p></table:table-cell></table:table-row></table:table>',
        "paragraphs": ["A table follows.", ""], "expectUnsupported": "table",
    },
]


def odt_content(case: dict) -> str:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content {NS_ATTRS} office:version="1.3"><office:automatic-styles>{case.get("automaticStyles", "")}</office:automatic-styles><office:body><office:text>{case["body"]}</office:text></office:body></office:document-content>'''


def write_odt(path: Path, content: str) -> None:
    manifest = '''<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>'''
    with zipfile.ZipFile(path, "w") as package:
        for name, text in [("mimetype", "application/vnd.oasis.opendocument.text"), ("content.xml", content), ("styles.xml", STYLES), ("META-INF/manifest.xml", manifest)]:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED
            package.writestr(info, text.encode("utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def short_name(name: str) -> str:
    if name.startswith("{" + W + "}"):
        return "w:" + name.split("}", 1)[1]
    if name.startswith("{" + XML + "}"):
        return "xml:" + name.split("}", 1)[1]
    return name


def inspect_docx(path: Path) -> dict:
    result = {"parts": [], "xml": {}}
    with zipfile.ZipFile(path) as package:
        for part in package.infolist():
            data = package.read(part)
            result["parts"].append({"name": part.filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            if part.filename.endswith((".xml", ".rels")):
                root = ET.fromstring(data)
                nodes = set()
                def walk(node: ET.Element, prefix: str = "") -> None:
                    key = prefix + "/" + short_name(node.tag)
                    attrs = " ".join(f'{short_name(k)}={v!r}' for k, v in sorted(node.attrib.items()))
                    nodes.add(key + (" " + attrs if attrs else ""))
                    for child in node:
                        walk(child, key)
                walk(root)
                result["xml"][part.filename] = sorted(nodes)
        document = ET.fromstring(package.read("word/document.xml"))
        body = document.find(f"{{{W}}}body")
        paragraphs = []
        for paragraph in body.findall(f"{{{W}}}p"):
            items = []
            for node in paragraph.iter():
                if node.tag == f"{{{W}}}t": items.append(node.text or "")
                elif node.tag == f"{{{W}}}tab": items.append("\t")
                elif node.tag in (f"{{{W}}}br", f"{{{W}}}cr"): items.append("\n")
            paragraphs.append("".join(items))
        result["bodyParagraphs"] = paragraphs
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soffice", default="soffice")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    output = args.output.resolve()
    source = output / "source"
    generated = output / "libreoffice"
    inventories = output / "inventory"
    for directory in (source, generated, inventories): directory.mkdir(parents=True, exist_ok=True)
    executable = shutil.which(args.soffice)
    if executable is None: raise SystemExit("LibreOffice executable not found")
    version = subprocess.check_output([executable, "--version"], text=True, timeout=20).strip()
    manifest = {"formatVersion": 1, "generatedAtUtc": datetime.now(timezone.utc).isoformat(), "generator": "generate.py", "libreoffice": {"executable": executable, "version": version}, "platform": platform.platform(), "provenance": "Original controlled ODT sources authored for Open Office; DOCX files produced by native LibreOffice headless conversion and preserved byte-for-byte without stripping or rewriting package parts.", "fixtures": []}
    (source / "styles.xml").write_text(STYLES, encoding="utf-8")
    for case in CASES:
        content = odt_content(case)
        (source / f'{case["name"]}.content.xml').write_text(content, encoding="utf-8")
        odt = source / f'{case["name"]}.odt'
        write_odt(odt, content)
    with tempfile.TemporaryDirectory(prefix="open-office-lo-corpus-") as temporary:
        temporary = Path(temporary)
        command = [executable, "--headless", f'-env:UserInstallation={(temporary / "profile").as_uri()}', "--convert-to", "docx:Office Open XML Text", "--outdir", str(temporary), *[str(source / f'{case["name"]}.odt') for case in CASES]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, check=True)
        manifest["conversion"] = {"argv": command, "stdout": result.stdout, "stderr": result.stderr, "exitCode": result.returncode}
        for case in CASES:
            name = case["name"]
            converted = temporary / f"{name}.docx"
            if not converted.is_file(): raise RuntimeError(f"LibreOffice produced no file: {name}; {result.stdout}; {result.stderr}")
            target = generated / converted.name
            shutil.copyfile(converted, target)
            inventory = inspect_docx(target)
            if inventory["bodyParagraphs"] != case["paragraphs"]: raise RuntimeError(f"Unexpected native conversion text for {name}: {inventory['bodyParagraphs']!r}")
            (inventories / f"{name}.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            manifest["fixtures"].append({"name": name, "purpose": case["purpose"], "source": f"source/{name}.odt", "sourceSha256": sha256(source / f"{name}.odt"), "docx": f"libreoffice/{name}.docx", "docxSha256": sha256(target), "docxBytes": target.stat().st_size, "inventory": f"inventory/{name}.json", "expectedParagraphs": case["paragraphs"], **({"expectedSemantics": case["expectedSemantics"]} if "expectedSemantics" in case else {}), **({"expectUnsupported": case["expectUnsupported"]} if "expectUnsupported" in case else {})})
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"libreoffice": version, "fixtures": [{"name": f["name"], "bytes": f["docxBytes"]} for f in manifest["fixtures"]]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
