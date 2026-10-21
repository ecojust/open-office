"""Strict numeric process/memory and exact-observer summaries. No raw log output."""
import json
from pathlib import Path
import re
import sys

def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value < 2**53 else None

def emit(title, value):
    text = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    if len(text) > 15000:
        raise ValueError("bounded summary exceeded limit")
    print("::notice title=" + title + "::" + text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A"))

root = Path(sys.argv[1])
path = root / "report.json"
if not path.is_file() or path.is_symlink() or path.stat().st_size > 12 * 1024 * 1024:
    emit("full-native-memory", {"available": False})
    sys.exit(0)
report = json.loads(path.read_text())
termination = next((event.get("unixMs") for event in (report.get("nativeDiagnostics") or {}).get("events", [])
                    if event.get("phase") == "web-content-terminated" and number(event.get("unixMs")) is not None), None)
rows = []
for sample in (report.get("processSamples") or [])[-700:]:
    time = number(sample.get("unixMs"))
    if time is None:
        continue
    for row in (sample.get("rows") or [])[:40]:
        match = re.fullmatch(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)", row)
        if not match:
            continue
        name = Path(match[5]).name
        kind = {"open-office": "app", "Open Office": "app", "com.apple.WebKit.WebContent": "web-content",
                "com.apple.WebKit.GPU": "gpu", "com.apple.WebKit.Networking": "network"}.get(name)
        if kind:
            rows.append({"unixMs": time, "pid": int(match[1]), "rssKiB": int(match[3]), "kind": kind})
peaks = {}
for row in rows:
    if row["rssKiB"] > peaks.get(row["pid"], {}).get("rssKiB", -1):
        peaks[row["pid"]] = row
near = []
if termination is not None:
    times = sorted(set(row["unixMs"] for row in rows), key=lambda time: abs(time - termination))[:4]
    for time in sorted(times):
        near.append({"deltaMs": time - termination, "rows": sorted(
            [{key: row[key] for key in ["pid", "rssKiB", "kind"]} for row in rows if row["unixMs"] == time],
            key=lambda row: row["rssKiB"], reverse=True)[:5]})
memory = []
for sample in (report.get("systemMemorySamples") or [])[-180:]:
    values = {key: number((sample.get("pages") or {}).get(key)) for key in
              ["free", "active", "inactive", "speculative", "wired", "compressor", "swapins", "swapouts"]}
    memory.append({"unixMs": number(sample.get("unixMs")), "pageSize": number(sample.get("pageSize")), "pages": values})
near_memory = sorted(memory, key=lambda sample: abs((sample["unixMs"] or 0) - termination))[:4] if termination else memory[-4:]
stats = {key: {"minPages": min(values), "maxPages": max(values)} for key in
         ["free", "active", "inactive", "speculative", "wired", "compressor", "swapins", "swapouts"]
         if (values := [sample["pages"][key] for sample in memory if sample["pages"][key] is not None])}
system = report.get("system") or {}
versions = {}
for key in ["webKitVersion", "webKitBuild"]:
    value = system.get(key)
    versions[key] = value if isinstance(value, str) and re.fullmatch(r"[0-9.]{1,64}", value) else None
sw_vers = system.get("swVers") or ""
for key, pattern in [("macOS", r"ProductVersion:\s*([0-9.]{1,32})"), ("macOSBuild", r"BuildVersion:\s*([A-Za-z0-9.]{1,32})")]:
    match = re.search(pattern, sw_vers)
    versions[key] = match[1] if match else None
emit("full-native-memory", {"versions": versions, "physicalMemoryBytes": number(system.get("memoryBytes")),
     "firstTerminationUnixMs": termination, "sampledPidPeakRss": sorted(peaks.values(), key=lambda row: row["rssKiB"], reverse=True)[:8],
     "terminationNearbyProcesses": near, "systemPageRanges": stats, "terminationNearbyMemory": near_memory,
     "limitations": ["Process ownership is unproven without the separate ownership record.",
                     "Sampling can miss short peaks; RSS alone does not prove an out-of-memory termination."]})
owned = report.get("ownedWebContent") or {}
targets = []
for target in (owned.get("targets") or [])[:4]:
    observer = target.get("observer") or {}
    exit_event = observer.get("exit") or {}
    targets.append({"pid": number(target.get("pid")), "responsiblePid": number(target.get("responsiblePid")),
        "ownershipVerified": target.get("ownershipVerified") is True, "registered": observer.get("registered") is True,
        "exit": {**{key: number(exit_event.get(key)) for key in ["unixMs", "signal", "exitCode", "waitStatus", "detailFlags"]},
                 **{key: exit_event.get(key) is True for key in ["waitStatusAvailable", "detailAvailable", "memoryExit", "codeSigningExit", "decryptFailure"]}}})
emit("full-native-owned-exit", {"appPid": number(owned.get("appPid")), "candidateCount": number(owned.get("candidateCount")),
    "ownershipUnavailableCount": number(owned.get("ownershipUnavailableCount")), "targets": targets,
    "correlationIsAppResponsibilityNotSpecificWebView": True, "signalDoesNotEstablishCause": True})
