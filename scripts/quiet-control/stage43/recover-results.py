"""Read named QA files only from a powered-off VMware disk, including INDX fallback.
No mount, guest write, credentials or general user-file extraction.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

repo = Path(__file__).resolve().parents[3]
workspace = repo.parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--confirmed-powered-off", action="store_true", required=True)
parser.add_argument("--stage", choices=["4.3","selective-routing","routing-usability","subscription-compat","unified-nodes","cleanup"], default="4.3")
args = parser.parse_args()
if "Total running VMs: 0" not in subprocess.check_output([r"D:\VMware\vmrun.exe", "list"], text=True):
    raise SystemExit("VM must be powered off")
sys.path.insert(0, str(workspace / "research/tools/qa-disk-reader"))
from dissect.hypervisor.disk.vmdk import VMDK
from dissect.volume.disk import Disk
from dissect.ntfs import NTFS
from dissect.ntfs.util import segment_reference

disk = VMDK(Path(r"D:\VMware\VMashine\Windows 11 x64.vmdk"))  # all extents rb
ntfs = NTFS(max(Disk(disk).partitions, key=lambda p: p.size).open())
report_name = {"4.3":"stage43.json","selective-routing":"selective.json","routing-usability":"usability.json","subscription-compat":"subscription.json","unified-nodes":"unified-nodes.json","cleanup":"cleanup.json"}[args.stage]
known = {report_name,"qa-guest.marker", "Results", "stage43.json", "QA-INPUTS.json", "launcher-state.json", "stdout.log", "stderr.log", "fixture-certificate.json", "app.stdout.log", "app.stderr.log"}
needles = [s.encode("utf-16-le") for s in known | {"QuietControl-QA-", "profiles-dark-", "profiles-light-", "home-dark-", "home-light-", "selective-", "usability-", "subscription-", "nodes-", "case-", "cleanup-"}]
matches = []
size, record_size = ntfs.mft.get(0).size(), ntfs._record_size
for offset in range(0, size, 4 * 1024 * 1024):
    ntfs.mft.fh.seek(offset)
    chunk = ntfs.mft.fh.read(min(4 * 1024 * 1024, size - offset))
    for pos in range(0, len(chunk), record_size):
        raw = chunk[pos:pos + record_size]
        if not any(needle in raw for needle in needles):
            continue
        try:
            rec = ntfs.mft.get((offset + pos) // record_size)
            if not rec.header.Flags & 1:
                continue
            for attr in rec.attributes[0x30]:
                matches.append((segment_reference(attr.attr.ParentDirectory), attr.file_name, rec.segment, rec.is_dir()))
        except Exception:
            continue

runs = sorted({(name, segment) for parent, name, segment, directory in matches if parent == 5 and directory and re.fullmatch(r"QuietControl-QA-\d{8}-\d{6}", name)}, reverse=True)
for run, base in runs:
    markers = [seg for parent, name, seg, directory in matches if parent == base and name == "qa-guest.marker" and not directory]
    results = [seg for parent, name, seg, directory in matches if parent == base and name == "Results" and directory]
    if not markers or not results or b"VMware" not in ntfs.mft.get(markers[0]).open().read():
        continue
    files = {name:seg for parent, name, seg, directory in matches if parent == results[0] and not directory}
    if report_name not in files:
        continue
    try:
        report = json.loads(ntfs.mft.get(files[report_name]).open().read())
    except (ValueError, UnicodeError) as error:
        # Preserve the newest failed run's launcher logs instead of silently
        # falling back to an older successful report.
        report = {"stage":args.stage,"checks":[],"errors":["Unreadable QA report: " + str(error)],"screenshots":[]}
    if report.get("stage") != args.stage:
        continue
    wanted = known | set(report.get("screenshots", [])) | set(report.get("evidence_files", []))
    out = workspace / {"4.3":"design/quiet-control-stage43/output","selective-routing":"design/selective-routing/output","routing-usability":"design/routing-usability/output","subscription-compat":"design/subscription-stage45/output","unified-nodes":"design/unified-nodes/output","cleanup":"design/cleanup-release/output"}[args.stage] / run.removeprefix("QuietControl-QA-")
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name in sorted(wanted & files.keys()):
        if Path(name).name != name:
            raise SystemExit("Invalid QA filename")
        data = ntfs.mft.get(files[name]).open().read()
        (out / name).write_bytes(data)
        manifest.append({"path":name,"record":files[name],"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    missing = sorted(set(report.get("screenshots", [])) - files.keys())
    (out / "RECOVERY-MANIFEST.json").write_text(json.dumps({"sourceRun":run,"readOnlySource":True,"files":manifest,"missingScreenshots":missing}, indent=2), encoding="utf-8")
    print(json.dumps({"output":str(out),"recovered":len(manifest),"missingScreenshots":missing,"completedAt":report.get("completedAt"),"errors":report.get("errors"),"passed":sum(c["passed"] for c in report["checks"]),"failed":[c for c in report["checks"] if not c["passed"]]}, ensure_ascii=False, indent=2))
    break
else:
    raise SystemExit("No matching QA report found in an allocated, marked QA directory")
