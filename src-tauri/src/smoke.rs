//! Opt-in diagnostics for CI's real native WebView test. No production HTTP writes.
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

// Reports carry independently inspected DOCX/XLSX/PPTX/PDF round-trip bytes.
// Keep an explicit cap shared by IPC report storage and the failure-only HTTP route.
pub const REPORT_LIMIT: usize = 12 * 1024 * 1024;

#[derive(Default)]
struct Lifecycle {
    events: Vec<Value>,
    generation: u64,
    terminations: u64,
}

#[derive(Clone)]
pub struct Smoke {
    output: PathBuf,
    scope: &'static str,
    started: Instant,
    lifecycle: Arc<Mutex<Lifecycle>>,
    failure: Arc<dyn Fn() + Send + Sync>,
}

impl Smoke {
    pub fn from_environment(
        failure: impl Fn() + Send + Sync + 'static,
    ) -> Result<Option<Self>, String> {
        if std::env::var("OPEN_OFFICE_SMOKE").as_deref() != Ok("1") {
            return Ok(None);
        }
        let output = PathBuf::from(
            std::env::var_os("OPEN_OFFICE_SMOKE_OUTPUT")
                .ok_or("Smoke mode requires OPEN_OFFICE_SMOKE_OUTPUT.")?,
        );
        if !output.is_absolute() {
            return Err("Smoke output must be an absolute path.".into());
        }
        let scope = parse_scope(std::env::var("OPEN_OFFICE_SMOKE_SCOPE").ok().as_deref())?;
        let mut smoke = Self::new(output, failure);
        smoke.scope = scope;
        Ok(Some(smoke))
    }

    pub(crate) fn new(output: PathBuf, failure: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            output,
            scope: "full",
            started: Instant::now(),
            lifecycle: Arc::new(Mutex::new(Lifecycle::default())),
            failure: Arc::new(failure),
        }
    }

    pub fn scope(&self) -> &'static str {
        self.scope
    }

    pub fn note(&self, phase: &str, detail: &str) {
        let phase: String = phase.chars().filter(|c| !c.is_control()).take(80).collect();
        let detail: String = detail
            .chars()
            .filter(|c| !c.is_control())
            .take(400)
            .collect();
        eprintln!("OPEN_OFFICE_SMOKE {phase}: {detail}");
        let mut state = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if phase == "document-start" {
            state.generation += 1;
        }
        if phase == "web-content-terminated" {
            state.terminations += 1;
        }
        if state.events.len() >= 256 {
            state.events.remove(0);
        }
        let generation = state.generation;
        state.events.push(
            json!({"phase":phase,"detail":detail,"elapsedMs":self.started.elapsed().as_millis(),
                "unixMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                "generation":generation}),
        );
        if let Some(parent) = self.output.parent() {
            let data = serde_json::to_vec_pretty(&json!({"schemaVersion":1,"scope":self.scope,
                "generation":state.generation,"terminations":state.terminations,"events":state.events}))
                .unwrap_or_default();
            if let Err(error) = atomic_write(&parent.join("diagnostics.json"), &data) {
                eprintln!("OPEN_OFFICE_SMOKE diagnostic-write-failed: {error}");
            }
        }
    }

    pub fn report(&self, report: &Value) -> Result<bool, String> {
        let mut passed = report
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or("Smoke report requires an explicit ok boolean.")?;
        let mut report = report.clone();
        if self.scope == "macos-editing" {
            let state = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
            report["nativeLifecycle"] =
                json!({"generation":state.generation,"terminations":state.terminations});
            // The browser's successful rerun cannot erase a previous process
            // termination or navigation. This evidence lives in the host process.
            if state.generation != 1 || state.terminations != 0 {
                passed = false;
                report["ok"] = json!(false);
                report["error"] = json!(
                    "Native editing diagnostic observed a page restart or WebContent termination."
                );
            }
        }
        let bytes = serde_json::to_vec_pretty(&report).map_err(|_| "Invalid smoke report.")?;
        if bytes.len() > REPORT_LIMIT {
            return Err("Smoke report exceeds 12 MiB.".into());
        }
        atomic_write(&self.output, &bytes)?;
        self.note("report-written", if passed { "passed" } else { "failed" });
        Ok(passed)
    }

    pub fn failure_report(&self, report: &Value) -> Result<(), String> {
        // This recovery route can report a failure only. Passing the native test
        // still requires working IPC and every actual document-edit assertion.
        if report.get("ok") != Some(&Value::Bool(false)) {
            return Err("The HTTP fallback accepts failures only.".into());
        }
        self.report(report)?;
        Ok(())
    }

    pub fn stop_after_failure(&self) {
        (self.failure)();
    }
}

fn parse_scope(value: Option<&str>) -> Result<&'static str, String> {
    match value {
        None | Some("full") => Ok("full"),
        Some("macos-editing") => Ok("macos-editing"),
        _ => Err("Unknown OPEN_OFFICE_SMOKE_SCOPE.".into()),
    }
}

fn atomic_write(output: &Path, data: &[u8]) -> Result<(), String> {
    let parent = output.parent().ok_or("Invalid smoke output directory.")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    file.write_all(data).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(output).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn initialization_script(base_url: &str) -> String {
    let base = serde_json::to_string(base_url).expect("fixed URL");
    include_str!("smoke-init.js").replace("__OPEN_OFFICE_SMOKE_BASE_URL__", &base)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn smoke_scope_defaults_to_full_and_rejects_unknown_values() {
        assert_eq!(parse_scope(None).unwrap(), "full");
        assert_eq!(parse_scope(Some("full")).unwrap(), "full");
        assert_eq!(parse_scope(Some("macos-editing")).unwrap(), "macos-editing");
        assert!(parse_scope(Some("rust-word-engine")).is_err());
        assert!(parse_scope(Some("word-package-ipc")).is_err());
        assert!(parse_scope(Some("")).is_err());
        assert!(parse_scope(Some("word")).is_err());
    }
    #[test]
    fn http_fallback_cannot_turn_a_failed_ipc_check_into_a_pass() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("report.json");
        let smoke = Smoke::new(output.clone(), || {});
        assert!(smoke.failure_report(&json!({"ok":true})).is_err());
        assert!(!output.exists());
        smoke
            .failure_report(&json!({"ok":false,"phase":"bootstrap","error":"IPC denied"}))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(output).unwrap()).unwrap()["ok"],
            false
        );
        assert!(directory.path().join("diagnostics.json").is_file());
    }

    #[test]
    fn document_round_trip_reports_remain_bounded_without_replacing_valid_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("report.json");
        let smoke = Smoke::new(output.clone(), || {});
        let valid = json!({"ok": true, "pdfBase64": "A".repeat(1024 * 1024 + 1)});
        assert!(smoke.report(&valid).unwrap());
        let saved = std::fs::read(&output).unwrap();
        assert!(saved.len() > 1024 * 1024);
        let oversized = json!({"ok": true, "pdfBase64": "A".repeat(REPORT_LIMIT)});
        assert!(smoke.report(&oversized).is_err());
        assert_eq!(std::fs::read(output).unwrap(), saved);
    }

    #[test]
    fn editing_diagnostic_cannot_pass_after_a_renderer_restart() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("report.json");
        let mut smoke = Smoke::new(output.clone(), || {});
        smoke.scope = "macos-editing";
        smoke.note("document-start", "first");
        assert!(smoke.report(&json!({"ok":true})).unwrap());
        smoke.note("web-content-terminated", "main");
        smoke.note("document-start", "reloaded");
        assert!(!smoke.report(&json!({"ok":true})).unwrap());
        let report: Value = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(report["ok"], false);
        assert_eq!(
            report["nativeLifecycle"],
            json!({"generation":2,"terminations":1})
        );
    }
}
