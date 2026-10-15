//! Open Office's licensed Unicode fallback fonts, subset per PDF page.
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::OnceLock;
use subsetter::GlyphRemapper;
use ttf_parser::{Face, Tag};

const DATA: [&[u8]; 5] = [
    include_bytes!("../../../../../assets/fonts/open-office/DejaVuSans.ttf"),
    include_bytes!("../../../../../assets/fonts/open-office/DejaVuSans-Bold.ttf"),
    include_bytes!("../../../../../assets/fonts/open-office/NotoSansCJKsc-Regular.otf"),
    include_bytes!("../../../../../assets/fonts/open-office/NotoSansCJKsc-Bold.otf"),
    include_bytes!("../../../../../assets/fonts/open-office/NotoSansSymbols2-Regular.ttf"),
];
static FACES: OnceLock<[Option<Face<'static>>; 5]> = OnceLock::new();
fn face(key: usize) -> Option<&'static Face<'static>> {
    FACES.get_or_init(|| DATA.map(|bytes| Face::parse(bytes, 0).ok())).get(key)?.as_ref()
}
pub fn is_fallback(c: char) -> bool {
    super::win_ansi(c) == b'?' && c != '?'
}
pub fn glyph(c: char, bold: bool) -> Option<(usize, u16, u16)> {
    for key in [usize::from(bold), 2 + usize::from(bold), 4] {
        let font = face(key)?;
        if let Some(id) = font.glyph_index(c).filter(|id| id.0 != 0) {
            let width = u32::from(font.glyph_hor_advance(id).unwrap_or(font.units_per_em())) * 1000 / u32::from(font.units_per_em().max(1));
            return Some((key, id.0, width.min(u32::from(u16::MAX)) as u16));
        }
    }
    None
}

pub struct Subset {
    mapper: GlyphRemapper,
    // PDF text codes belong to Unicode characters, not glyph IDs: CJK fonts
    // often map compatibility characters to the same visible glyph.
    chars: BTreeMap<u16, (char, u16, u16)>,
    codes: BTreeMap<char, u16>,
}
impl Default for Subset {
    fn default() -> Self {
        Self { mapper: GlyphRemapper::new(), chars: BTreeMap::new(), codes: BTreeMap::new() }
    }
}
impl Subset {
    pub fn encode(&mut self, c: char, gid: u16, width: u16) -> Result<u16, String> {
        if let Some(code) = self.codes.get(&c) {
            return Ok(*code);
        }
        if self.chars.len() >= 65_000 {
            return Err("PDF page uses too many different characters".into());
        }
        let code = u16::try_from(self.chars.len() + 1).map_err(|_| "PDF character code overflow")?;
        let cid = self.mapper.remap(gid);
        self.chars.insert(code, (c, cid, width));
        self.codes.insert(c, code);
        Ok(code)
    }

    pub fn objects(&self, key: usize, first: u32) -> Result<Vec<(u32, Vec<u8>)>, String> {
        let source = DATA.get(key).ok_or("Unknown PDF fallback font")?;
        let original = face(key).ok_or("Invalid bundled PDF font")?;
        let bytes = subsetter::subset(source, 0, &self.mapper).map_err(|e| format!("Cannot embed PDF font: {e}"))?;
        let subset = Face::parse(&bytes, 0).map_err(|e| format!("Invalid PDF font subset: {e}"))?;
        let cff = subset.raw_face().table(Tag::from_bytes(b"CFF "));
        let font_data = cff.unwrap_or(&bytes);
        let mut hash = key as u64;
        for (cid, (c, _, _)) in &self.chars {
            hash = hash.wrapping_mul(16777619) ^ u64::from(*cid) ^ u64::from(*c as u32);
        }
        let tag: String = (0..6)
            .map(|_| {
                let c = char::from(b'A' + (hash % 26) as u8);
                hash /= 26;
                c
            })
            .collect();
        let name = format!("{tag}+OpenOfficeFallback{key}");
        let scale = |v: i16| i32::from(v) * 1000 / i32::from(original.units_per_em().max(1));
        let bbox = original.global_bounding_box();
        let mut widths = String::new();
        // The subset has one glyph per CID; multiple text codes may address it.
        let glyph_widths: BTreeMap<_, _> = self.chars.values().map(|(_, cid, width)| (*cid, *width)).collect();
        for (cid, width) in glyph_widths {
            let _ = write!(widths, "{cid} [{width}] ");
        }
        let mut encoding = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def\n/CMapName /OpenOfficeGlyphs def\n/CMapType 1 def\n/WMode 0 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        let mut cmap = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /OpenOfficeUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        let entries: Vec<_> = self.chars.iter().collect();
        for chunk in entries.chunks(100) {
            let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
            let _ = writeln!(encoding, "{} begincidchar", chunk.len());
            for (code, (c, cid, _)) in chunk {
                let _ = writeln!(encoding, "<{code:04X}> {cid}");
                let _ = write!(cmap, "<{code:04X}> <");
                for unit in c.encode_utf16(&mut [0; 2]) {
                    let _ = write!(cmap, "{unit:04X}");
                }
                cmap.push_str(">\n");
            }
            cmap.push_str("endbfchar\n");
            encoding.push_str("endcidchar\n");
        }
        cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        encoding.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        let stream = |extra: &str, bytes: &[u8]| {
            let mut result = format!("<< /Length {} {extra} >>\nstream\n", bytes.len()).into_bytes();
            result.extend_from_slice(bytes);
            result.extend_from_slice(b"\nendstream");
            result
        };
        let file_key = if cff.is_some() { "FontFile3" } else { "FontFile2" };
        let subtype = if cff.is_some() { "CIDFontType0" } else { "CIDFontType2" };
        let mapping = if cff.is_some() { "" } else { " /CIDToGIDMap /Identity" };
        let file_properties = if cff.is_some() { "/Subtype /CIDFontType0C".to_string() } else { format!("/Length1 {}", font_data.len()) };
        Ok(vec![
            (first, format!("<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding {} 0 R /DescendantFonts [{} 0 R] /ToUnicode {} 0 R >>", first+5, first+1, first+4).into_bytes()),
            (first+1, format!("<< /Type /Font /Subtype /{subtype} /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {} 0 R /DW 1000 /W [{widths}]{mapping} >>", first+2).into_bytes()),
            (first+2, format!("<< /Type /FontDescriptor /FontName /{name} /Flags 4 /FontBBox [{} {} {} {}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /{file_key} {} 0 R >>", scale(bbox.x_min),scale(bbox.y_min),scale(bbox.x_max),scale(bbox.y_max),scale(original.ascender()),scale(original.descender()),scale(original.capital_height().unwrap_or(original.ascender())),first+3).into_bytes()),
            (first+3, stream(&file_properties, font_data)),
            (first+4, stream("", cmap.as_bytes())),
            (first+5, stream("", encoding.as_bytes())),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_aliases_share_outlines_but_preserve_distinct_text_codes() {
        let (key, gid, width) = glyph('⺂', false).unwrap();
        let (alias_key, alias_gid, alias_width) = glyph('乛', false).unwrap();
        assert_eq!((key, gid), (alias_key, alias_gid));
        let mut subset = Subset::default();
        let first = subset.encode('⺂', gid, width).unwrap();
        let second = subset.encode('乛', alias_gid, alias_width).unwrap();
        assert_ne!(first, second);
        assert_eq!(subset.encode('⺂', gid, width).unwrap(), first);
        assert_eq!(subset.mapper.num_gids(), 2, "outline stays deduplicated with .notdef");
        let objects = subset.objects(key, 4).unwrap();
        let text = String::from_utf8_lossy(&objects[4].1);
        assert!(text.contains("<0001> <2E82>"));
        assert!(text.contains("<0002> <4E5B>"));
        let encoding = String::from_utf8_lossy(&objects[5].1);
        assert!(encoding.contains("<0001> 1"));
        assert!(encoding.contains("<0002> 1"));
    }

    #[test]
    fn licensed_faces_subset_chinese_and_supplementary_characters() {
        for c in ['中', '文', '表', '格', '😀'] {
            let (key, gid, width) = glyph(c, false).unwrap_or_else(|| panic!("missing bundled glyph {c}"));
            let mut subset = Subset::default();
            assert!(subset.encode(c, gid, width).unwrap() > 0);
            let objects = subset.objects(key, 4).unwrap();
            assert_eq!(objects.len(), 6);
            assert!(objects[4].1.windows(11).any(|v| v == b"beginbfchar"));
        }
    }
}
