import http from 'node:http';
// Synthetic subscription; updates retain the same endpoint and identity.
const server=http.createServer((q,r)=>{r.end('socks5://127.0.0.1:33301#'+(q.url==='/second'?'Second%20server':'Subscription%20server'));});
server.listen(34610,'127.0.0.1',()=>process.send?.({ready:true}));
process.on('disconnect',()=>{server.closeAllConnections();server.close();process.exit(0)});
