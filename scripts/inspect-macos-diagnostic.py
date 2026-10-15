"""Read-only, bounded CI summary of an existing native editing diagnostic.

Never runs an app or interprets an artifact as code. ZIP members are read in
place after path/type/size validation; nothing from the archive is extracted.
"""
import argparse
import json
import os
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ARTIFACT = "macos-editing-diagnostics"
WORKFLOW = ".github/workflows/macos-editing-diagnostic.yml"
MAX_DOWNLOAD = 32 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
API = "https://api.github.com"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def scrub(value, limit=1500):
    text = str(value)
    token = os.environ.get("GH_INSPECT_TOKEN", "")
    if token:
        text = text.replace(token, "[redacted]")
    text = re.sub(r"https?://[^\s\"'<>]+", "[url redacted]", text)
    text = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "[token redacted]", text)
    text = re.sub(r"(?i)\b(?:authorization|cookie|token|password|secret)\s*[:=]\s*[^\r\n,;]+", "[credential redacted]", text)
    text = re.sub(r"\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\r\n ]+", "[environment assignment redacted]", text)
    text = "".join(char for char in text if ord(char) >= 32 or char in "\n\t")
    return text[:limit]


def bounded(value, depth=0):
    if depth > 6:
        return "[depth limit]"
    if isinstance(value, str):
        return scrub(value, 1500)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, list):
        return [bounded(item, depth + 1) for item in value[:16]]
    if isinstance(value, dict):
        return {scrub(key, 80): bounded(item, depth + 1) for key, item in list(value.items())[:20]}
    return "[unsupported value]"


def notice(section, payload):
    text = json.dumps({"section": section, **bounded(payload)}, ensure_ascii=False, separators=(",", ":"))
    # Keep annotations individually retrievable and valid JSON. Never split a
    # user-controlled string into another workflow command.
    if len(text) > 16000:
        text = json.dumps({"section": section, "summaryError": "section exceeded annotation limit"})
    escaped = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::notice title=macOS diagnostic {section}::{escaped}", flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def api(path, token, redirect=False):
    request = urllib.request.Request(API + path, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "open-office-diagnostic-inspector",
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            data = response.read(2 * 1024 * 1024 + 1)
            require(len(data) <= 2 * 1024 * 1024, "API response exceeds bound")
            return json.loads(data)
    except urllib.error.HTTPError as error:
        if redirect and error.code == 302:
            url = error.headers.get("Location", "")
            parsed = urllib.parse.urlsplit(url)
            require(parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password, "Invalid artifact redirect")
            return url
        raise ValueError(f"GitHub API request failed (HTTP {error.code})") from None


def verify_run(run_id, expected_sha, repository, token):
    require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "Invalid run_id")
    require(re.fullmatch(r"[a-f0-9]{40}", expected_sha), "expected_sha must be the exact lowercase 40-character commit")
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid current repository")
    prefix = f"/repos/{repository}"
    repo = api(prefix, token)
    require(repo.get("full_name") == repository, "Current repository mismatch")
    run = api(f"{prefix}/actions/runs/{run_id}", token)
    require(str(run.get("id")) == run_id and run.get("repository", {}).get("id") == repo.get("id"), "Run repository or ID mismatch")
    require(run.get("repository", {}).get("full_name") == repository, "Run repository name mismatch")
    require(run.get("status") == "completed", "Diagnostic run must be completed")
    require(run.get("head_sha") == expected_sha, "Diagnostic run head SHA mismatch")
    workflow_id = run.get("workflow_id")
    require(isinstance(workflow_id, int) and workflow_id > 0, "Invalid source workflow ID")
    workflow = api(f"{prefix}/actions/workflows/{workflow_id}", token)
    require(workflow.get("id") == workflow_id and workflow.get("path") == WORKFLOW, "Unexpected source workflow file")
    require(run.get("path", "").split("@")[0] == WORKFLOW, "Run workflow path mismatch")
    inventory = api(f"{prefix}/actions/runs/{run_id}/artifacts?per_page=100", token)
    require(isinstance(inventory.get("total_count"), int) and inventory["total_count"] <= 100, "Artifact inventory exceeds bound")
    matches = [item for item in inventory.get("artifacts", []) if item.get("name") == ARTIFACT]
    require(len(matches) == 1, "Expected exactly one diagnostic artifact")
    artifact = matches[0]
    require(artifact.get("expired") is False, "Diagnostic artifact has expired")
    require(isinstance(artifact.get("id"), int) and artifact["id"] > 0, "Invalid artifact ID")
    require(isinstance(artifact.get("size_in_bytes"), int) and 0 < artifact["size_in_bytes"] <= MAX_DOWNLOAD, "Artifact download exceeds bound")
    owner = artifact.get("workflow_run", {})
    require(str(owner.get("id")) == run_id and owner.get("head_sha") == expected_sha and owner.get("repository_id") == repo.get("id"), "Artifact source run mismatch")
    return run, artifact, prefix


def download_zip(url, destination):
    # Signed storage redirects are fetched without the GitHub Authorization
    # header. Do not log the URL or urllib exception text containing it.
    request = urllib.request.Request(url, headers={"User-Agent": "open-office-diagnostic-inspector"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response, destination.open("wb") as output:
            require(urllib.parse.urlsplit(response.url).scheme == "https", "Unexpected storage redirect scheme")
            total = 0
            while chunk := response.read(64 * 1024):
                total += len(chunk)
                require(total <= MAX_DOWNLOAD, "Artifact download exceeds bound")
                output.write(chunk)
    except urllib.error.HTTPError as error:
        raise ValueError(f"Artifact storage download failed (HTTP {error.code})") from None


def archive_members(archive):
    members = archive.infolist()
    require(0 < len(members) <= 128, "ZIP member count exceeds bound")
    total, files = 0, {}
    for item in members:
        name = item.filename
        path = PurePosixPath(name)
        require(name and not path.is_absolute() and ".." not in path.parts and "\\" not in name and "\x00" not in name and ":" not in name, "Unsafe ZIP member path")
        mode = item.external_attr >> 16
        require(not stat.S_ISLNK(mode) and (stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR)), "Unsafe ZIP member type")
        require(not item.flag_bits & 1, "Encrypted ZIP member is unsupported")
        require(item.file_size <= 64 * 1024 * 1024, "ZIP member exceeds bound")
        total += item.file_size
        require(total <= MAX_EXPANDED, "Expanded ZIP exceeds bound")
        if item.is_dir():
            continue
        require(name not in files, "Duplicate ZIP member")
        files[name] = item
    return files


def read_evidence(archive, files, filename, limit):
    # upload-artifact normally strips the common directory; accept its exact
    # original prefix as well, but never search arbitrary nested locations.
    matches = [files[name] for name in (filename, f"artifacts/macos-editing/{filename}", f"macos-editing/{filename}") if name in files]
    require(len(matches) <= 1, "Ambiguous evidence file")
    if not matches:
        return None
    require(matches[0].file_size <= limit, f"{filename} exceeds read bound")
    with archive.open(matches[0]) as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, f"{filename} exceeds read bound")
    value = json.loads(data)
    require(isinstance(value, dict), f"{filename} must contain a JSON object")
    return value


def pick(value, keys):
    value = value if isinstance(value, dict) else {}
    return {key: value[key] for key in keys if key in value}


def native_event_summary(event):
    summary = pick(event, ["phase", "detail", "elapsedMs", "generation"])
    detail = summary.get("detail")
    if summary.get("phase") == "editing-window-geometry" and isinstance(detail, str) and len(detail) <= 4096:
        try:
            geometry = json.loads(detail)
            if isinstance(geometry, dict):
                # notice() still applies its normal depth, field-count and total
                # limits, but native rectangles no longer become cut-off JSON.
                summary["detail"] = geometry
        except json.JSONDecodeError:
            pass
    return summary


def local_evidence(directory):
    require(directory.is_dir() and not directory.is_symlink(), "Local evidence directory is missing or is a symlink")
    root = directory.resolve()
    files = [item.name for item in root.iterdir()]
    require(len(files) <= 128, "Local evidence inventory exceeds bound")

    def read(filename, limit):
        path = root / filename
        if not path.exists() and not path.is_symlink():
            return None
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and not path.is_symlink() and metadata.st_size <= limit, f"Unsafe or oversized {filename}")
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit, f"{filename} exceeds read bound")
        value = json.loads(data)
        require(isinstance(value, dict), f"{filename} must contain a JSON object")
        return value

    return read, files


def summarize(read, files, run, artifact, expected_sha):
    report = read("report.json", 12 * 1024 * 1024) or {}
    host = read("host.json", 64 * 1024) or {}
    require(not report.get("commit") or report["commit"] == expected_sha, "Report commit mismatch")
    require(not report.get("runId") or str(report["runId"]) == str(run["id"]), "Report run ID mismatch")
    require(not host.get("commit") or host["commit"] == expected_sha, "Host commit mismatch")
    preflight = read("preflight.json", 64 * 1024) or report.get("preflight") or {}
    native = read("native-diagnostics.json", 1024 * 1024) or report.get("nativeDiagnostics") or {}
    frontend = read("frontend-report.json", 12 * 1024 * 1024) or report.get("frontend") or {}
    editing = frontend.get("editing") or {}
    notice("source", {"runId": run["id"], "headSha": expected_sha, "conclusion": run.get("conclusion"), "attempt": run.get("run_attempt"), "artifactId": artifact["id"], "bytes": artifact["size_in_bytes"], "summaryOnly": True, "establishesFix": False})
    notice("status", {"reportPresent": bool(report), **pick(report, ["status", "ok", "error", "blockedReason", "diagnosticOnly", "releaseAcceptance", "durationMs", "gaps"])})
    notice("system", {"system": pick(report.get("system"), ["swVers", "machine", "node"]), "host": {key: pick(host.get(key), ["status", "stdout", "stderr"]) for key in ["macOS", "macOSBuild", "hardwareArch", "appleSilicon", "swift"]}})
    actions = report.get("actions") or []
    notice("actions", {"sentCount": len(actions), "actions": [{"request": pick(action.get("request"), ["actionId", "kind"]), "result": pick(action.get("result"), ["ok", "kind", "eventCount", "error"])} for action in actions[:16]]})
    notice("native", {**pick(native, ["generation", "terminations", "scope"]), "recentEvents": [native_event_summary(event) for event in (native.get("events") or [])[-10:]]})
    state = editing.get("lastState") or {}
    notice("frontend", {**pick(frontend, ["ok", "error", "nativeLifecycle"]), "editing": {**pick(editing, ["ok", "error", "closeError", "checks", "initialTabIds", "finalTabIds", "cleanup"]), "lastState": {**pick(state, ["activeKey", "shell"]), "tabs": [pick(tab, ["key", "kind", "dirty", "ready"]) for tab in (state.get("tabs") or [])[:8]], "sessions": [pick(session, ["key", "kind", "sessionId", "documentId", "revision", "dirty"]) for session in (state.get("sessions") or [])[:8]]}}})
    notice("preflight", {**pick(preflight, ["schemaVersion", "kind", "ok", "error"]), "permissions": pick(preflight.get("permissions"), ["postEventAccess", "accessibilityTrusted", "screenCaptureAccess", "inputSourceId", "osVersion"])})
    process = report.get("process") or {}
    notice("process", {**pick(process, ["exitCode", "signal", "spawnError"]), "stderrTail": scrub(str(process.get("stderrTail") or "")[-1500:], 1500), "crashFilenames": [PurePosixPath(name).name for name in files if PurePosixPath(name).name.startswith("crash-") and name.endswith((".ips", ".crash"))][:8], "crashGaps": pick(report.get("crashReports"), ["gaps"])})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id")
    parser.add_argument("--expected-sha")
    parser.add_argument("--directory", type=Path, help="Summarize this run's local evidence without API access")
    args = parser.parse_args()
    try:
        if args.directory:
            run_id = args.run_id or os.environ.get("GITHUB_RUN_ID", "")
            expected_sha = args.expected_sha or os.environ.get("GITHUB_SHA", "")
            require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "Invalid local run ID")
            require(re.fullmatch(r"[a-f0-9]{40}", expected_sha), "Invalid local source SHA")
            read, files = local_evidence(args.directory)
            summarize(read, files, {"id": int(run_id), "conclusion": "local-evidence-only", "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT")}, {"id": None, "size_in_bytes": None}, expected_sha)
            return 0
        require(bool(args.run_id and args.expected_sha), "--run-id and --expected-sha are required for remote inspection")
        token = os.environ.get("GH_INSPECT_TOKEN", "")
        require(bool(token), "Read-only GitHub token is required")
        run, artifact, prefix = verify_run(args.run_id, args.expected_sha, os.environ.get("GITHUB_REPOSITORY", ""), token)
        url = api(f"{prefix}/actions/artifacts/{artifact['id']}/zip", token, redirect=True)
        require(isinstance(url, str), "Artifact API did not return a download redirect")
        with tempfile.TemporaryDirectory(prefix="open-office-inspect-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
            destination = Path(temporary) / "diagnostic.zip"
            download_zip(url, destination)
            with zipfile.ZipFile(destination) as archive:
                files = archive_members(archive)
                summarize(lambda filename, limit: read_evidence(archive, files, filename, limit), files, run, artifact, args.expected_sha)
        return 0
    except Exception as error:
        # Only locally generated validation messages are exposed. URL-bearing
        # network/parser diagnostics and arbitrary exception payloads stay out.
        reason = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        notice("inspection-failed", {"ok": False, "error": scrub(reason, 1000), "establishesFix": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
