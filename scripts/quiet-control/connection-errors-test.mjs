import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const js=ts.transpileModule(fs.readFileSync('src/quiet-control/connectionErrors.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {recentConnectionError:parse}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const now=Date.parse('2026-11-13T18:00:30+03:00'),since=now-20000,id='1234567890123456abcd';
const prefix='+0300 2026-11-13 18:00:20 ERROR ';
const line=prefix+'connection: open connection to example.com:443 using outbound/vless[node-1234567890123456]: stream error: stream ID 1; NO_ERROR; received from peer';
const reset=prefix+'[2233273195 667ms] connection: connection upload closed: raw-read tcp4 172.19.0.1:58744->172.19.0.2:10085: An existing connection was forcibly closed by the remote host.';
const checks=[
 ['current gRPC transport failure',parse([line],since,now,id),line],
 ['ANSI log',parse(['\x1b[31m'+line+'\x1b[0m'],since,now,id),line],
 ['previous session',parse([line],now,now,id),null],
 ['expired error',parse([line],0,now+61000,id),null],
 ['other selected node',parse([line],since,now,'different-node'),null],
 ['warning level',parse([line.replace(' ERROR ',' WARN ')],since,now,id),null],
 ['future timestamp',parse([line],since,now-15000,id),null],
 ['actual screenshot TCP reset',parse([reset],since,now,id),null],
 ['tagged application reset',parse([prefix+'connection: connection download closed using outbound/vless[node-1234567890123456]: connection reset by peer'],since,now,id),null],
 ['unattributed stream error',parse([prefix+'connection: stream error: NO_ERROR'],since,now,id),null],
 ['per-domain DNS failure',parse([prefix+'dns: exchange failed for example.com: context deadline exceeded'],since,now,id),null],
 ['later reset does not hide transport failure',parse([line,reset],since,now,id),line],
 ['REALITY handshake retained',parse([line.replace(/stream error:.*/, 'reality verification failed')],since,now,id),line.replace(/stream error:.*/, 'reality verification failed')],
];
for(const [name,actual,expected] of checks)assert.equal(actual,expected,name);
console.log(JSON.stringify({checks:checks.length,passed:true},null,2));
