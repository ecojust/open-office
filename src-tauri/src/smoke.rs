//! Opt-in diagnostics for CI's real native WebView test. No production HTTP writes.
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

pub const REPORT_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct Smoke {
    output: PathBuf,
    scope: &'static str,
    started: Instant,
    events: Arc<Mutex<Vec<Value>>>,
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
            events: Arc::new(Mutex::new(vec![])),
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
        let mut events = self.events.lock().unwrap_or_else(|e| e.into_inner());
        if events.len() >= 256 {
            events.remove(0);
        }
        events.push(
            json!({"phase":phase,"detail":detail,"elapsedMs":self.started.elapsed().as_millis()}),
        );
        if let Some(parent) = self.output.parent() {
            let data = serde_json::to_vec_pretty(&json!({"schemaVersion":1,"events":*events}))
                .unwrap_or_default();
            if let Err(error) = atomic_write(&parent.join("diagnostics.json"), &data) {
                eprintln!("OPEN_OFFICE_SMOKE diagnostic-write-failed: {error}");
            }
        }
    }

    pub fn report(&self, report: &Value) -> Result<bool, String> {
        let passed = report
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or("Smoke report requires an explicit ok boolean.")?;
        let bytes = serde_json::to_vec_pretty(report).map_err(|_| "Invalid smoke report.")?;
        if bytes.len() > REPORT_LIMIT {
            return Err("Smoke report exceeds 1 MiB.".into());
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
        Some("word-package-ipc") => Ok("word-package-ipc"),
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
    format!(
        r#"(() => {{
      const base = {base};
      if (location.href.startsWith(base) && new URL(location.href).searchParams.get('nativeSmoke') === '1') {{
        const send = (path, body) => fetch(base + '__native-smoke/' + path, {{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify(body)}}).catch(() => {{}});
        send('progress',{{phase:'document-start',detail:'native initialization script'}});
        let failed = false;
        const failure = (value) => {{ if(failed)return;failed=true;send('failure',{{ok:false,phase:'renderer-uncaught',error:String(value).slice(0,4000),crossOriginIsolated:globalThis.crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer!=='undefined',userAgent:navigator.userAgent}}); }};
        addEventListener('error',e=>{{if(e.message)failure(e.message);else if(e.target?.tagName==='SCRIPT')failure('Entry script failed to load')}},true);
        addEventListener('unhandledrejection',e=>failure(e.reason?.message||e.reason));
      }}
    }})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn smoke_scope_defaults_to_full_and_rejects_unknown_values() {
        assert_eq!(parse_scope(None).unwrap(), "full");
        assert_eq!(parse_scope(Some("full")).unwrap(), "full");
        assert_eq!(
            parse_scope(Some("word-package-ipc")).unwrap(),
            "word-package-ipc"
        );
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
}
