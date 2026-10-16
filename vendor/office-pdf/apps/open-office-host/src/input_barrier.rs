/// A confirmed discard must consume the integration's queued input before another
/// document can restore its text focus. Clearing egui's last input alone is insufficient.
#[derive(Default)]
pub(crate) struct InputDiscardBarrier {
    pending: bool,
}

impl InputDiscardBarrier {
    pub(crate) fn arm(&mut self) {
        self.pending = true;
    }

    pub(crate) fn pending(&self) -> bool {
        self.pending
    }

    pub(crate) fn consume(&mut self, raw: &mut egui::RawInput) {
        if self.pending {
            raw.events.clear();
            raw.dropped_files.clear();
            raw.hovered_files.clear();
            self.pending = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::InputDiscardBarrier;

    #[test]
    fn discarded_composition_cannot_reach_the_next_document() {
        let mut barrier = InputDiscardBarrier::default();
        barrier.arm();
        let mut raw = egui::RawInput::default();
        raw.events.push(egui::Event::Ime(egui::ImeEvent::Commit("未确认文字".into())));
        raw.events.push(egui::Event::Text("旧文稿输入".into()));
        assert!(barrier.pending());
        barrier.consume(&mut raw);
        assert!(raw.events.is_empty());
        assert!(!barrier.pending());

        // The barrier is consumed before activation; the first genuine keystroke
        // in the surviving document must not be dropped.
        raw.events.push(egui::Event::Text("新文稿输入".into()));
        barrier.consume(&mut raw);
        assert!(matches!(raw.events.as_slice(), [egui::Event::Text(text)] if text == "新文稿输入"));
    }
}
