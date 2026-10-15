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
RUST_ARTIFACT = "gridcraft-deferred-cell-edit-regression"
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


def verify_run(run_id, expected_sha, repository, token, artifact_name=ARTIFACT):
    require(artifact_name in (ARTIFACT, RUST_ARTIFACT), "Unexpected diagnostic artifact")
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
    matches = [item for item in inventory.get("artifacts", []) if item.get("name") == artifact_name]
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
    return [native_event_summary(event) for event in events if isinstance(event, dict) and event.get("phase") != "editing-dom-event" and (
        str(event.get("phase", "")).startswith(("editing", "web-content", "fatal"))
        or event.get("phase") in ("document-start", "error", "unhandledrejection", "window-error", "renderer-uncaught", "renderer-resize-observer-notification")
    )][-30:]


def compact_text(value, limit):
    return scrub(value, limit).encode("utf-8")[:limit].decode("utf-8", "ignore")


def dom_event_summary(native):
    events = []
    for event in native.get("events") or []:
        if not isinstance(event, dict) or event.get("phase") != "editing-dom-event":
            continue
        detail = event.get("detail")
        if not isinstance(detail, str) or len(detail) > 400:
            continue
        try:
            value = json.loads(detail)
        except json.JSONDecodeError:
            continue
        if not isinstance(value, dict):
            continue
        events.append([event.get("elapsedMs"), value.get("seq"),
            *[compact_text(str(value.get(key, "")), limit) for key, limit in
              [("actionId", 30), ("type", 20), ("target", 24), ("activeElement", 24)]],
            value.get("trusted") is True])
    return {"count": len(events), "columns": ["nativeMs", "seq", "action", "event", "target", "active", "trusted"],
        "events": events[-12:], "limitation": "Bounded frontend event observations; missing events do not establish the crash location."} if events else None


def compact_timeline(native):
    result = []
    names = {"editing-input-request": "input", "editing-input-complete": "complete",
             "editing-window-geometry": "geometry", "web-content-terminated": "TERMINATED",
             "web-content-reload-requested": "reload", "document-start": "boot"}
    for event in native_timeline(native.get("events") or []):
        phase, detail = event.get("phase"), event.get("detail")
        if phase == "editing-window-geometry" and isinstance(detail, dict):
            viewport = detail.get("viewport") or {}
            detail = f'{detail.get("actionId")} pid={(detail.get("webContent") or {}).get("pid")} bounds={detail.get("width")}x{detail.get("height")} css={viewport.get("width")}x{viewport.get("height")}'
        elif phase in ("editing-input-request", "document-start") and isinstance(detail, str):
            try:
                parsed = json.loads(detail)
                detail = str(parsed.get("bootId", ""))[:12] if phase == "document-start" else f'{parsed.get("actionId")} {parsed.get("kind")} {parsed.get("text", parsed.get("key", ""))}'
            except (json.JSONDecodeError, AttributeError):
                pass
        elif phase == "editing-preselect" and isinstance(detail, str):
            try:
                parsed = json.loads(detail)
                elapsed = parsed.get("elapsedMs")
                wait = round(elapsed) if isinstance(elapsed, (int, float)) and 0 <= elapsed <= 180000 else "?"
                editor = "none" if parsed.get("editor") is None else "present"
                detail = f'{parsed.get("phase")} {parsed.get("activeCell")} {wait}ms {parsed.get("mode")} editor={editor} {parsed.get("focus")}'
            except (json.JSONDecodeError, AttributeError):
                pass
            phase = "preselect"
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


def parse_context(time, pids):
    if not time and not pids:
        return None
    require(bool(time and pids), "Context time and PIDs must be supplied together")
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", time), "Context time must be an exact UTC timestamp")
    anchor = system_time(time)
    require(anchor is not None, "Invalid context time")
    require(re.fullmatch(r"[1-9]\d{0,9}(?:,[1-9]\d{0,9})?", pids), "Context requires one or two comma-separated PIDs")
    selected = [int(value) for value in pids.split(",")]
    require(len(set(selected)) == len(selected) and all(1 < value <= 2147483647 for value in selected), "Context PIDs must be distinct process IDs")
    return {"time": time, "anchor": anchor, "pids": selected}


def read_system_logs(read, report):
    """Read both bounded capture phases, deduplicating only their overlap.

    The collector checkpoints its initial buffer before waiting for ReportCrash.
    That second buffer can contain the first explanation of a WebContent exit.
    Both phases use the same PID/time filters and share the annotation quota.
    """
    sources, chunks, previous, duplicates = [], [], set(), 0
    for filename, key in (("system-webkit.ndjson", "systemLog"), ("system-reportcrash.ndjson", "reportCrashLog")):
        data = read(filename, 8 * 1024 * 1024, False)
        sources.append({"file": filename, "available": data is not None, "bytesRead": len(data or b""),
            **pick(report.get(key), ["bytes", "truncated", "mode", "totalBytes", "droppedBytes", "startsMidLine"])})
        if data is None:
            continue
        lines = data.splitlines()
        retained = []
        for line in lines:
            if line in previous:
                duplicates += 1
            else:
                retained.append(line)
        chunks.append(b"\n".join(retained))
        previous.update(lines)
    # A buffer checkpoint can split a record; never concatenate its fragments
    # into a fabricated event. The existing parsers count invalid fragments.
    return b"\n".join(chunks), {"sources": sources, "duplicateLines": duplicates}


def context_log_summary(data, report, samples, context):
    """Exact-PID messages near one instant, without the normal keyword filter.

    Each PID gets its own ten-record quota so application reload chatter cannot
    displace the terminating WebContent process's final messages.
    """
    start, end = system_time(report.get("startedAt")), system_time(report.get("finishedAt"))
    anchor, pids = context["anchor"], context["pids"]
    require(start is not None and end is not None and start <= anchor <= end, "Context time is outside the diagnostic run")
    app_pid = (report.get("process") or {}).get("pid")
    observed = {row["pid"] for sample in samples for row in sample["rows"]}
    observed.add(app_pid)
    require(all(pid in observed for pid in pids), "Context PID was not observed by this diagnostic")
    matches = {pid: [] for pid in pids}
    parsed, skipped, first, last = 0, 0, None, None
    for index, line in enumerate(data.splitlines()):
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
        parsed += 1
        timestamp = system_time(event.get("timestamp"))
        if timestamp is not None:
            if first is None or timestamp < first[0]:
                first = (timestamp, event["timestamp"])
            if last is None or timestamp > last[0]:
                last = (timestamp, event["timestamp"])
        pid = event.get("processID")
        if isinstance(pid, str) and pid.isdigit():
            pid = int(pid)
        message = event.get("eventMessage")
        if type(pid) is not int or pid not in matches or timestamp is None or abs(timestamp - anchor) > 1 or not isinstance(message, str):
            continue
        clean = scrub(message, 65536)
        excerpt = compact_text(clean, 650)
        item = {"time": scrub(event["timestamp"], 80), "pid": pid,
            "process": compact_text(PurePosixPath(str(event.get("processImagePath") or "unknown")).name, 80),
            "type": compact_text(str(event.get("messageType") or ""), 30),
            "subsystem": compact_text(str(event.get("subsystem") or ""), 80),
            "category": compact_text(str(event.get("category") or ""), 60),
            "message": excerpt, "messageTruncated": excerpt != clean}
        while len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 800:
            item["message"] = compact_text(item["message"], max(0, len(item["message"].encode("utf-8")) - 40))
            item["messageTruncated"] = True
        matches[pid].append((abs(timestamp - anchor), timestamp, index, item))
    selected, counts = [], []
    for pid in pids:
        rows = matches[pid]
        chosen = sorted(rows, key=lambda row: (row[0], -row[1], row[2]))[:10]
        selected.extend(chosen)
        counts.append({"pid": pid, "matches": len(rows), "selected": len(chosen), "omitted": len(rows) - len(chosen),
            "firstMatch": min(rows, key=lambda row: row[1])[3]["time"] if rows else None,
            "lastMatch": max(rows, key=lambda row: row[1])[3]["time"] if rows else None})
    return {"time": context["time"], "pids": pids, "radiusSeconds": 1,
        "selection": "Up to ten nearest messages per exact PID, displayed chronologically; no keyword filter.",
        "pidCounts": counts, "parsedLines": parsed, "skippedLines": skipped,
        "firstParsedTimestamp": first[1] if first else None, "lastParsedTimestamp": last[1] if last else None,
        "limitation": "Selected PIDs were observed in this run; this does not establish WebContent ownership or the cause of termination.",
        "lines": [row[3] for row in sorted(selected, key=lambda row: (row[1], row[2]))]}


def owned_webcontent_pids(native):
    result = set()
    for event in (native.get("events") or [])[:256]:
        if not isinstance(event, dict) or event.get("phase") != "editing-window-geometry":
            continue
        detail = native_event_summary(event).get("detail")
        process = detail.get("webContent") if isinstance(detail, dict) else None
        if not isinstance(process, dict):
            continue
        pid = process.get("pid")
        if process.get("supported") is True and process.get("source") == "WKWebView._webProcessIdentifier" and type(pid) is int and 1 < pid <= 2147483647:
            result.add(pid)
    return result


def exit_observer_summary(read, report, native):
    observer = report.get("exitObserver")
    recovered = not isinstance(observer, dict) or observer.get("status") == "pending"
    if recovered:
        observer = read("webcontent-exit-observer.json", 64 * 1024) or observer
    if not isinstance(observer, dict):
        return None
    pid = observer.get("registeredPid")
    exit_event = observer.get("exit") or {}
    return {**pick(observer, ["status", "pid", "registered", "registeredPid", "registeredAtUnixMs", "cleanup"]),
        "reason": compact_text(observer.get("reason") or "", 100),
        "recoveredFromStandalone": recovered,
        "ownedPid": type(pid) is int and pid in owned_webcontent_pids(native),
        "exit": pick(exit_event, ["pid", "unixMs", "receivedAtUnixMs", "rawData", "fflags", "waitStatusAvailable", "waitStatus", "signaled", "signal", "exitCode", "coreDumped", "detailAvailable", "detailFlags", "memoryExit", "codeSigningExit", "decryptFailure"]),
        "causalityEstablished": False}


def crash_reporter_context_summary(data, report, observer):
    """Reporting-service messages near a verified WebContent SIGTRAP.

    These processes need not mention the target PID. Time proximity is only
    reporting-pipeline context and never establishes process ownership/cause.
    """
    observer = observer or {}
    exit_event = observer.get("exit") or {}
    pid = observer.get("registeredPid")
    require(observer.get("status") == "exited" and observer.get("registered") is True
        and observer.get("ownedPid") is True and observer.get("pid") == pid and exit_event.get("pid") == pid,
        "Crash-reporter context requires an exit observed for the exact native WebContent PID")
    status = exit_event.get("waitStatus")
    require(exit_event.get("waitStatusAvailable") is True and type(status) is int and 0 <= status <= 65535
        and status & 0x7f == 5 and exit_event.get("signaled") is True and exit_event.get("signal") == 5,
        "Crash-reporter context requires a recorded SIGTRAP wait status")
    start, end = system_time(report.get("startedAt")), system_time(report.get("finishedAt"))
    milliseconds = exit_event.get("unixMs")
    require(type(milliseconds) in (int, float) and start is not None and end is not None
        and start * 1000 <= milliseconds <= end * 1000,
        "Recorded SIGTRAP time is outside the diagnostic run")
    anchor = milliseconds / 1000
    processes = ("ReportCrash", "osanalyticshelper")
    matches = {process: [] for process in processes}
    parsed, skipped = 0, 0
    for index, line in enumerate(data.splitlines()):
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
        parsed += 1
        process = PurePosixPath(str(event.get("processImagePath") or "")).name
        timestamp = system_time(event.get("timestamp"))
        message = event.get("eventMessage")
        if process not in matches or timestamp is None or not isinstance(message, str):
            continue
        if not (start <= timestamp <= end and anchor - 2 <= timestamp <= anchor + 10):
            continue
        process_pid = event.get("processID")
        if isinstance(process_pid, str) and process_pid.isdigit():
            process_pid = int(process_pid)
        if type(process_pid) is not int or not 1 < process_pid <= 2147483647:
            process_pid = None
        clean = scrub(message, 65536)
        excerpt = compact_text(clean, 650)
        item = {"time": scrub(event["timestamp"], 80), "pid": process_pid, "process": process,
            "type": compact_text(str(event.get("messageType") or ""), 30),
            "message": excerpt, "messageTruncated": excerpt != clean}
        while len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 800:
            item["message"] = compact_text(item["message"], max(0, len(item["message"].encode("utf-8")) - 40))
            item["messageTruncated"] = True
        matches[process].append((abs(timestamp - anchor), timestamp, index, item))
    # Give each reporting service a quota, then share unused slots. A noisy
    # ReportCrash cannot hide osanalyticshelper's report destination/failure.
    selected, remaining, counts = [], [], []
    for process in processes:
        rows = sorted(matches[process], key=lambda row: (row[0], row[1], row[2]))
        selected.extend(rows[:10])
        remaining.extend(rows[10:])
    selected.extend(sorted(remaining, key=lambda row: (row[0], row[1], row[2]))[:20 - len(selected)])
    for process in processes:
        count = sum(row[3]["process"] == process for row in selected)
        counts.append({"process": process, "matches": len(matches[process]), "selected": count,
            "omitted": len(matches[process]) - count})
    return {"exitPid": pid, "exitUnixMs": milliseconds, "signal": 5, "beforeSeconds": 2, "afterSeconds": 10,
        "processCounts": counts, "parsedLines": parsed, "skippedLines": skipped,
        "selection": "Up to twenty nearest reporting-service records, reserving ten per service; chronological display, no keyword or target-PID filter.",
        "limitation": "Time proximity only. These service messages may describe other processes; no ownership or crash cause is inferred. Missing messages may reflect the original capture filter.",
        "lines": [row[3] for row in sorted(selected, key=lambda row: (row[1], row[2]))]}


def system_log_summary(data, report, samples, max_lines=20, native=None):
    start, end = system_time(report.get("startedAt")), system_time(report.get("finishedAt"))
    app_pid = (report.get("process") or {}).get("pid")
    sampled = {row["pid"] for sample in samples for row in sample["rows"]}
    owned = owned_webcontent_pids(native or report.get("nativeDiagnostics") or {})
    keywords = re.compile(r"\b(crash(?:ed|ing)?|terminat\w*|kill(?:ed|ing)?|exit(?:ed)?|signal|SIG[A-Z]+|memory|memorystatus|jetsam|GPU|assert\w*|exception|fatal|abort(?:ed)?|error|fault)\b", re.I)
    invalid_message = re.compile(r"\b(?:received\s+(?:an?\s+)?invalid\s+(?:IPC\s+)?message|didReceiveInvalidMessage|invalid\s+IPC\s+message)\b", re.I)
    failed_assertion = re.compile(r"\bassert(?:ion)?\s+(?:failed|failure)\b|\bfailed\s+assertion\b", re.I)
    severe = re.compile(r"\b(crash\w*|terminat\w*|kill\w*|jetsam|exception|fatal|abort\w*)\b|\bassert(?:ion)?\s+(?:failed|failure)\b|\bfailed\s+assertion\b", re.I)
    exit_reason = re.compile(r"\b(?:exit(?:ed)?|SIG[A-Z]+|signal|jetsam|memorystatus|crash\w*)\b", re.I)
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
        elif pid in owned:
            correlation = "WKWebView WebContent pid"
        elif owned and any(re.search(rf"(?<![A-Za-z0-9]){target}(?![A-Za-z0-9])", message) for target in owned):
            correlation = "message references WKWebView WebContent pid"
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
        exact_failure = correlation in ("launched-app-pid", "WKWebView WebContent pid") and (invalid_message.search(message) or failed_assertion.search(message))
        priority = 3 if exact_failure else 2 if correlation == "message references WKWebView WebContent pid" and exit_reason.search(message) else int(bool(severe.search(message) or invalid_message.search(message)))
        selected.append((priority, timestamp, item))
    # Actual failures and invalid IPC messages outrank normal assertion lifecycle
    # or verbose GPU logs; retain chronology among the selected messages.
    selected = sorted(sorted(selected, key=lambda row: (row[0], row[1]), reverse=True)[:max_lines], key=lambda row: row[1])
    return {"parsedLines": parsed_count, "skippedLines": skipped, "matchingLines": len(selected),
            "firstParsedTimestamp": first_parsed_timestamp, "lastParsedTimestamp": last_parsed_timestamp,
            "timeFilterAvailable": start is not None and end is not None,
            "ownedWebContentPids": sorted(owned),
            "limitation": "Related log messages only, not proof of cause. PID mentions are textual correlation; sampled WebKit PIDs may belong to another application.",
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


def crash_text(value, limit=160):
    # Crash symbols/reasons sometimes embed source or user paths. Emit only
    # bounded explanatory text, never image paths, registers or raw report JSON.
    text = re.sub(r"(?<![\w:])(?:/[^\s\"'<>]+|[A-Za-z]:\\[^\s\"'<>]+)", "[path redacted]", str(value))
    return compact_text(text, limit)


def crash_metadata(report, files):
    collected = report.get("crashReports") or {}
    directories = [{**pick(item, ["directory", "readable", "recentCount"]),
        "recent": [{"file": crash_text(PurePosixPath(str(row.get("file", ""))).name, 70), **pick(row, ["matched", "bytes"])}
            for row in (item.get("recent") or [])[:2]]} for item in (collected.get("directories") or [])[:2]]
    services = [{"query": crash_text(item.get("query", ""), 80), **pick(item, ["exitCode", "signal", "errorCode"]),
        "lines": [crash_text(line, 100) for line in (item.get("lines") or [])[:3]]}
        for item in (report.get("crashReporterServices") or [])[:4]]
    return {"crashReports": {"available": "crashReports" in report, **pick(collected, ["scanCount", "waitMs", "maxWaitMs"]),
        "fileCount": len(collected.get("files") or []), "gapCount": len(collected.get("gaps") or []),
        "gaps": [crash_text(gap, 100) for gap in (collected.get("gaps") or [])[:2]], "directories": directories},
        "reportCrashLog": {"available": any(PurePosixPath(name).name == "system-reportcrash.ndjson" for name in files),
            **pick(report.get("reportCrashLog"), ["bytes", "truncated", "mode", "totalBytes", "droppedBytes", "startsMidLine"])},
        "crashReporterServices": services, "serviceEvidenceAvailable": "crashReporterServices" in report,
        "limits": "At most two recent filenames per directory and three status lines per service; service state does not establish the crash cause."}


def ips_summary(data):
    require(len(data) <= 8 * 1024 * 1024, "IPS exceeds read bound")
    text = data.decode("utf-8-sig").strip()
    decoder = json.JSONDecoder()
    header, end = decoder.raw_decode(text)
    require(isinstance(header, dict), "IPS must contain an object")
    # Modern .ips commonly contains a one-line metadata object followed by the
    # actual crash object. A single crash object is valid as well.
    remaining = text[end:].strip()
    body = header
    if remaining:
        body, end = decoder.raw_decode(remaining)
        require(isinstance(body, dict) and not remaining[end:].strip(), "Unexpected IPS trailing data")
    exception = {key: crash_text(value, 180) for key, value in pick(body.get("exception"), ["type", "signal", "subtype", "codes"]).items() if isinstance(value, (str, int))}
    termination = {key: crash_text(value, 180) if isinstance(value, str) else value for key, value in
        pick(body.get("termination"), ["namespace", "code", "indicator", "byProc", "byPid"]).items() if isinstance(value, (str, int))}
    reasons = (body.get("termination") or {}).get("reasons") if isinstance(body.get("termination"), dict) else None
    if isinstance(reasons, list):
        termination["reasons"] = [crash_text(reason, 160) for reason in reasons[:2] if isinstance(reason, str)]
    threads = body.get("threads") if isinstance(body.get("threads"), list) else []
    index = body.get("faultingThread")
    if type(index) is not int or not 0 <= index < len(threads):
        index = next((i for i, thread in enumerate(threads) if isinstance(thread, dict) and thread.get("triggered") is True), None)
    thread = threads[index] if index is not None and isinstance(threads[index], dict) else {}
    frames = thread.get("frames") if isinstance(thread.get("frames"), list) else []
    images = body.get("usedImages") if isinstance(body.get("usedImages"), list) else []
    excerpt = []
    for frame in frames[:6]:
        if not isinstance(frame, dict):
            continue
        image_index = frame.get("imageIndex")
        image = images[image_index] if type(image_index) is int and 0 <= image_index < len(images) and isinstance(images[image_index], dict) else {}
        excerpt.append({"symbol": crash_text(frame.get("symbol") or "[unsymbolicated]", 180),
            "image": crash_text(PurePosixPath(str(image.get("name") or "[unknown]")).name, 60),
            **{key: value for key, value in pick(frame, ["symbolLocation", "imageOffset"]).items() if type(value) is int}})
    return {"pid": body.get("pid") if type(body.get("pid")) is int else None,
        "process": crash_text(body.get("procName") or header.get("app_name") or "[unknown]", 80),
        "exception": exception, "termination": termination, "triggeredThread": index,
        "frameCount": len(frames), "frames": excerpt, "causalityEstablished": False,
        "limitation": "Reported exception and up to six triggered-thread frames only; report ownership and root cause require correlation."}


def crash_summaries(read, files):
    names = sorted({PurePosixPath(name).name for name in files if PurePosixPath(name).parent in
        (PurePosixPath("."), PurePosixPath("artifacts/macos-editing"), PurePosixPath("macos-editing"))
        and PurePosixPath(name).name.startswith("crash-") and name.endswith(".ips")},
        key=lambda name: ("webcontent" not in name.lower(), name))
    summaries = []
    for name in names[:2]:
        try:
            data = read(name, 8 * 1024 * 1024, False)
            require(data is not None, "IPS is missing")
            summary = ips_summary(data)
        except Exception as error:
            # Parser/read errors may include local paths or raw report text.
            summary = {"error": type(error).__name__, "parsed": False}
        summaries.append({"file": crash_text(name, 100), **summary})
    return summaries, len(names)


def debugger_summary(read, report, files):
    debugger = report.get("debugger") or {}
    if debugger.get("requested") is not True:
        # A cleanup failure can leave the old preflight report on disk. Recover
        # only bounded, fixed-name LLDB trace evidence, never generated code.
        candidates = []
        for name in files:
            stripped = re.sub(r"^(?:artifacts/macos-editing/|macos-editing/)", "", name)
            if re.fullmatch(r"webcontent-lldb-[A-Za-z0-9_-]{1,80}/trace\.txt", stripped):
                candidates.append(stripped)
        if not candidates:
            return None
        if len(candidates) != 1:
            return {"recoveredFromTrace": False, "traceCount": len(candidates), "reason": "ambiguous-debugger-traces"}
        data = read(candidates[0], 1024 * 1024, False) or b""
        lines = data.decode("utf-8", "replace").splitlines()
        events = []
        for line in lines:
            if len(line) > 8192 or not re.match(r"^OO_LLDB_[a-f0-9-]{36}:", line):
                continue
            try:
                event = json.loads(line.split(":", 1)[1])
                if isinstance(event, dict):
                    events.append(pick(event, ["event", "source", "pid", "operation", "code", "syscall", "reason", "detail", "cleanup", "reasons"]))
            except json.JSONDecodeError:
                continue
        return {"recoveredFromTrace": True, "diagnosticOnly": True,
            "limitation": "Final debugger report was not saved. Trace evidence cannot establish native input or application lifecycle results.",
            "events": events[-8:], "traceBytes": len(data),
            "traceTail": [crash_text(line, 160) for line in lines[-8:] if line.strip() and not line.startswith("OO_LLDB_")]}
    summary = {**pick(debugger, ["requested", "status", "reason", "pid", "ready", "safeToContinue", "cleanup", "captured", "continuedWithoutDebugger"]),
        "diagnosticOnly": True, "events": [pick(event, ["event", "source", "operation", "code", "syscall", "reason", "detail", "reasons"]) for event in (debugger.get("events") or [])[-8:]],
        "trace": pick(debugger.get("trace"), ["bytes", "totalBytes", "truncated"])}
    filename = (debugger.get("trace") or {}).get("file")
    if debugger.get("captured") is True and isinstance(filename, str) and re.fullmatch(r"webcontent-lldb-[A-Za-z0-9_-]{1,80}/trace\.txt", filename):
        try:
            data = read(filename, 1024 * 1024, False)
            lines = (data or b"").decode("utf-8", "replace").splitlines()
            start = next((index for index, line in enumerate(lines) if line.startswith("* thread #")), None)
            if start is None:
                start = next((index + 1 for index, line in enumerate(lines) if "--- thread backtrace all" in line), None)
            if start is not None:
                excerpt = []
                for line in lines[start:]:
                    if len(excerpt) == 10 or line.startswith(("--- register", "--- image", "OO_LLDB_")):
                        break
                    if line.strip():
                        excerpt.append(crash_text(line, 170))
                summary["backtraceExcerpt"] = excerpt
        except Exception as error:
            summary["traceReadError"] = type(error).__name__
    return summary


def summarize(read, files, run, artifact, expected_sha, context=None, crash_reporter_context=False):
    report = read("report.json", 12 * 1024 * 1024) or {}
    host = read("host.json", 64 * 1024) or {}
    require(not report.get("commit") or report["commit"] == expected_sha, "Report commit mismatch")
    require(not report.get("runId") or str(report["runId"]) == str(run["id"]), "Report run ID mismatch")
    require(not host.get("commit") or host["commit"] == expected_sha, "Host commit mismatch")
    require(not (context and crash_reporter_context), "Crash-reporter context cannot use macOS PID context")
    if crash_reporter_context:
        native = read("native-diagnostics.json", 1024 * 1024) or report.get("nativeDiagnostics") or {}
        observer = exit_observer_summary(read, report, native)
        log, capture = read_system_logs(read, report)
        summary = crash_reporter_context_summary(log, report, observer)
        notice("crash-reporter-context", {"runId": run["id"], "headSha": expected_sha, "artifactId": artifact["id"],
            "establishesFix": False, "causalityEstablished": False,
            "available": any(source["available"] for source in capture["sources"]), **capture,
            **{key: value for key, value in summary.items() if key != "lines"}})
        for offset in range(0, len(summary["lines"]), 3):
            notice("crash-reporter-log", {"part": offset // 3 + 1, "lines": summary["lines"][offset:offset + 3],
                "causalityEstablished": False})
        return
    if context:
        samples = process_rows((report.get("processSamples") or [])[-200:])
        log, capture = read_system_logs(read, report)
        summary = context_log_summary(log, report, samples, context)
        notice("context", {"runId": run["id"], "headSha": expected_sha, "artifactId": artifact["id"],
            "establishesFix": False, "available": any(source["available"] for source in capture["sources"]), **capture,
            "systemLog": pick(report.get("systemLog"), ["bytes", "truncated", "mode", "totalBytes", "droppedBytes", "startsMidLine"]),
            **{key: value for key, value in summary.items() if key != "lines"}})
        # One context notice plus at most seven excerpts stays below GitHub's
        # ten-notice limit. Three 800-byte records fit the 2,800-byte bound.
        for offset in range(0, len(summary["lines"]), 3):
            notice("context-log", {"part": offset // 3 + 1, "lines": summary["lines"][offset:offset + 3], "causalityEstablished": False})
        return
    preflight = read("preflight.json", 64 * 1024) or report.get("preflight") or {}
    native = read("native-diagnostics.json", 1024 * 1024) or report.get("nativeDiagnostics") or {}
    frontend = read("frontend-report.json", 12 * 1024 * 1024) or report.get("frontend") or {}
    editing = frontend.get("editing") or {}
    # GitHub retains only ten notices per step. Reserve six for metadata, at
    # most two for IPS excerpts, and spend the remaining slots on system logs.
    state = editing.get("lastState") or {}
    notice("status", {"runId": run["id"], "headSha": expected_sha, "conclusion": run.get("conclusion"), "artifactId": artifact["id"], "bytes": artifact["size_in_bytes"], "establishesFix": False,
        "report": {**pick(report, ["status", "ok", "blockedReason", "durationMs", "editEntry"]), "error": compact_text(report.get("error") or "", 500)},
        "frontend": {"ok": frontend.get("ok"), **pick(editing, ["editEntry", "diagnosticOnly"]), "error": compact_text(frontend.get("error") or "", 250), "editingError": compact_text(editing.get("error") or "", 250),
            "lastState": {**pick(state, ["activeKey", "shell"]), "tabs": [pick(tab, ["key", "kind", "dirty", "ready"]) for tab in (state.get("tabs") or [])[:4]], "sessions": [pick(session, ["documentId", "revision", "dirty"]) for session in (state.get("sessions") or [])[:4]]}}})
    actions = report.get("actions") or []
    notice("overview", {"system": pick(report.get("system"), ["swVers", "machine", "node"]), "host": {key: pick(host.get(key), ["status", "stdout"]) for key in ["macOS", "macOSBuild", "hardwareArch"]},
        "sentCount": len(actions), "actions": [{"id": (action.get("request") or {}).get("actionId"), "kind": (action.get("request") or {}).get("kind"), **pick(action.get("result"), ["ok", "eventCount", "error"])} for action in actions[:16]],
        "preflight": {**pick(preflight, ["kind", "ok", "error"]), "permissions": pick(preflight.get("permissions"), ["postEventAccess", "accessibilityTrusted", "screenCaptureAccess", "inputSourceId", "osVersion"])}})
    notice("native", {**pick(native, ["generation", "terminations", "scope"]), "timeline": compact_timeline(native)})
    process = report.get("process") or {}
    exit_observer = exit_observer_summary(read, report, native)
    samples = process_rows((report.get("processSamples") or [])[-200:])
    recent = []
    for sample in samples[-(4 if exit_observer is not None else 6):]:
        rows = [row for row in sample["rows"] if re.search(r"open-office|Open Office|WebContent", row["process"], re.I)]
        recent.append({"t": sample["unixMs"], "count": len(rows), "rssKiB": sum(row["rssKiB"] for row in rows), "top": [[row["pid"], row["rssKiB"], row["cpuPercent"], compact_text(row["process"], 35)] for row in sorted(rows, key=lambda row: row["rssKiB"], reverse=True)[:3]]})
    notice("process", {**pick(process, ["pid", "exitCode", "signal", "spawnError"]), "stderrTail": compact_text(str(process.get("stderrTail") or "")[-650:], 650),
        "rssSamples": recent, "rssColumns": ["pid", "rssKiB", "cpuPercent", "process"], "rssLimit": "Last six samples (four with an exit observer); top three App/WebContent rows, at most 40 source rows. Snapshot only, not evidence of a memory kill.",
        **({"exitObserver": exit_observer} if exit_observer is not None else {}),
        "crashes": [compact_text(PurePosixPath(name).name, 100) for name in files if PurePosixPath(name).name.startswith("crash-") and name.endswith((".ips", ".crash"))][:4]})
    log, capture = read_system_logs(read, report)
    crashes, crash_count = crash_summaries(read, files)
    debugger = debugger_summary(read, report, files)
    dom_events = dom_event_summary(native)
    summary = system_log_summary(log, report, samples, max_lines=4 * (4 - len(crashes) - int(debugger is not None) - int(dom_events is not None)), native=native)
    notice("system-log", {"available": any(source["available"] for source in capture["sources"]), **capture, **pick(report.get("systemLog"), ["bytes", "truncated", "mode", "totalBytes", "droppedBytes", "startsMidLine", "stderr"]), **pick(summary, ["parsedLines", "skippedLines", "matchingLines", "firstParsedTimestamp", "lastParsedTimestamp", "timeFilterAvailable", "ownedWebContentPids", "limitation"])})
    notice("crash-evidence", {**crash_metadata(report, files), "ipsCount": crash_count, "ipsSummarized": len(crashes)})
    for crash in crashes:
        notice("crash-report", crash)
    if debugger is not None:
        notice("debugger", debugger)
    if dom_events is not None:
        notice("dom-events", dom_events)
    # Apply the smaller quota during severity ranking, preserving actual crash
    # messages over later routine GPU/focus chatter.
    lines = summary["lines"]
    for offset in range(0, len(lines), 4):
        notice("related-system-log", {"part": offset // 4 + 1, "lines": lines[offset:offset + 4], "causalityEstablished": False})


def summarize_rust(read, run, artifact, expected_sha):
    data = read("cargo-test.log", 2 * 1024 * 1024, False)
    lines = (data or b"").decode("utf-8", "replace").splitlines()
    pattern = re.compile(r"^error(?:\[|:)|panicked at|^test result: FAILED|^test .* \.\.\. FAILED")
    anchors = [index for index, line in enumerate(lines) if pattern.search(line)]
    selected = list(dict.fromkeys(anchors[:2] + anchors[-1:]))
    notice("rust-regression", {"runId": run["id"], "headSha": expected_sha, "artifactId": artifact["id"],
        "available": data is not None, "bytes": len(data or b""), "lineCount": len(lines),
        "failureMarkers": len(anchors), "establishesFix": False,
        "limits": "Read at most 2 MiB; at most three failure contexts and fourteen tail lines, each line capped at 240 bytes."})
    for part, index in enumerate(selected, 1):
        start, end = max(0, index - 4), min(len(lines), index + 5)
        notice("rust-failure-context", {"part": part, "firstLine": start + 1,
            "lines": [crash_text(line, 240) for line in lines[start:end]]})
    start = max(0, len(lines) - 14)
    for offset in range(start, len(lines), 7):
        notice("rust-log-tail", {"firstLine": offset + 1,
            "lines": [crash_text(line, 240) for line in lines[offset:offset + 7]]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id")
    parser.add_argument("--expected-sha")
    parser.add_argument("--directory", type=Path, help="Summarize this run's local evidence without API access")
    parser.add_argument("--context-time", default="", help="UTC instant for an optional fixed one-second context window")
    parser.add_argument("--context-pids", default="", help="One or two exact, observed PIDs separated by a comma")
    parser.add_argument("--crash-reporter-context", action="store_true", help="Read reporting-service logs from two seconds before to ten seconds after the recorded native WebContent SIGTRAP")
    parser.add_argument("--rust-regression", action="store_true", help="Read only the fixed Grid Rust regression artifact's bounded Cargo log")
    args = parser.parse_args()
    try:
        context = parse_context(args.context_time, args.context_pids)
        require(not (args.rust_regression and context), "Rust regression mode cannot use macOS PID context")
        require(not (args.crash_reporter_context and (args.rust_regression or context)),
            "Crash-reporter context cannot use Rust regression or macOS PID context")
        if args.directory:
            run_id = args.run_id or os.environ.get("GITHUB_RUN_ID", "")
            expected_sha = args.expected_sha or os.environ.get("GITHUB_SHA", "")
            require(re.fullmatch(r"[1-9][0-9]{0,19}", run_id), "Invalid local run ID")
            require(re.fullmatch(r"[a-f0-9]{40}", expected_sha), "Invalid local source SHA")
            read, files = local_evidence(args.directory)
            run = {"id": int(run_id), "conclusion": "local-evidence-only", "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT")}
            artifact = {"id": None, "size_in_bytes": None}
            if args.rust_regression:
                summarize_rust(read, run, artifact, expected_sha)
            else:
                summarize(read, files, run, artifact, expected_sha, context, args.crash_reporter_context)
            return 0
        require(bool(args.run_id and args.expected_sha), "--run-id and --expected-sha are required for remote inspection")
        token = os.environ.get("GH_INSPECT_TOKEN", "")
        require(bool(token), "Read-only GitHub token is required")
        run, artifact, prefix = verify_run(args.run_id, args.expected_sha, os.environ.get("GITHUB_REPOSITORY", ""), token,
            RUST_ARTIFACT if args.rust_regression else ARTIFACT)
        url = api(f"{prefix}/actions/artifacts/{artifact['id']}/zip", token, redirect=True)
        require(isinstance(url, str), "Artifact API did not return a download redirect")
        with tempfile.TemporaryDirectory(prefix="open-office-inspect-", dir=os.environ.get("RUNNER_TEMP")) as temporary:
            destination = Path(temporary) / "diagnostic.zip"
            download_zip(url, destination)
            with zipfile.ZipFile(destination) as archive:
                files = archive_members(archive)
                read = lambda filename, limit, as_json=True: read_evidence(archive, files, filename, limit, as_json)
                if args.rust_regression:
                    summarize_rust(read, run, artifact, args.expected_sha)
                else:
                    summarize(read, files, run, artifact, args.expected_sha, context, args.crash_reporter_context)
        return 0
    except Exception as error:
        # Only locally generated validation messages are exposed. URL-bearing
        # network/parser diagnostics and arbitrary exception payloads stay out.
        reason = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        notice("inspection-failed", {"ok": False, "error": scrub(reason, 1000), "establishesFix": False})
        return 1


if __name__ == "__main__":
    sys.exit(main())
