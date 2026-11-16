"""Create private post-cleanup VM ISO; no host app or networking changes."""
import hashlib,json,shutil,subprocess,os
from pathlib import Path
import pythoncom,win32com.client
repo=Path(__file__).resolve().parents[3];workspace=repo.parents[2]
stage=workspace/'design/cleanup-release';stage.mkdir(exist_ok=True)
iso=workspace/'design/quiet-control-stage42/Quiet-Control-QA-stage42-UI-standalone.iso'
if 'Total running VMs: 0' not in subprocess.check_output([r'D:\VMware\vmrun.exe','list'],text=True):raise SystemExit('VM must be off')
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
build=json.loads((stage/'dist/portable-result.json').read_text())
archive=Path(build['archive']);assert digest(archive)==build['sha256'] and build['allPayloadHashesVerified']
node=workspace/'research/tools/qa-node22/node.exe'
assert digest(node)=='247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a'
qa=stage/'qa-inputs';payload=qa/'payload';scripts=payload/'Scripts/cleanup';scripts.mkdir(parents=True,exist_ok=True)
for src,dst in [(archive,payload/archive.name),(node,payload/'node.exe')]:
 if dst.exists():dst.unlink()
 try:os.link(src,dst)
 except OSError:shutil.copy2(src,dst)
for name in ['acceptance.mjs','cdp.mjs','engine-process.ps1']:shutil.copy2(Path(__file__).with_name(name),scripts/name)
shutil.copy2(Path(__file__).with_name('guest-run.ps1'),qa/'guest-run.ps1')
(qa/'START-QA.cmd').write_text('@echo off\necho QC_CLEAN_V1 - Windows shuts down after results. Do not use Power Off.\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0guest-run.ps1"\n',encoding='ascii')
inputs={'stage':'cleanup','diskLabel':'QC_CLEAN_V1','productCommit':build['customCommit'],'exeSha256':build['exeSha256'],'qaNodeSha256':digest(node),'launcherSha256':digest(qa/'guest-run.ps1'),'qaCommit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),'qaNodeVersion':'22.23.5','files':[{'path':p.relative_to(payload).as_posix(),'sha256':digest(p)} for p in sorted(payload.rglob('*')) if p.is_file()]}
(qa/'QA-INPUTS.json').write_text(json.dumps(inputs,indent=2),encoding='utf-8')
image=win32com.client.Dispatch('IMAPI2FS.MsftFileSystemImage');image.FileSystemsToCreate=3;image.VolumeName='QC_CLEAN_V1';image.Root.AddTree(str(qa),False)
stream=image.CreateResultImage().ImageStream
stream=stream._oleobj_.QueryInterface(pythoncom.IID_IStream) if hasattr(stream,'_oleobj_') else stream.QueryInterface(pythoncom.IID_IStream)
with iso.open('wb') as target:
 while block:=stream.Read(1048576):target.write(block)
result={'iso':str(iso),'diskLabel':'QC_CLEAN_V1','bytes':iso.stat().st_size,'sha256':digest(iso),'productCommit':build['customCommit']}
(stage/'qa-iso-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))
