// Only loopback mock servers; no VPN core or OS trust-store changes.
import fs from 'node:fs';import net from 'node:net';import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import {X509Certificate} from 'node:crypto';import {once} from 'node:events';import assert from 'node:assert/strict';
const qa=process.argv[2],servers=[],sockets=new Set();
const source=fs.readFileSync(new URL('./acceptance.mjs',import.meta.url),'utf8');
const listen=async(s,port)=>{servers.push(s);await new Promise((r,j)=>{s.once('error',j);s.listen(port,'127.0.0.1',r)})};
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
const a=await freePort(),b=await freePort();
let code=source.slice(source.indexOf('async function relay(port)'),source.indexOf('const watchdog='));code=code.replaceAll('33300',String(a)).replaceAll('33304',String(b));
const fixture=new Function('fs','net','http','https','qa','servers','sockets','listen',code+';return {relay,fixtureServers}')(fs,net,http,https,qa,servers,sockets,listen);
const result={checks:[],trustStoreChanged:false,realCoresStarted:false};
const check=name=>result.checks.push(name);
try{
 const cert=new X509Certificate(fs.readFileSync(qa+'/fixture.cer'));assert.equal(cert.checkIP('203.0.113.10'),'203.0.113.10');check('IP SAN matches the actual probe URL');
 await fixture.fixtureServers();await fixture.relay(0);const port=servers.at(-1).address().port;
 for(const method of ['HEAD','GET']){
  const s=net.connect(port,'127.0.0.1');await once(s,'connect');let received=once(s,'data');s.write(Buffer.from([5,1,0]));assert.deepEqual((await received)[0],Buffer.from([5,0]));
  received=once(s,'data');const request=Buffer.from([5,1,0,1,203,0,113,10,b>>8,b&255]);s.write(request);assert.equal((await received)[0][1],0);
  const secure=tls.connect({socket:s,ca:cert.toString(),servername:'localhost'});await once(secure,'secureConnect');assert(secure.authorized);
  received=once(secure,'data');secure.write(`${method} /health HTTP/1.1\r\nHost: 203.0.113.10\r\nConnection: close\r\n\r\n`);const response=(await received)[0].toString();assert(response.startsWith('HTTP/1.1 200'));if(method==='HEAD')assert(!response.endsWith('OK'));secure.destroy();check(method+' over real TLS through the SOCKS fixture');
 }
 fs.writeFileSync(qa+'/preflight.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{for(const s of sockets)s.destroy();for(const s of servers)s.close();for(const name of ['fixture.pfx','fixture.cer'])fs.rmSync(qa+'/'+name,{force:true})}
