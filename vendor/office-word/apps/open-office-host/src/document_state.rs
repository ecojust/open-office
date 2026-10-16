//! Host revisions and saved-content tracking without walking unchanged shared document blocks.

use std::sync::Arc;

use office_word_doc::{Blocks, Document, NoteSeparators, Part};

pub(crate) struct DocumentState {
    revision: u32,
    observed: Document,
    saved: Document,
    dirty: bool,
}

impl DocumentState {
    pub(crate) fn new(document: Document) -> Self {
        Self {
            revision: 1,
            observed: document.clone(),
            saved: document,
            dirty: false,
        }
    }

    pub(crate) fn revision(&self) -> u32 {
        self.revision
    }

    pub(crate) fn dirty(&self) -> bool {
        self.dirty
    }

    pub(crate) fn saved(&self) -> &Document {
        &self.saved
    }

    pub(crate) fn sync(&mut self, document: &Document) -> Result<(), String> {
        // Engine revisions alone miss changes to properties made outside Session::run.
        if !documents_equal(&self.observed, document) {
            let revision = self
                .revision
                .checked_add(1)
                .ok_or("document revision exhausted")?;
            // Only content changes can change dirty. Compare to the saved content so undoing
            // back to it is clean, even after the engine's monotonically increasing revision.
            self.dirty = !documents_equal(&self.saved, document);
            self.observed = document.clone();
            self.revision = revision;
        }
        Ok(())
    }

    /// Commit the last synced content, after the host has validated the save receipt.
    pub(crate) fn mark_saved(&mut self) {
        self.saved = self.observed.clone();
        self.dirty = false;
    }
}

fn shared_equal<T: PartialEq>(left: &Arc<T>, right: &Arc<T>) -> bool {
    // Blocks and media use copy-on-write, so a shared allocation has unchanged content.
    // Different allocations can still have equal content (undo, import, or a no-op edit).
    Arc::ptr_eq(left, right) || left.as_ref() == right.as_ref()
}

fn blocks_equal(left: &Blocks, right: &Blocks) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| shared_equal(a, b))
}

fn parts_equal(left: &Part, right: &Part) -> bool {
    let Part { kind, blocks, body } = left;
    kind == &right.kind && body == &right.body && blocks_equal(blocks, &right.blocks)
}

fn separators_equal(left: &NoteSeparators, right: &NoteSeparators) -> bool {
    let NoteSeparators {
        separator,
        continuation_separator,
        continuation_notice,
    } = left;
    let equal = |a: &Option<Blocks>, b: &Option<Blocks>| match (a, b) {
        (Some(a), Some(b)) => blocks_equal(a, b),
        (None, None) => true,
        _ => false,
    };
    equal(separator, &right.separator)
        && equal(continuation_separator, &right.continuation_separator)
        && equal(continuation_notice, &right.continuation_notice)
}

fn documents_equal(left: &Document, right: &Document) -> bool {
    // Exhaustive patterns deliberately make new model fields a compile error here instead
    // of silently excluding them from dirty tracking and the host's save receipt revision.
    let Document {
        body,
        last_section,
        parts,
        styles,
        numbering,
        comments,
        revisions,
        settings,
        core,
        sources,
        custom_props,
        footnote_separators,
        endnote_separators,
        media,
        passthrough,
    } = left;
    blocks_equal(body, &right.body)
        && last_section == &right.last_section
        && parts.len() == right.parts.len()
        && parts
            .iter()
            .zip(&right.parts)
            .all(|((ka, a), (kb, b))| ka == kb && parts_equal(a, b))
        && styles == &right.styles
        && numbering == &right.numbering
        && comments == &right.comments
        && revisions == &right.revisions
        && settings == &right.settings
        && core == &right.core
        && sources == &right.sources
        && custom_props == &right.custom_props
        && separators_equal(footnote_separators, &right.footnote_separators)
        && separators_equal(endnote_separators, &right.endnote_separators)
        && media.len() == right.media.len()
        && media
            .iter()
            .zip(&right.media)
            .all(|((ka, a), (kb, b))| ka == kb && shared_equal(a, b))
        && passthrough.len() == right.passthrough.len()
        && passthrough
            .iter()
            .zip(&right.passthrough)
            .all(|((ka, a), (kb, b))| ka == kb && shared_equal(a, b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use office_word_doc::{Block, CharProps, Paragraph, PartKind, Table};

    fn fixture() -> Document {
        let mut document = Document::from_text("Body text\nSecond paragraph");
        document.parts.insert(
            1,
            Part {
                blocks: Document::from_text("Header").body,
                ..Part::default()
            },
        );
        let separators = NoteSeparators {
            separator: Some(Document::from_text("Separator").body),
            continuation_separator: Some(Document::from_text("Continuation").body),
            continuation_notice: Some(Document::from_text("Notice").body),
        };
        document.footnote_separators = separators.clone();
        document.endnote_separators = separators;
        document
            .media
            .insert("image.png".into(), Arc::new(vec![1, 2, 3]));
        document
            .passthrough
            .insert("customXml/item.xml".into(), Arc::new(b"<a/>".to_vec()));
        document
    }

    fn edit_block(block: &mut Arc<Block>) {
        *Arc::make_mut(block) = Block::Para(Paragraph::with_text("Changed", CharProps::default()));
    }

    #[test]
    fn equal_content_with_shared_or_new_allocations_keeps_revision() -> Result<(), String> {
        let document = fixture();
        let mut state = DocumentState::new(document.clone());
        state.sync(&document)?;
        let reallocated: Document =
            serde_json::from_value(serde_json::to_value(&document).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        assert!(!Arc::ptr_eq(&document.body[0], &reallocated.body[0]));
        assert_eq!(document, reallocated);
        state.sync(&reallocated)?;
        assert_eq!(state.revision(), 1);
        assert!(!state.dirty());
        Ok(())
    }

    #[test]
    fn nested_table_copy_on_write_is_tracked_and_saved_copy_is_unchanged() -> Result<(), String> {
        let mut original = fixture();
        original
            .body
            .push(Arc::new(Block::Table(Table::new(1, 1, 100.0))));
        let mut edited = original.clone();
        let mut state = DocumentState::new(original.clone());
        if let Block::Table(table) = Arc::make_mut(&mut edited.body[2]) {
            edit_block(&mut table.rows[0].cells[0].blocks[0]);
        }
        assert_ne!(edited, original);
        state.sync(&edited)?;
        assert!(state.dirty());
        assert_eq!(state.saved(), &original);
        state.sync(&original)?;
        assert!(!state.dirty());
        Ok(())
    }

    #[test]
    fn every_persisted_field_changes_revision_and_restoring_content_is_clean() -> Result<(), String>
    {
        let changes: &[(&str, fn(&mut Document))] = &[
            ("body", |d| edit_block(&mut d.body[0])),
            ("last_section", |d| d.last_section.page_w += 1.0),
            ("parts.blocks", |d| {
                edit_block(&mut d.parts.entry(1).or_default().blocks[0])
            }),
            ("parts.kind", |d| {
                d.parts.entry(1).or_default().kind = PartKind::Footer
            }),
            ("parts.body", |d| {
                d.parts.entry(1).or_default().body.next = Some(2)
            }),
            ("parts.key", |d| {
                if let Some(part) = d.parts.remove(&1) {
                    d.parts.insert(2, part);
                }
            }),
            ("styles", |d| d.styles.default_chr.bold = Some(true)),
            ("numbering", |d| d.numbering.nums.push(Default::default())),
            ("comments", |d| {
                d.comments.insert(1, Default::default());
            }),
            ("revisions", |d| d.revisions.push(Default::default())),
            ("settings", |d| d.settings.track_changes = true),
            ("core", |d| d.core.title = "Changed title".into()),
            ("sources", |d| d.sources.push(Default::default())),
            ("custom_props", |d| d.custom_props.push(Default::default())),
            ("footnote.separator", |d| {
                if let Some(blocks) = &mut d.footnote_separators.separator {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("footnote.continuation_separator", |d| {
                if let Some(blocks) = &mut d.footnote_separators.continuation_separator {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("footnote.continuation_notice", |d| {
                if let Some(blocks) = &mut d.footnote_separators.continuation_notice {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("endnote.separator", |d| {
                if let Some(blocks) = &mut d.endnote_separators.separator {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("endnote.continuation_separator", |d| {
                if let Some(blocks) = &mut d.endnote_separators.continuation_separator {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("endnote.continuation_notice", |d| {
                if let Some(blocks) = &mut d.endnote_separators.continuation_notice {
                    edit_block(&mut blocks[0]);
                }
            }),
            ("separator.none", |d| d.footnote_separators.separator = None),
            ("media.bytes", |d| {
                if let Some(bytes) = d.media.get_mut("image.png") {
                    Arc::make_mut(bytes)[0] = 9;
                }
            }),
            ("media.key", |d| {
                if let Some(bytes) = d.media.remove("image.png") {
                    d.media.insert("other.png".into(), bytes);
                }
            }),
            ("retained.bytes", |d| {
                if let Some(bytes) = d.passthrough.get_mut("customXml/item.xml") {
                    Arc::make_mut(bytes)[1] = b'b';
                }
            }),
            ("retained.key", |d| {
                if let Some(bytes) = d.passthrough.remove("customXml/item.xml") {
                    d.passthrough.insert("customXml/other.xml".into(), bytes);
                }
            }),
        ];
        for (field, change) in changes {
            let baseline = fixture();
            let mut changed = baseline.clone();
            let mut state = DocumentState::new(baseline.clone());
            change(&mut changed);
            assert_ne!(baseline, changed, "fixture must change {field}");
            state.sync(&changed)?;
            assert_eq!(state.revision(), 2, "{field}");
            assert!(state.dirty(), "{field}");
            state.sync(&changed)?;
            assert_eq!(state.revision(), 2, "unchanged {field}");
            assert!(state.dirty(), "unchanged {field}");
            state.sync(&baseline)?;
            assert_eq!(state.revision(), 3, "restored {field}");
            assert!(!state.dirty(), "restored {field}");
        }
        Ok(())
    }

    #[test]
    fn save_moves_baseline_and_undo_redo_use_content_without_reusing_receipts() -> Result<(), String>
    {
        let original = fixture();
        let mut edited = original.clone();
        let mut state = DocumentState::new(original.clone());
        edit_block(&mut edited.body[0]);
        state.sync(&edited)?;
        let receipt_revision = state.revision();
        state.mark_saved();
        state.sync(&edited)?;
        assert!(!state.dirty());
        assert_eq!(state.saved(), &edited);
        // The engine's undo/redo restores Document snapshots; neither the dirty engine flag
        // nor the engine revision identifies whether that snapshot equals our saved copy.
        state.sync(&original)?;
        assert!(state.dirty());
        assert_ne!(state.revision(), receipt_revision);
        state.sync(&edited)?;
        assert!(!state.dirty());
        assert_ne!(state.revision(), receipt_revision);
        // Discard after a subsequent metadata-only edit also restores the current baseline.
        edited.core.creator = "Author".into();
        state.sync(&edited)?;
        assert!(state.dirty());
        state.sync(&state.saved().clone())?;
        assert!(!state.dirty());
        Ok(())
    }

    #[test]
    fn exhausted_revision_does_not_commit_untracked_content() -> Result<(), String> {
        let original = fixture();
        let mut edited = original.clone();
        let mut state = DocumentState::new(original.clone());
        state.revision = u32::MAX;
        edit_block(&mut edited.body[0]);
        assert!(state.sync(&edited).is_err());
        assert_eq!(state.observed, original);
        assert_eq!(state.revision(), u32::MAX);
        assert!(!state.dirty());
        state.sync(&original)?;
        Ok(())
    }
}
