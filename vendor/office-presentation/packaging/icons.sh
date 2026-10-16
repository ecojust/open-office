#!/usr/bin/env bash
# Regenerate the platform app icons from the committed PNGs in assets/app-icon/:
#
#   assets/app-icon/office-presentation.ico    Windows (16–256 px, from hicolor/*)
#   assets/app-icon/office-presentation.icns   macOS (16–1024 px, from office-presentation-1024.png; needs sips + iconutil)
#
# The PNGs themselves are rendered by OfficePresentation from assets/app-icon/icon-source.presentation.
# The outputs are committed, so builds and packaging never need these tools; package scripts
# call this only when an output is missing.
#
#   packaging/icons.sh [ico] [icns]     (default: both)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/assets/app-icon"
ID="ai.storyteller.office-presentation"
SRC="$DIR/office-presentation-1024.png"
WANT="${*:-ico icns}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case " $WANT " in
  *" ico "*)
    ICO_PNGS=()
    for s in 16 24 32 48 64 128 256; do
      ICO_PNGS+=("$DIR/hicolor/${s}x${s}/apps/$ID.png")
    done
    (cd "$ROOT" && cargo run -q -p xtask -- ico "$DIR/office-presentation.ico" "${ICO_PNGS[@]}")
    echo "wrote $DIR/office-presentation.ico"
    ;;
esac

case " $WANT " in
  *" icns "*)
    if command -v iconutil >/dev/null && command -v sips >/dev/null; then
      SET="$TMP/office-presentation.iconset"
      mkdir -p "$SET"
      for s in 16 32 128 256 512; do
        sips -z "$s" "$s" "$SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
        d=$((s * 2))
        sips -z "$d" "$d" "$SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
      done
      iconutil -c icns -o "$DIR/office-presentation.icns" "$SET"
      echo "wrote $DIR/office-presentation.icns"
    else
      echo "warning: sips/iconutil not found (macOS only); office-presentation.icns not regenerated" >&2
    fi
    ;;
esac
