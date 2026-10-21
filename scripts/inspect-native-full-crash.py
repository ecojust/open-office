"""Bounded IPS metadata and known-system stack summaries; never print raw reports."""
import importlib.util
import json
from pathlib import Path
import re
import stat
import sys

spec = importlib.util.spec_from_file_location("existing_inspector", Path(__file__).with_name("inspect-macos-diagnostic.py"))
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)
IMAGES = {"WebKit", "WebCore", "JavaScriptCore", "libsystem_kernel.dylib", "libsystem_platform.dylib",
          "libsystem_pthread.dylib", "libsystem_c.dylib", "libc++abi.dylib", "libobjc.A.dylib", "open-office", "dyld"}
EXCEPTIONS = {"EXC_BAD_ACCESS", "EXC_BAD_INSTRUCTION", "EXC_ARITHMETIC", "EXC_BREAKPOINT", "EXC_CRASH", "EXC_GUARD", "EXC_RESOURCE", "EXC_CORPSE_NOTIFY"}
SIGNALS = {"SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGTRAP", "SIGKILL", "SIGTERM"}
NAMESPACES = {"SIGNAL", "JETSAM", "RUNNINGBOARD", "FRONTBOARD", "WEBKIT", "CODESIGNING", "DYLD", "GUARD", "RESOURCE"}

def integer(value, maximum=2**63-1):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum else None

def symbol(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_:$<>*& ,.+()\[\]/~=-]{1,240}", value):
        return None
    if not re.match(r"^(?:WTF::|WebCore::|WebKit::|JSC::|IPC::|bmalloc::|pas_|JS[A-Z]|WTFCrash|WTFReport|_*(?:pthread|abort)|std::|dyld)", value):
        return None
    return inspector.scrub(value, 240)

def version(value):
    return value if isinstance(value, str) and re.fullmatch(r"[0-9.]{1,64}", value) else None

def crash_summary(path, index):
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= 8 * 1024 * 1024:
        return {"index": index, "status": "unsafe-or-oversized"}
    text = path.read_text(encoding="utf-8")
    decoder = json.JSONDecoder()
    header, end = decoder.raw_decode(text.lstrip())
    rest = text.lstrip()[end:].strip()
    body = json.loads(rest) if rest else header
    if not isinstance(body, dict):
        return {"index": index, "status": "unsupported-format"}
    exception = body.get("exception") if isinstance(body.get("exception"), dict) else {}
    termination = body.get("termination") if isinstance(body.get("termination"), dict) else {}
    images = body.get("usedImages") if isinstance(body.get("usedImages"), list) else []
    threads = body.get("threads") if isinstance(body.get("threads"), list) else []
    fault = integer(body.get("faultingThread"), 4096)
    selected = threads[fault] if fault is not None and fault < len(threads) else next((t for t in threads[:4096] if isinstance(t, dict) and t.get("triggered") is True), {})
    frames = []
    for frame in (selected.get("frames") or [])[:80]:
        if not isinstance(frame, dict):
            continue
        image_index = integer(frame.get("imageIndex"), 4096)
        image = images[image_index] if image_index is not None and image_index < len(images) else {}
        name = image.get("name") if isinstance(image, dict) else None
        if name not in IMAGES:
            continue
        frames.append({"image": name, "symbol": symbol(frame.get("symbol")), "imageOffset": integer(frame.get("imageOffset")), "symbolOffset": integer(frame.get("symbolLocation"))})
        if len(frames) >= 12:
            break
    image_versions = [{"image": image.get("name"), "version": version(image.get("CFBundleShortVersionString")),
                       "build": version(image.get("CFBundleVersion"))} for image in images[:4096]
                      if isinstance(image, dict) and image.get("name") in {"WebKit", "WebCore", "JavaScriptCore"}][:3]
    bundle = body.get("bundleInfo") if isinstance(body.get("bundleInfo"), dict) else {}
    return {"index": index, "status": "parsed", "pid": integer(body.get("pid"), 2147483647),
            "exceptionType": exception.get("type") if exception.get("type") in EXCEPTIONS else "unknown",
            "signal": exception.get("signal") if exception.get("signal") in SIGNALS else None,
            "terminationNamespace": termination.get("namespace") if termination.get("namespace") in NAMESPACES else "unknown",
            "terminationCode": integer(termination.get("code")), "faultingThread": fault, "frames": frames,
            "systemImageVersions": image_versions, "processBundleVersion": version(bundle.get("CFBundleShortVersionString")),
            "processBundleBuild": version(bundle.get("CFBundleVersion")),
            "rawFieldsOmitted": True}

root = Path(sys.argv[1])
if not root.is_dir() or root.is_symlink():
    inspector.notice("full-crash-ips", {"available": False, "reason": "no-evidence-directory"})
    sys.exit(0)
files = sorted(path for path in root.iterdir() if path.name.startswith("crash-") and path.suffix == ".ips")[:8]
for index, path in enumerate(files):
    try:
        summary = crash_summary(path, index + 1)
    except Exception:
        summary = {"index": index + 1, "status": "unparseable"}
    inspector.notice("full-crash-ips", summary)
if not files:
    inspector.notice("full-crash-ips", {"available": False, "reason": "no-ips-file-retained"})
report_path = root / "report.json"
if report_path.is_file() and not report_path.is_symlink() and report_path.stat().st_size <= 12 * 1024 * 1024:
    report = json.loads(report_path.read_text())
    inspector.notice("full-crash-memory", {"samples": (report.get("systemMemorySamples") or [])[-6:],
        "crashCollection": inspector.pick(report.get("crashReports"), ["scanCount", "waitMs", "maxWaitMs", "gaps"]),
        "memorySamplesAreNotProofOfCause": True})
