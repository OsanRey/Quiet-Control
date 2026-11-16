"""Package reviewed offline inputs with a built executable; no downloads or OS changes."""
import argparse, hashlib, json, subprocess, zipfile
from pathlib import Path

p=argparse.ArgumentParser()
p.add_argument('--inputs',required=True);p.add_argument('--exe',required=True);p.add_argument('--out',required=True)
p.add_argument('--edition',choices=['runtime0.5','quiet-control-stage1','quiet-control-stage1.1','quiet-control-stage2','quiet-control-capture','quiet-control-stage3','quiet-control-stage3-tun-audit','quiet-control-stage4','quiet-control-stage4.2','quiet-control-stage4.3','quiet-control-selective','quiet-control-routing-usability','quiet-control-subscription-compat','quiet-control-unified-nodes'],default='runtime0.5')
a=p.parse_args();inputs=Path(a.inputs).resolve();exe=Path(a.exe).resolve();out=Path(a.out).resolve()
repo=Path(__file__).resolve().parents[1]
lock=json.loads((repo/'scripts/portable-inputs.lock.json').read_text(encoding='utf-8'))
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
files={}
for entry in lock['files']:
    file=inputs/entry['path']
    if digest(file)!=entry['sha256']:raise SystemExit('Input integrity failure: '+entry['path'])
    files[entry['path']]=file
if a.edition in ('quiet-control-selective','quiet-control-routing-usability','quiet-control-subscription-compat','quiet-control-unified-nodes'):
    retired={'system-geolocation-not-cn.srs','system-geoip-cn.srs','system-geosite-cn.srs'}
    files={name:path for name,path in files.items() if Path(name).name not in retired}
if not exe.is_file():raise SystemExit('Built executable missing')
files['satelite-proxy.exe']=exe
out.mkdir(parents=True,exist_ok=True)
commit=subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip()
extra={
 'portable.flag':b'Satelite Research portable mode\n',
 'LICENSE':(repo/'LICENSE').read_bytes(),
 'README.txt':(('Satelite Research 1.0.46 / '+a.edition+' - Windows 11 x64\n')+
    'Extract the entire folder into a user-writable location; run satelite-proxy.exe.\n'
    'Bundled: sing-box 1.13.18, Xray 26.3.27, Mihomo 1.19.30, Wintun 0.14.1,\n'
    'app-local Microsoft VC runtime and app-managed WebView2 157.0.4341.46.\n'
    'No host installation or startup/URI registration is performed automatically.\n'
    'TUN requires explicit activation and administrator consent.\n'
    'Keep portable.flag. Data, profiles, logs and webview cache stay beside the exe.\n'
    'Core updates fail closed unless their hashes are reviewed in the source manifest.\n'
    'This is an unsigned research debug build. No public redistribution was performed.\n'
    'CDP test access is disabled by default; do not enable SATELITE_TEST_CDP_PORT in normal use.\n'
    'Quiet Control: Dark, Light and System themes; existing sections remain accessible.\n'
    'No user profiles or acceptance-test fixtures are included in the distribution.\n'
    'See docs/runtime and docs/quiet-control in the source for validation and limitations.\n').encode(),
 'THIRD-PARTY-NOTICES.txt':(repo/'scripts/research-third-party-notices.txt').read_bytes(),
 'BUILD-INFO.json':json.dumps({'upstream':'1b33c42f5a61fdadfdb23e7298be406ecf5c0707','runtimeBaseline':'27ed9048bce12d66f300944df254bb7ecf22be24','customCommit':commit,'edition':a.edition,'profile':'dev + tauri/custom-protocol','platform':'windows-x64','inputLockSha256':digest(repo/'scripts/portable-inputs.lock.json'),'runtimeSource':'local Microsoft-signed WebView2 installation snapshot; not an official Fixed Version CAB'},indent=2).encode(),
}
for path in (repo/'scripts/research-licenses').glob('*'):files['licenses/'+path.name]=path
entries=[{'path':name,'sha256':digest(path),'bytes':path.stat().st_size} for name,path in sorted(files.items())]
entries += [{'path':n,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)} for n,b in sorted(extra.items())]
manifest=json.dumps({'files':sorted(entries,key=lambda e:e['path'])},indent=2).encode()
extra['MANIFEST-SHA256.json']=manifest
archive=out/'Satelite-Research-1.0.46-runtime0.5-win-x64-portable.zip'
if a.edition.startswith('quiet-control-'):archive=out/('Satelite-Quiet-Control-'+a.edition.removeprefix('quiet-control-')+'-win-x64-portable.zip')
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
    for name in sorted(set(files)|set(extra)):
        info=zipfile.ZipInfo('Satelite-Research/'+name,(2026,11,12,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
        with z.open(info,'w',force_zip64=True) as dst:
            if name in extra:dst.write(extra[name])
            else:
                with files[name].open('rb') as src:
                    for b in iter(lambda:src.read(1024*1024),b''):dst.write(b)
# Independently hash every decompressed payload, including dependency files.
with zipfile.ZipFile(archive) as z:
    for entry in entries:
        h=hashlib.sha256()
        with z.open('Satelite-Research/'+entry['path']) as f:
            for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
        if h.hexdigest()!=entry['sha256']:raise SystemExit('Archive verification failed: '+entry['path'])
result={'archive':str(archive),'sha256':digest(archive),'bytes':archive.stat().st_size,'files':len(entries)+1,'exeSha256':digest(exe),'allPayloadHashesVerified':True,'customCommit':commit}
(out/'portable-result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
