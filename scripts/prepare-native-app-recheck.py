"""Validate and extract the exact retained diagnostic App; never build or publish."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile

SOURCE = "5d9e3f7b884e83022e948b991179c847ac0411e5"
directory = Path(os.environ["OPEN_OFFICE_RECHECK_DOWNLOAD"])
destination = Path(os.environ["RUNNER_TEMP"]) / "open-office-prebuilt-native-recheck"
assert not destination.exists(), "App recheck destination must be fresh"
identity_file = directory / "identity.json"
assert identity_file.is_file() and not identity_file.is_symlink() and identity_file.stat().st_size <= 4096
identity = json.loads(identity_file.read_text())
assert identity.get("commit") == SOURCE and str(identity.get("runId")) == os.environ["OPEN_OFFICE_SOURCE_RUN_ID"]
assert identity.get("diagnosticOnly") is True and identity.get("releaseAcceptance") is False
archive = directory / "Open-Office-diagnostic-macos-arm64.app.tar.gz"
assert archive.is_file() and not archive.is_symlink() and 0 < archive.stat().st_size <= 2 * 1024**3
def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()
assert digest(archive) == identity.get("archiveSha256"), "Retained App archive digest mismatch"
with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    assert 0 < len(members) <= 100000
    assert sum(member.size for member in members) <= 4 * 1024**3
    for member in members:
        path = PurePosixPath(member.name)
        assert path.parts and path.parts[0] == "Open Office.app" and not path.is_absolute() and ".." not in path.parts
        assert member.isdir() or member.isfile() or member.issym() or member.islnk()
    # data_filter rejects escaping links and traversal; internal framework links survive.
    source.extractall(destination, filter="data")
app = destination / "Open Office.app"
executable = app / "Contents/MacOS/open-office"
assert executable.is_file() and not executable.is_symlink()
assert digest(executable) == identity.get("executableSha256"), "Retained executable digest mismatch"
assert os.access(executable, os.X_OK), "Retained executable mode was not preserved"
with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as output:
    output.write(f"OPEN_OFFICE_RECHECK_APP={app}\n")
proof = {"schemaVersion": 1, "diagnosticOnly": True, "releaseAcceptance": False,
         "sourceCommit": SOURCE, "sourceRunId": identity["runId"], "harnessCommit": os.environ["GITHUB_SHA"],
         "archiveSha256": identity["archiveSha256"], "executableSha256": identity["executableSha256"],
         "archiveVerified": True, "executableVerified": True}
Path("artifacts/native-full-crash").mkdir(parents=True, exist_ok=True)
Path("artifacts/native-full-crash/prebuilt-identity.json").write_text(json.dumps(proof) + "\n")
print("Retained diagnostic App identity and executable verified; no release acceptance.")
