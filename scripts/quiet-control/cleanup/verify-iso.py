"""Read Joliet directly, without mounting, and hash every declared QA payload."""
import hashlib
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
output = Path(sys.argv[2])
with path.open('rb') as disk:
    def read(offset, size):
        disk.seek(offset)
        data = disk.read(size)
        if len(data) != size:
            raise ValueError('Truncated ISO')
        return data
    descriptor = None
    for sector in range(16, 64):
        value = read(sector * 2048, 2048)
        if value[1:6] != b'CD001':
            raise ValueError('Not ISO9660')
        if value[0] == 2 and value[88:91] in (b'%/@', b'%/C', b'%/E'):
            descriptor = value
            break
        if value[0] == 255:
            break
    if descriptor is None:
        raise ValueError('No Joliet descriptor')
    entries = {}
    def walk(record, parent=''):
        extent = int.from_bytes(record[2:6], 'little') * 2048
        size = int.from_bytes(record[10:14], 'little')
        data = read(extent, size)
        pos = 0
        while pos < size:
            length = data[pos]
            if not length:
                pos = (pos // 2048 + 1) * 2048
                continue
            item = data[pos:pos+length]
            pos += length
            name = item[33:33+item[32]]
            if name in (b'\x00', b'\x01'):
                continue
            name = name.decode('utf-16-be').removesuffix(';1')
            key = (parent + '/' + name).lstrip('/')
            if item[25] & 2:
                walk(item, key)
            else:
                entries[key.casefold()] = (int.from_bytes(item[2:6], 'little')*2048, int.from_bytes(item[10:14], 'little'))
    walk(descriptor[156:156+descriptor[156]])
    manifest = json.loads(read(*entries['qa-inputs.json']))
    verified=[]
    if manifest['diskLabel']!='QC_CLEAN_V3':raise ValueError('Wrong QA label')
    for item in manifest['files']:
        offset,left=entries[('payload/'+item['path']).casefold()];digest=hashlib.sha256()
        while left:
            block=read(offset,min(left,1048576));digest.update(block);offset+=len(block);left-=len(block)
        if digest.hexdigest()!=item['sha256']:raise ValueError('Payload mismatch: '+item['path'])
        verified.append(item['path'])
    if hashlib.sha256(read(*entries['guest-run.ps1'])).hexdigest()!=manifest['launcherSha256']:raise ValueError('Launcher mismatch')
    if manifest['qaNodeSha256']!='247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a':raise ValueError('Unexpected Node pin')
    if b'QC_CLEAN_V3' not in read(*entries['start-qa.cmd']):raise ValueError('Wrong launcher')
    result={'diskLabel':manifest['diskLabel'],'productCommit':manifest['productCommit'],'allPayloadHashesVerified':True,'readOnlyNoMount':True,'files':verified}
    output.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))
