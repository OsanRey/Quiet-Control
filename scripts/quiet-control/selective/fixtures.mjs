// Loopback-only endpoints in their own process: CDP, process creation and report
// writes in the orchestrator must not suspend the servers being measured.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
const logPath=process.argv[2];
const log=event=>fs.appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),...event})+'\n');
const servers=[],sockets=new Set();
const track=s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',e=>log({event:'socket_error',error:e.message}));return s};
async function listen(server,port){servers.push(server);await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r)})}
function endpoint(marker){return http.createServer((q,r)=>{q.resume();q.on('end',()=>{log({event:'http',marker,url:q.url,host:q.headers.host});r.writeHead(200,{'Content-Length':1048576});r.write(marker+'\n');const timer=setInterval(()=>r.write(Buffer.alloc(1024,120)),250);r.on('close',()=>clearInterval(timer))})})}
await listen(endpoint('DIRECT'),33300);
await listen(endpoint('VPN'),33305);
await listen(net.createServer(socket=>{
 const s=track(socket);let stage=0,b=Buffer.alloc(0);
 const receive=chunk=>{
  b=Buffer.concat([b,chunk]);
  if(stage===0){if(b.length<2||b.length<2+b[1])return;b=b.subarray(2+b[1]);s.write(Buffer.from([5,0]));stage=1}
  if(stage!==1||b.length<5)return;
  const length=b[3]===1?10:b[3]===4?22:b[3]===3?7+b[4]:0;
  if(!length){s.destroy();return}if(b.length<length)return;
  const host=b[3]===1?[...b.subarray(4,8)].join('.'):b[3]===3?b.subarray(5,5+b[4]).toString():'';
  const port=b.readUInt16BE(length-2);log({event:'socks',host,port});
  // Background Windows DNS/telemetry is outside the controlled fixture.
  if(!((port===33300&&['127.0.0.1','www.google.com','203.0.113.10'].includes(host))||(port===80&&host==='1.1.1.1'))){s.end(Buffer.from([5,5,0,1,127,0,0,1,0,0]));return}
  b=b.subarray(length);stage=2;s.pause();s.removeListener('data',receive);
  const u=track(net.connect(33305,'127.0.0.1'));u.on('error',()=>s.destroy());s.on('close',()=>u.destroy());u.on('close',()=>s.destroy());
  u.on('connect',()=>{s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(b.length)u.write(b);s.pipe(u);u.pipe(s);s.resume()});
 };s.on('data',receive);
}),33301);
log({event:'ready'});process.send?.({ready:true});
process.on('disconnect',()=>{for(const s of sockets)s.destroy();for(const s of servers)s.close();process.exit(0)});
