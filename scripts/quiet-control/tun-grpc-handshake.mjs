// Guest-only: record the protocol stage without exposing the endpoint or credentials.
import fs from 'node:fs';import http2 from 'node:http2';import net from 'node:net';
if(!fs.existsSync('C:/UserSource/portable.flag'))throw Error('Guest mount required');
const store=JSON.parse(fs.readFileSync('C:/UserSnapshot/data/store.json'));
const node=store.nodes.find(n=>n.id===store.settings.current_node_id),report={runs:[]};
for(const method of ['Tun','TunMulti']){
 const run={method};report.runs.push(run);
 await new Promise(resolve=>{
  const client=http2.connect(`http://${node.server}:${node.port}`);const timer=setTimeout(done,8000);
  function done(){clearTimeout(timer);client.destroy();resolve();}
  client.on('connect',()=>run.tcpConnected=true);
  client.on('remoteSettings',()=>run.remoteHttp2Settings=true);
  client.on('goaway',(code,last,buf)=>{run.goaway={code,lastStreamId:last,debugBytes:buf?.length??0};done();});
  client.on('error',e=>{run.sessionError=e.code;done();});
  const request=client.request({':method':'POST',':path':`/${node.transport.service_name}/${method}`,'content-type':'application/grpc','te':'trailers'});
  request.on('response',h=>run.response={status:h[':status'],contentType:h['content-type'],grpcStatus:h['grpc-status']});
  request.on('trailers',h=>run.grpcStatus=h['grpc-status']);
  request.on('data',b=>run.responseBytes=(run.responseBytes??0)+b.length);
  request.on('end',()=>{run.streamEnded=true;run.rstCode=request.rstCode;setTimeout(done,100);});
  request.on('close',()=>{run.streamClosed=true;run.rstCode=request.rstCode;});
  request.on('error',e=>{run.streamError=e.code;done();});request.end();
 });
}
report.http1=await new Promise(resolve=>{let text='';const s=net.connect(node.port,node.server,()=>s.write(`GET / HTTP/1.1\r\nHost: ${node.server}\r\nConnection: close\r\n\r\n`));s.setTimeout(5000);s.on('data',b=>text+=b);s.on('end',()=>resolve({responseBytes:text.length,status:/^HTTP\/1\.[01] \d{3}/.exec(text)?.[0]??null}));s.on('timeout',()=>{s.destroy();resolve({timeout:true,responseBytes:text.length});});s.on('error',e=>resolve({error:e.code}));});
fs.writeFileSync('C:/Results/grpc-handshake.json',JSON.stringify(report,null,2));
