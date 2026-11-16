import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
export async function services(){
  const observed=[];const sockets=new Set();
  const http4=http.createServer((q,r)=>{r.end('SATELITE-VM-LOOPBACK '+q.url);});await new Promise(r=>http4.listen(32192,'127.0.0.1',r));
  const socks=net.createServer(s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));let stage=0,b=Buffer.alloc(0),remote;
    s.on('data',function data(chunk){b=Buffer.concat([b,chunk]);
      if(stage===0){if(b.length<2||b.length<2+b[1])return;b=b.subarray(2+b[1]);s.write(Buffer.from([5,0]));stage=1;}
      if(stage===1){if(b.length<5)return;let n=b[3]===1?10:b[3]===4?22:7+b[4];if(b.length<n)return;const port=b.readUInt16BE(n-2);observed.push({atyp:b[3],port});if(b[1]!==1||port!==32192){s.end(Buffer.from([5,5,0,1,0,0,0,0,0,0]));return;}const payload=b.subarray(n);s.removeListener('data',data);stage=2;remote=net.connect(32192,'127.0.0.1',()=>{s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(payload.length)remote.write(payload);s.pipe(remote);remote.pipe(s);});remote.on('error',()=>s.destroy());s.on('close',()=>remote?.destroy());}
    });
  });await new Promise(r=>socks.listen(32191,'127.0.0.1',r));
  const dns=dgram.createSocket('udp4');let dnsQueries=0;dns.on('message',(q,peer)=>{dnsQueries++;let i=12;while(q[i]!==0&&i<q.length)i+=q[i]+1;i+=5;const head=Buffer.from(q.subarray(0,i));head.writeUInt16BE(0x8180,2);head.writeUInt16BE(1,6);const answer=Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,30,0,4,127,0,0,1]);dns.send(Buffer.concat([head,answer]),peer.port,peer.address);});await new Promise(r=>dns.bind(53535,'127.0.0.1',r));
  return {observed,get dnsQueries(){return dnsQueries;},close(){for(const s of sockets)s.destroy();http4.close();socks.close();dns.close();}};
}
export function requestProxy(host='fixture.test',path='/proxy'){
  return new Promise((resolve,reject)=>{let text='';const s=net.connect(32189,'127.0.0.1',()=>s.write(`GET http://${host}:32192${path} HTTP/1.1\r\nHost: ${host}:32192\r\nConnection: close\r\n\r\n`));s.setTimeout(8000,()=>s.destroy(Error('proxy timeout')));s.on('data',b=>text+=b);s.on('error',reject);s.on('end',()=>resolve(text));});
}
