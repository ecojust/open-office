"""Independent PPTX ZIP/XML and PDF readback for delivered-editor evidence.

Never imports the Deck document model, renderer, or serializer. JSON is ASCII
so Windows redirected stdout code pages preserve Chinese and emoji evidence.
"""
import json
import pathlib
import posixpath
import sys
import zipfile
import xml.etree.ElementTree as ET

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"


def inspect_pptx(filename):
    with zipfile.ZipFile(filename) as package:
        infos = package.infolist()
        names = [item.filename for item in infos]
        if len(names) > 2048 or len(names) != len(set(name.casefold() for name in names)):
            raise ValueError("Duplicate or excessive ZIP entries")
        if any(not name or name.startswith("/") or ".." in name.split("/") or "\\" in name for name in names):
            raise ValueError("Unsafe ZIP entry path")
        if sum(item.file_size for item in infos) > 64 * 1024 * 1024:
            raise ValueError("PPTX exceeds uncompressed inspection limit")
        if any("vbaproject" in name.lower() for name in names):
            raise ValueError("Unexpected executable macro payload")
        if package.testzip() is not None:
            raise ValueError("Invalid ZIP CRC")

        def xml(name):
            data = package.read(name)
            if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
                raise ValueError("Unexpected XML entity declaration")
            return ET.fromstring(data)

        def relations(name):
            nodes = xml(name)
            if nodes.tag != REL + "Relationships":
                raise ValueError("Invalid relationship namespace")
            result = {}
            for node in nodes:
                if node.tag != REL + "Relationship" or not node.get("Id") or node.get("Id") in result:
                    raise ValueError("Invalid or duplicate relationship")
                result[node.get("Id")] = node
            return result

        def target(node, folder):
            if node.get("TargetMode", "Internal") != "Internal":
                raise ValueError("Required presentation relationship must be internal")
            raw = node.get("Target", "")
            if not raw or "\\" in raw or ":" in raw or "?" in raw or "#" in raw:
                raise ValueError("Invalid presentation relationship target")
            value = posixpath.normpath(raw.lstrip("/") if raw.startswith("/") else posixpath.join(folder, raw))
            if value.startswith("../") or value not in names:
                raise ValueError("Missing or unsafe presentation relationship target")
            return value

        content_types = xml("[Content_Types].xml")
        if content_types.tag != CT + "Types":
            raise ValueError("Invalid content type namespace")
        overrides = {node.get("PartName", "").lstrip("/"): node.get("ContentType") for node in content_types.findall(CT + "Override")}
        office = [node for node in relations("_rels/.rels").values() if node.get("Type") == R[1:-1] + "/officeDocument"]
        if len(office) != 1:
            raise ValueError("Presentation must have one main document relationship")
        main = target(office[0], "")
        if overrides.get(main) != "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml":
            raise ValueError("Unexpected presentation content type")
        presentation = xml(main)
        if presentation.tag != P + "presentation":
            raise ValueError("Invalid presentation namespace")
        folder = posixpath.dirname(main)
        links = relations(posixpath.join(folder, "_rels", posixpath.basename(main) + ".rels"))
        slides = []
        for slide_id in presentation.findall(P + "sldIdLst/" + P + "sldId"):
            link = links[slide_id.get(R + "id")]
            if link.get("Type") != R[1:-1] + "/slide":
                raise ValueError("Slide relationship has an unexpected type")
            part = target(link, folder)
            if overrides.get(part) != "application/vnd.openxmlformats-officedocument.presentationml.slide+xml":
                raise ValueError("Unexpected slide content type")
            slide = xml(part)
            if slide.tag != P + "sld":
                raise ValueError("Invalid slide namespace")
            paragraphs = []
            runs = []
            for paragraph in slide.iter(A + "p"):
                text = ""
                defaults = paragraph.find(A + "pPr/" + A + "defRPr")
                for run in paragraph:
                    if run.tag not in (A + "r", A + "fld"):
                        continue
                    content = run.findtext(A + "t", "")
                    properties = run.find(A + "rPr")
                    bold = properties.get("b") if properties is not None else None
                    if bold is None and defaults is not None:
                        bold = defaults.get("b")
                    runs.append({"text": content, "bold": bold in ("1", "true")})
                    text += content
                paragraphs.append(text)
            slides.append({"part": part, "text": "\n".join(paragraphs), "runs": runs})
        if len({slide["part"] for slide in slides}) != len(slides):
            raise ValueError("Duplicate slide references")
        return {"slides": slides, "entries": len(names)}


def inspect_pdf(filename):
    import pymupdf
    with pymupdf.open(filename) as document:
        if not document.is_pdf or document.needs_pass or document.is_repaired:
            raise ValueError("PDF must open without passwords or repair")
        if not 0 < document.page_count <= 100:
            raise ValueError("Unexpected PDF page count")
        return {"pages": [{"text": page.get_text(), "width": page.rect.width, "height": page.rect.height} for page in document]}


if __name__ == "__main__":
    path = pathlib.Path(sys.argv[1])
    if path.suffix == ".pptx":
        evidence = inspect_pptx(path)
    elif path.suffix == ".pdf":
        evidence = inspect_pdf(path)
    else:
        raise ValueError("Expected PPTX or PDF evidence")
    print(json.dumps(evidence, ensure_ascii=True))
