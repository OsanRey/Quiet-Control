"""Create a self-contained ISO; no VM/device/network changes. Requires pywin32."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import pythoncom
import win32com.client

repo = Path(__file__).resolve().parents[3]
workspace = repo.parents[2]
stage = workspace / "design/selective-routing"
parser = argparse.ArgumentParser()
parser.add_argument("--iso", type=Path, default=stage / "Quiet-Control-QA-selective.iso")
args = parser.parse_args()
iso = args.iso.resolve()
if not iso.is_relative_to(workspace.resolve()) or iso.suffix.lower() != ".iso":
    raise SystemExit("ISO must remain inside this workspace")
# An existing mounted image must only be replaced after checking VMware state.
if iso.exists():
    running = subprocess.check_output([r"D:\VMware\vmrun.exe", "list"], text=True)
    if "Total running VMs: 0" not in running:
        raise SystemExit("Refusing to replace an ISO while a VM is running")

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as src:
        for block in iter(lambda: src.read(1048576), b""):
            h.update(block)
    return h.hexdigest()

dist = stage / "dist"
build = json.loads((dist / "portable-result.json").read_text(encoding="utf-8"))
archive = dist / "Satelite-Quiet-Control-selective-win-x64-portable.zip"
if not build["allPayloadHashesVerified"] or digest(archive) != build["sha256"]:
    raise SystemExit("Portable verification failed")
qa = stage / "qa-inputs"
payload = qa / "payload"
(payload / "Scripts/selective").mkdir(parents=True, exist_ok=True)

def link_or_copy(src, dst):
    if dst.exists():
        if digest(src) == digest(dst):
            return
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)

link_or_copy(archive, payload / archive.name)
link_or_copy(Path(shutil.which("node")), payload / "node.exe")
shutil.copy2(repo / "scripts/quiet-control/cdp.mjs", payload / "Scripts/cdp.mjs")
shutil.copy2(Path(__file__).with_name("acceptance.mjs"), payload / "Scripts/selective/acceptance.mjs")
shutil.copy2(Path(__file__).with_name("fixtures.mjs"), payload / "Scripts/selective/fixtures.mjs")
shutil.copy2(Path(__file__).with_name("ProcessProbe.cs"), payload / "Scripts/selective/ProcessProbe.cs")
legacy = workspace / "research/runtime/stage/resources/rule-sets/system-geolocation-not-cn.srs"
lock = json.loads((repo / "scripts/portable-inputs.lock.json").read_text(encoding="utf-8"))
expected = next(e["sha256"] for e in lock["files"] if e["path"] == "resources/rule-sets/system-geolocation-not-cn.srs")
if digest(legacy) != expected:
    raise SystemExit("Legacy test fixture integrity failure")
link_or_copy(legacy, payload / "Scripts/selective/legacy-geolocation.srs")
shutil.copy2(Path(__file__).with_name("guest-run.ps1"), qa / "guest-run.ps1")
(qa / "START-QA.cmd").write_text('@echo off\necho QC_SELECT_V3 - wait for "Results ready" before shutting down\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0guest-run.ps1"\npause\n', encoding="ascii")
inputs = {"stage":"selective-routing", "diskLabel":"QC_SELECT_V3", "productCommit":build["customCommit"],
          "qaCommit":subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip(),
          "launcherSha256":digest(qa / "guest-run.ps1"),
          "files":[{"path":p.relative_to(payload).as_posix(),"sha256":digest(p)} for p in sorted(payload.rglob("*")) if p.is_file()]}
(qa / "QA-INPUTS.json").write_text(json.dumps(inputs, indent=2), encoding="utf-8")
image = win32com.client.Dispatch("IMAPI2FS.MsftFileSystemImage")
image.FileSystemsToCreate = 3
image.VolumeName = "QC_SELECT_V3"
image.Root.AddTree(str(qa), False)
stream = image.CreateResultImage().ImageStream
stream = stream._oleobj_.QueryInterface(pythoncom.IID_IStream) if hasattr(stream, "_oleobj_") else stream.QueryInterface(pythoncom.IID_IStream)
with iso.open("wb") as target:
    while block := stream.Read(1048576):
        target.write(block)
info = {"iso":str(iso),"diskLabel":"QC_SELECT_V3","bytes":iso.stat().st_size,"sha256":digest(iso),"productCommit":build["customCommit"]}
(stage / "qa-iso-result.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
print(json.dumps(info, indent=2, ensure_ascii=False))
