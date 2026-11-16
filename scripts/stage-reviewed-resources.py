"""Stage only hash-reviewed resource inputs for a full Windows build.
No downloads, execution, runtime data, system settings, or trust bypass.
"""
import argparse,hashlib,json,shutil
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument('--inputs',type=Path,required=True)
args=parser.parse_args()
repo=Path(__file__).resolve().parents[1];inputs=args.inputs.resolve()
lock=json.loads((repo/'scripts/portable-inputs.lock.json').read_text(encoding='utf-8'))
trust=json.loads((repo/'src-tauri/src/core/trusted-inputs.json').read_text(encoding='utf-8'))
retired={'system-geolocation-not-cn.srs','system-geoip-cn.srs','system-geosite-cn.srs'}
staged=[]
def digest(p):
    with p.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
# Validate the entire resource selection before copying any file.
for entry in lock['files']:
    relative=Path(entry['path'])
    if not entry['path'].startswith('resources/') or relative.name in retired:continue
    source=(inputs/relative).resolve();destination=(repo/'src-tauri'/relative).resolve()
    if not source.is_relative_to(inputs) or not destination.is_relative_to(repo/'src-tauri/resources'):raise SystemExit('Unsafe resource path')
    if not source.is_file() or digest(source)!=entry['sha256']:raise SystemExit('Resource integrity failure: '+entry['path'])
    if relative.name in trust['binaries'] and entry['sha256']!=trust['binaries'][relative.name]:raise SystemExit('Resource does not match runtime trust manifest')
    staged.append((source,destination,entry['sha256']))
for source,destination,sha in staged:
    destination.parent.mkdir(parents=True,exist_ok=True)
    if not destination.is_file() or digest(destination)!=sha:shutil.copy2(source,destination)
    if digest(destination)!=sha:raise SystemExit('Staged resource verification failed')
(repo/'src-tauri/resources/rule-sets').mkdir(parents=True,exist_ok=True)
print(json.dumps({'reviewedResources':len(staged),'trustedCoreHashesUnchanged':True,'executedBinaries':False,'downloadedFiles':False}))
