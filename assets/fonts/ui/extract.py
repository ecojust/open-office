"""Extract the shared UI face from the pinned, openly licensed upstream archive.

Usage: python3 assets/fonts/ui/extract.py /path/to/fonts-wqy-microhei_0.2.0-beta.orig.tar.gz
Requires fontTools. No network or system-font dependency is used by application builds.
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

from fontTools import __version__
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
ARCHIVE_SHA256 = "2802ac8023aa36a66ea6e7445854e3a078d377ffff42169341bd237871f7213e"
SOURCE = "https://deb.debian.org/debian/pool/main/f/fonts-wqy-microhei/fonts-wqy-microhei_0.2.0-beta.orig.tar.gz"


def sha(data):
    return hashlib.sha256(data).hexdigest()


archive = Path(sys.argv[1]).read_bytes()
if sha(archive) != ARCHIVE_SHA256:
    raise ValueError("UI font archive does not match the pinned source")
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
    collection = package.extractfile("wqy-microhei/wqy-microhei.ttc").read()
    for source, target in [
        ("LICENSE_Apache2.txt", "LICENSE-Apache-2.0.txt"),
        ("LICENSE_GPLv3.txt", "LICENSE-GPL-3.0.txt"),
        ("README.txt", "UPSTREAM-README.txt"),
        ("AUTHORS.txt", "AUTHORS.txt"),
    ]:
        (ROOT / target).write_bytes(package.extractfile("wqy-microhei/" + source).read())

font = TTFont(io.BytesIO(collection), fontNumber=0, recalcTimestamp=False)
assert font["name"].getDebugName(1) == "WenQuanYi Micro Hei"
file = ROOT / "WenQuanYiMicroHei-Regular.ttf"
font.save(file)
files = [file, *(ROOT / name for name in ["LICENSE-Apache-2.0.txt", "LICENSE-GPL-3.0.txt", "UPSTREAM-README.txt", "AUTHORS.txt"])]
manifest = {
    "family": "WenQuanYi Micro Hei",
    "style": "Regular",
    "version": "0.2.0-beta",
    "source": "https://sourceforge.net/projects/wqy/files/wqy-microhei/0.2.0-beta/",
    "archive": SOURCE,
    "archiveSha256": ARCHIVE_SHA256,
    "collectionSha256": sha(collection),
    "collectionFace": 0,
    "license": "Apache-2.0",
    "licenseChoice": "Upstream offers Apache-2.0 OR GPL-3.0 with font embedding exception; distributed under Apache-2.0.",
    "authors": "WenQuanYi Project Contributors; Google Corporation; Wada Laboratory and Electronic Font Open Laboratory (punctuation)",
    "changes": "Extracted the proportional face from TTC to standalone TTF using fontTools " + __version__ + "; outlines, glyph coverage and original font notices are unchanged.",
    "files": [{"file": path.name, "sha256": sha(path.read_bytes()), "bytes": path.stat().st_size} for path in files],
}
(ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
