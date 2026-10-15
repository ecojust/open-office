"""Read-only, bounded CI summary of an existing native editing diagnostic.

Never runs an app or interprets an artifact as code. ZIP members are read in
place after path/type/size validation; nothing from the archive is extracted.
"""
import argparse
from datetime import datetime
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
    value = {"section": section, **bounded(payload)}
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    # Keep annotations individually retrievable and valid JSON. Never split a
    # user-controlled string into another workflow command.
    def strings(node):
        items = node.items() if isinstance(node, dict) else enumerate(node) if isinstance(node, list) else []
        for key, item in items:
            if isinstance(item, str) and len(item.encode("utf-8")) > 64:
                yield node, key, item
            elif isinstance(item, (dict, list)):
                yield from strings(item)
    while len(text.encode("utf-8")) > 2800:
        candidates = list(strings(value))
        if not candidates:
            text = json.dumps({"section": section, "summaryError": "section exceeded annotation limit"})
            break
        parent, key, item = max(candidates, key=lambda item: len(item[2].encode("utf-8")))
        limit = max(60, len(item.encode("utf-8")) - (len(text.encode("utf-8")) - 2800) - 8)
        parent[key] = item.encode("utf-8")[:limit].decode("utf-8", "ignore") + "…"
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
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


def read_evidence(archive, files, filename, limit, as_json=True):
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
    if not as_json:
        return data
    value = json.loads(data)
    require(isinstance(value, dict), f"{filename} must contain a JSON object")
    return value


def pick(value, keys):
    value = value if isinstance(value, dict) else {}
    return {key: value[key] for key in keys if key in value}


def native_event_summary(event):
    summary = pick(event, ["phase", "detail", "elapsedMs", "unixMs", "generation"])
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


def native_timeline(events):
    return [native_event_summary(event) for event in events if isinstance(event, dict) and (
        str(event.get("phase", "")).startswith(("editing", "web-content", "fatal"))
        or event.get("phase") in ("document-start", "error", "unhandledrejection", "window-error", "renderer-uncaught", "renderer-resize-observer-notification")
    )][-30:]


def compact_text(value, limit):
    return scrub(value, limit).encode("utf-8")[:limit].decode("utf-8", "ignore")


def compact_timeline(native):
    result = []
    names = {"editing-input-request": "input", "editing-input-complete": "complete",
             "editing-window-geometry": "geometry", "web-content-terminated": "TERMINATED",
             "web-content-reload-requested": "reload", "document-start": "boot"}
    for event in native_timeline(native.get("events") or []):
        phase, detail = event.get("phase"), event.get("detail")
        if phase == "editing-window-geometry" and isinstance(detail, dict):
            viewport = detail.get("viewport") or {}
            detail = f'{detail.get("actionId")} bounds={detail.get("width")}x{detail.get("height")} css={viewport.get("width")}x{viewport.get("height")}'
        elif phase in ("editing-input-request", "document-start") and isinstance(detail, str):
            try:
                parsed = json.loads(detail)
                detail = str(parsed.get("bootId", ""))[:12] if phase == "document-start" else f'{parsed.get("actionId")} {parsed.get("kind")} {parsed.get("text", parsed.get("key", ""))}'
            except (json.JSONDecodeError, AttributeError):
                pass
        result.append(compact_text(f'{event.get("elapsedMs")}ms g{event.get("generation")} {names.get(phase, phase)} {detail}', 80))
    # Two bounded groups retain all 30 events without expanding the general
    # per-array limit or spending additional GitHub annotations.
    return [result[:15], result[15:]]


def process_rows(samples):
    result = []
    for sample in samples:
        rows = []
        for row in (sample.get("rows") or [])[:40]:
            match = re.fullmatch(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)", str(row))
            if not match:
                continue
            pid, parent, rss, cpu, command = match.groups()
            if not re.search(r"open-office|Open Office|WebContent|WebKit|GPU", command, re.I):
                continue
            rows.append({"pid": int(pid), "ppid": int(parent), "rssKiB": int(rss), "cpuPercent": float(cpu), "process": PurePosixPath(command).name})
        result.append({"unixMs": sample.get("unixMs"), "rows": rows})
    return result


def system_time(value):
    try:
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.timestamp() if parsed.tzinfo else None
        return None
    except (ValueError, OverflowError):
        return None


def system_log_summary(data, report, samples):
    start, end = system_time(report.get("startedAt")), system_time(report.get("finishedAt"))
    app_pid = (report.get("process") or {}).get("pid")
    sampled = {row["pid"] for sample in samples for row in sample["rows"]}
    keywords = re.compile(r"\b(crash(?:ed|ing)?|terminat\w*|kill(?:ed|ing)?|memory|memorystatus|jetsam|GPU|assert\w*|exception|fatal|abort(?:ed)?|error|fault)\b", re.I)
    invalid_message = re.compile(r"\b(?:received\s+invalid\s+(?:IPC\s+)?message|didReceiveInvalidMessage|invalid\s+IPC\s+message)\b", re.I)
    severe = re.compile(r"\b(crash\w*|terminat\w*|kill\w*|jetsam|exception|fatal|abort\w*)\b|\bassert(?:ion)?\s+(?:failed|failure)\b|\bfailed\s+assertion\b", re.I)
    selected, parsed_count, skipped = [], 0, 0
    first_parsed_timestamp, last_parsed_timestamp = None, None
    for line in data.splitlines():
        if len(line) > 65536:
            skipped += 1
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            skipped += 1
            continue
        if not isinstance(event, dict):
            continue
        parsed_count += 1
        message = event.get("eventMessage")
        timestamp = system_time(event.get("timestamp"))
        if timestamp is not None:
            last_parsed_timestamp = scrub(event["timestamp"], 80)
            if first_parsed_timestamp is None:
                first_parsed_timestamp = last_parsed_timestamp
        if not isinstance(message, str) or not (keywords.search(message) or invalid_message.search(message)):
            continue
        if start is None or end is None or timestamp is None or not start - 2 <= timestamp <= end + 2:
            continue
        pid = event.get("processID")
        if isinstance(pid, str) and pid.isdigit():
            pid = int(pid)
        if not isinstance(pid, int):
            pid = None
        if isinstance(app_pid, int) and pid == app_pid:
            correlation = "launched-app-pid"
        elif pid in sampled:
            correlation = "sampled-WebKit-pid; app ownership unproven"
        elif re.search(r"com\.ecojust\.openoffice|\bopen-office\b", message, re.I) or (isinstance(app_pid, int) and re.search(rf"\bpid\s*[:=]?\s*{app_pid}\b", message, re.I)):
            correlation = "message references app or launched pid"
        else:
            continue
        item = {"time": scrub(event.get("timestamp"), 80), "pid": pid, "process": scrub(PurePosixPath(str(event.get("processImagePath") or "unknown")).name, 100), "correlation": correlation, "message": scrub(message, 1000)}
        # Leave room for JSON grouping and notice metadata within the overall
        # 20 KB output budget, even when messages contain multibyte characters.
        while len(json.dumps(item, ensure_ascii=False).encode("utf-8")) > 630:
            item["message"] = item["message"][:-20]
        selected.append((bool(severe.search(message) or invalid_message.search(message)), timestamp, item))
    # Actual failures and invalid IPC messages outrank normal assertion lifecycle
    # or verbose GPU logs; retain chronology among the selected messages.
    selected = sorted(sorted(selected, key=lambda row: (row[0], row[1]), reverse=True)[:20], key=lambda row: row[1])
    return {"parsedLines": parsed_count, "skippedLines": skipped, "matchingLines": len(selected),
            "firstParsedTimestamp": first_parsed_timestamp, "lastParsedTimestamp": last_parsed_timestamp,
            "timeFilterAvailable": start is not None and end is not None,
            "limitation": "Related log messages only, not proof of cause. Sampled WebKit PIDs may belong to another application.",
            "lines": [row[2] for row in selected]}


def local_evidence(directory):
    require(directory.is_dir() and not directory.is_symlink(), "Local evidence directory is missing or is a symlink")
    root = directory.resolve()
    files = [item.name for item in root.iterdir()]
    require(len(files) <= 128, "Local evidence inventory exceeds bound")

    def read(filename, limit, as_json=True):
        path = root / filename
        if not path.exists() and not path.is_symlink():
            return None
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and not path.is_symlink() and metadata.st_size <= limit, f"Unsafe or oversized {filename}")
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit, f"{filename} exceeds read bound")
        if not as_json:
            return data
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
    # GitHub retains only ten notices per step. Spend five on compact summaries
    # and at most five on filtered log excerpts; never emit a large JSON notice.
    state = editing.get("lastState") or {}
    notice("status", {"runId": run["id"], "headSha": expected_sha, "conclusion": run.get("conclusion"), "artifactId": artifact["id"], "bytes": artifact["size_in_bytes"], "establishesFix": False,
        "report": {**pick(report, ["status", "ok", "blockedReason", "durationMs"]), "error": compact_text(report.get("error") or "", 500)},
        "frontend": {"ok": frontend.get("ok"), "error": compact_text(frontend.get("error") or "", 250), "editingError": compact_text(editing.get("error") or "", 250),
            "lastState": {**pick(state, ["activeKey", "shell"]), "tabs": [pick(tab, ["key", "kind", "dirty", "ready"]) for tab in (state.get("tabs") or [])[:4]], "sessions": [pick(session, ["documentId", "revision", "dirty"]) for session in (state.get("sessions") or [])[:4]]}}})
    actions = report.get("actions") or []
    notice("overview", {"system": pick(report.get("system"), ["swVers", "machine", "node"]), "host": {key: pick(host.get(key), ["status", "stdout"]) for key in ["macOS", "macOSBuild", "hardwareArch"]},
        "sentCount": len(actions), "actions": [{"id": (action.get("request") or {}).get("actionId"), "kind": (action.get("request") or {}).get("kind"), **pick(action.get("result"), ["ok", "eventCount", "error"])} for action in actions[:16]],
        "preflight": {**pick(preflight, ["kind", "ok", "error"]), "permissions": pick(preflight.get("permissions"), ["postEventAccess", "accessibilityTrusted", "screenCaptureAccess", "inputSourceId", "osVersion"])}})
    notice("native", {**pick(native, ["generation", "terminations", "scope"]), "timeline": compact_timeline(native)})
    process = report.get("process") or {}
    samples = process_rows((report.get("processSamples") or [])[-200:])
    recent = []
    for sample in samples[-6:]:
        rows = [row for row in sample["rows"] if re.search(r"open-office|Open Office|WebContent", row["process"], re.I)]
        recent.append({"t": sample["unixMs"], "count": len(rows), "rssKiB": sum(row["rssKiB"] for row in rows), "top": [[row["pid"], row["rssKiB"], row["cpuPercent"], compact_text(row["process"], 35)] for row in sorted(rows, key=lambda row: row["rssKiB"], reverse=True)[:3]]})
    notice("process", {**pick(process, ["pid", "exitCode", "signal", "spawnError"]), "stderrTail": compact_text(str(process.get("stderrTail") or "")[-650:], 650),
        "rssSamples": recent, "rssColumns": ["pid", "rssKiB", "cpuPercent", "process"], "rssLimit": "Last six samples; top three App/WebContent rows, at most 40 source rows. Snapshot only, not evidence of a memory kill.",
        "crashes": [compact_text(PurePosixPath(name).name, 100) for name in files if PurePosixPath(name).name.startswith("crash-") and name.endswith((".ips", ".crash"))][:4]})
    log = read("system-webkit.ndjson", 8 * 1024 * 1024, False)
    summary = system_log_summary(log or b"", report, samples)
    notice("system-log", {"available": log is not None, **pick(report.get("systemLog"), ["bytes", "truncated", "mode", "totalBytes", "droppedBytes", "startsMidLine", "stderr"]), **pick(summary, ["parsedLines", "skippedLines", "matchingLines", "firstParsedTimestamp", "lastParsedTimestamp", "timeFilterAvailable", "limitation"])})
    for offset in range(0, len(summary["lines"]), 4):
        notice("related-system-log", {"part": offset // 4 + 1, "lines": summary["lines"][offset:offset + 4], "causalityEstablished": False})


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
                summarize(lambda filename, limit, as_json=True: read_evidence(archive, files, filename, limit, as_json), files, run, artifact, args.expected_sha)
        return 0
    except Exception as error:
        # Only locally generated validation messages are exposed. URL-bearing
        # network/parser diagnostics and arbitrary exception payloads stay out.
        reason = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        notice("inspection-failed", {"ok": False, "error": scrub(reason, 1000), "establishesFix": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
