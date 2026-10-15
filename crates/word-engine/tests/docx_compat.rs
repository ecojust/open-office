use word_engine::docx::{export_document, import_document};
use word_engine::model::{document_text, Alignment};
use word_package::{read_package, write_package, RawPart};

const DIRECT: &[u8] = include_bytes!("fixtures/basic-docx/basic-direct.docx");
const STYLES: &[u8] = include_bytes!("fixtures/basic-docx/basic-styles.docx");
fn mutate(bytes: &[u8], part: &str, before: &str, after: &str) -> Vec<u8> {
    let mut parts = read_package(bytes).unwrap();
    let p = parts.iter_mut().find(|p| p.name == part).unwrap();
    let xml = String::from_utf8(p.data.clone()).unwrap();
    assert!(
        xml.contains(before),
        "test mutation did not target original fixture"
    );
    p.data = xml.replacen(before, after, 1).into_bytes();
    write_package(&parts).unwrap()
}
#[test]
fn opens_independently_authored_complete_docx_and_saves_format() {
    let doc = import_document(DIRECT).unwrap();
    assert_eq!(
        document_text(&doc),
        "独立文字 😀 Rust & XML\nCenter e\u{301} 🌍\n"
    );
    assert_eq!(doc.paragraphs.len(), 3);
    assert_eq!(doc.paragraphs[1].align, Alignment::Center);
    assert_eq!(doc.paragraphs[2].align, Alignment::Right);
    assert!(doc.paragraphs[0].runs[1].style.bold);
    assert_eq!(doc.paragraphs[0].runs[1].style.font_size, 14.0);
    assert_eq!(doc.paragraphs[0].runs[1].style.color, "#C00000");
    assert!(doc.paragraphs[1].runs[0].style.italic);
    assert_eq!(doc.paragraphs[2].runs[0].style.font_size, 18.0);
    assert_eq!(doc.page.width, 595.3);
    assert_eq!(doc.page.height, 841.9);
    assert_eq!(
        import_document(&export_document(&doc).unwrap()).unwrap(),
        doc
    );
}
#[test]
fn resolves_bounded_styles_and_explicit_resets() {
    let doc = import_document(STYLES).unwrap();
    let first = &doc.paragraphs[0].runs[0].style;
    assert!(first.bold && first.italic);
    assert_eq!(first.color, "#123456");
    assert_eq!(doc.paragraphs[0].align, Alignment::Center);
    let reset = &doc.paragraphs[1].runs[0].style;
    assert!(!reset.bold && !reset.italic);
    assert_eq!(reset.color, "auto");
    assert_eq!(doc.paragraphs[1].align, Alignment::Right);
    assert_eq!(
        import_document(&export_document(&doc).unwrap()).unwrap(),
        doc
    );
}
#[test]
fn native_resaves_with_unrepresentable_effective_properties_reject_without_filtering() {
    for (input, first_unsupported) in [
        (
            include_bytes!("fixtures/basic-docx/native-docx/basic-direct.docx").as_slice(),
            "kern",
        ),
        (
            include_bytes!("fixtures/basic-docx/native-docx/basic-styles.docx").as_slice(),
            "lang",
        ),
    ] {
        let parts = read_package(input).unwrap();
        let styles = parts.iter().find(|p| p.name == "word/styles.xml").unwrap();
        let xml = std::str::from_utf8(&styles.data).unwrap();
        // Untouched native files include kerning and language semantics. Their
        // first unsupported effective property differs because of style order.
        assert!(xml.contains("<w:kern ") && xml.contains("<w:lang "));
        let error = import_document(input).unwrap_err();
        assert!(
            error.contains(first_unsupported),
            "unexpected rejection: {error}"
        );
    }
}
#[test]
fn rejects_ambiguous_defaults_and_unrepresentable_page_rounding() {
    for (before, after) in [
        ("<w:widowControl w:val=\"0\"/>", ""),
        ("<w:pgSz w:w=\"11906\" w:h=\"16838\"/>", ""),
        (" w:eastAsia=\"DejaVu Sans\"", ""),
        ("<w:sz w:val=\"24\"/>", ""),
    ] {
        assert!(import_document(&mutate(DIRECT, "word/document.xml", before, after)).is_err());
    }
    let mut doc = import_document(DIRECT).unwrap();
    doc.page.width = 595.28;
    assert!(export_document(&doc).unwrap_err().contains("1/20 pt"));
}
#[test]
fn tabs_require_and_export_explicit_720_twip_stops() {
    let mut doc = import_document(DIRECT).unwrap();
    doc.paragraphs[0].runs[0].text = "A\tB\tC".into();
    let saved = export_document(&doc).unwrap();
    assert_eq!(import_document(&saved).unwrap(), doc);
    for (before, after) in [
        ("<w:defaultTabStop w:val=\"720\"/>", ""),
        ("w:val=\"720\"", "w:val=\"709\""),
    ] {
        assert!(import_document(&mutate(&saved, "word/settings.xml", before, after)).is_err());
    }
    assert!(import_document(&mutate(
        DIRECT,
        "word/document.xml",
        "<w:t xml:space=\"preserve\">",
        "<w:tab/><w:t xml:space=\"preserve\"> "
    ))
    .unwrap_err()
    .contains("720 twip"));
}
#[test]
fn rejects_unsupported_body_and_format_semantics() {
    let cases = [
        ("<w:body>", "<w:body><w:tbl/>"),
        (
            "<w:t xml:space=\"preserve\">",
            "<w:drawing/><w:t xml:space=\"preserve\">",
        ),
        (
            "<w:t xml:space=\"preserve\">",
            "<w:fldChar w:fldCharType=\"begin\"/><w:t xml:space=\"preserve\">",
        ),
        ("<w:jc w:val=\"left\"/>", "<w:jc w:val=\"left\"/><w:numPr/>"),
        (
            "<w:color w:val=\"auto\"/>",
            "<w:color w:val=\"auto\" w:themeColor=\"text1\"/>",
        ),
        (
            "<w:sz w:val=\"24\"/>",
            "<w:sz w:val=\"24\"/><w:highlight w:val=\"yellow\"/>",
        ),
        (
            "<w:jc w:val=\"left\"/>",
            "<w:jc w:val=\"left\"/><w:rPr><w:b/></w:rPr>",
        ),
        ("<w:sectPr>", "<w:sectPr><w:headerReference/>"),
        ("<w:jc w:val=\"left\"/>", "<w:jc w:val=\"both\"/>"),
        ("<w:sz w:val=\"24\"/>", "<w:sz w:val=\"145\"/>"),
        (
            "<w:sz w:val=\"24\"/>",
            "<w:sz w:val=\"24\"/><w:sz w:val=\"24\"/>",
        ),
        ("<w:color w:val=\"auto\"/>", "<w:color w:val=\"AUTO\"/>"),
        ("<w:color w:val=\"auto\"/>", "<w:color val=\"auto\"/>"),
        ("<w:r>", "<w:ins><w:r>"),
    ];
    for (before, after) in cases {
        assert!(
            import_document(&mutate(DIRECT, "word/document.xml", before, after)).is_err(),
            "accepted unsupported mutation {after}"
        );
    }
}
#[test]
fn rejects_xml_namespace_dtd_opc_relationship_and_content_type_confusion() {
    let cases=[
      ("word/document.xml","<?xml version=\"1.0\" encoding=\"UTF-8\"?>","<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE x [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>"),
      ("word/document.xml","http://schemas.openxmlformats.org/wordprocessingml/2006/main","urn:wrong"),
      ("_rels/.rels","Target=\"word/document.xml\"","Target=\"https://example.invalid/secret\" TargetMode=\"External\""),
      ("_rels/.rels","Target=\"word/document.xml\"","Target=\"word/../document.xml\""),
      ("_rels/.rels","Id=\"rId1\"","Id=\"\""),
      ("[Content_Types].xml","application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml","application/vnd.ms-word.document.macroEnabled.main+xml"),
      ("word/document.xml","<w:sz w:val=\"24\"/>","<w:sz xmlns:z=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" w:val=\"24\" z:val=\"25\"/>"),
    ];
    for (part, before, after) in cases {
        assert!(
            import_document(&mutate(DIRECT, part, before, after)).is_err(),
            "accepted malformed {part}/{after}"
        );
    }
    let mut parts = read_package(DIRECT).unwrap();
    parts.push(RawPart {
        name: "word/vbaProject.bin".into(),
        data: vec![0, 1, 2],
    });
    assert!(import_document(&write_package(&parts).unwrap()).is_err());
}
#[test]
fn rejects_style_cycles_unknown_refs_and_next_style_changes() {
    for (before, after) in [
        (
            "<w:basedOn w:val=\"Normal\"/>",
            "<w:basedOn w:val=\"Title\"/>",
        ),
        (
            "<w:basedOn w:val=\"Normal\"/>",
            "<w:basedOn w:val=\"Missing\"/>",
        ),
        (
            "<w:name w:val=\"Title\"/>",
            "<w:name w:val=\"Title\"/><w:next w:val=\"Normal\"/>",
        ),
        ("<w:rPr><w:i/></w:rPr>", "<w:rPr><w:i/><w:u/></w:rPr>"),
    ] {
        assert!(
            import_document(&mutate(STYLES, "word/styles.xml", before, after)).is_err(),
            "accepted unsupported style {after}"
        );
    }
}
