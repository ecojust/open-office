"""Extract complete SC faces; do not subset glyphs or change font names."""
import hashlib
import json
import shutil
from pathlib import Path

from fontTools.ttLib import TTCollection


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


root = Path(__file__).resolve().parent
records = []
for weight in ("Regular", "Bold"):
    source = Path(f"/usr/share/fonts/opentype/noto/NotoSansCJK-{weight}.ttc")
    collection = TTCollection(source, lazy=False)
    font = collection.fonts[2]
    assert font["name"].getDebugName(1) == "Noto Sans CJK SC"
    font.recalcTimestamp = False
    target = root / f"NotoSansCJKsc-{weight}.otf"
    font.save(target)
    records.append({
        "file": target.name, "source": str(source), "sourceFaceIndex": 2,
        "sourceSha256": sha256(source), "sha256": sha256(target),
        "bytes": target.stat().st_size,
    })

for name in ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"):
    source = Path("/usr/share/fonts/truetype/dejavu") / name
    target = root / name
    shutil.copyfile(source, target)
    records.append({"file": name, "source": str(source), "sha256": sha256(target), "bytes": target.stat().st_size})

source = Path("/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf")
target = root / source.name
shutil.copyfile(source, target)
records.append({"file": target.name, "source": str(source), "sha256": sha256(target), "bytes": target.stat().st_size})

for source, target in (
    ("/usr/share/doc/fonts-noto-cjk/copyright", "LICENSE-Noto-CJK.txt"),
    ("/usr/share/doc/fonts-dejavu-core/copyright", "LICENSE-DejaVu.txt"),
    ("/usr/share/doc/fonts-noto-core/copyright", "LICENSE-Noto-Core.txt"),
):
    shutil.copyfile(source, root / target)

(root / "manifest.json").write_text(json.dumps(records, indent=2) + "\n")
print(f"Wrote {len(records)} complete font faces ({sum(record['bytes'] for record in records):,} bytes)")
