// Synthetic loopback HTTP only. Never read user subscriptions or device data.
import http from 'node:http';
const id='11111111-2222-4333-8444-555555555555';
const ordinary=`vless://${id}@vpn.example:443?security=tls&sni=sni.example&type=ws&host=cdn.example&path=%2Fsocket#Fixture`;
const stub=`vless://${id}@0.0.0.1:443#Use%20Happ%20unsupported%20client`;
const xray=JSON.stringify([{remarks:'Fixture',outbounds:[{protocol:'vless',settings:{vnext:[{address:'vpn.example',port:443,users:[{id,encryption:'none'}]}]},streamSettings:{network:'ws',security:'tls',tlsSettings:{serverName:'sni.example'},wsSettings:{path:'/socket',headers:{Host:'cdn.example'}}}},{protocol:'freedom'}]}]);
const clash=`proxies:\n  - name: Fixture\n    type: vless\n    server: vpn.example\n    port: 443\n    uuid: ${id}\n    tls: true\n    servername: sni.example\n    network: ws\n    ws-opts:\n      path: /socket\n      headers:\n        Host: cdn.example\n`;
const singbox=JSON.stringify({outbounds:[{type:'vless',tag:'Fixture',server:'vpn.example',server_port:443,uuid:id,tls:{enabled:true,server_name:'sni.example'},transport:{type:'ws',path:'/socket',headers:{Host:'cdn.example'}}}]});
let failRefresh=false;
const requests=[];
const server=http.createServer((q,r)=>{
  const path=q.url.split('?')[0],ua=q.headers['user-agent']??'';
  if(path==='/control/fail'){failRefresh=true;r.end('ok');return;}
  if(path==='/stats'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify(requests));return;}
  // Record only synthetic requests, never arbitrary auth headers or full URLs.
  requests.push({path,ua,accept:q.headers.accept,device:q.headers['x-hwid']??null});
  if(path==='/permission'){r.writeHead(403);r.end('not permitted');return;}
  if(path==='/rate'){r.writeHead(429,{'Retry-After':'90'});r.end('wait');return;}
  if(path==='/device'&&!q.headers['x-hwid']){r.setHeader('x-hwid-not-supported','true');r.end(stub);return;}
  if(path==='/all-fail'||path==='/refresh'&&failRefresh){r.end(stub);return;}
  if(path==='/happ'||path==='/refresh'){r.end(ua.startsWith('Happ/')?ordinary:stub);return;}
  if(path==='/formats'){
    if(ua.startsWith('Happ/')){r.setHeader('Content-Type','application/json');r.end(xray);}
    else if(ua.startsWith('mihomo/')){r.end(clash);}
    else if(ua.startsWith('sing-box/')){r.setHeader('Content-Type','application/json');r.end(singbox);}
    else r.end(ordinary);
    return;
  }
  r.end(ordinary);
});
server.listen(34567,'127.0.0.1',()=>process.send?.({ready:true}));
process.on('disconnect',()=>{server.closeAllConnections();server.close();process.exit(0)});
