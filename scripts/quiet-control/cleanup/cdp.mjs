export const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect({port=9222,timeoutMs=90000,onProgress=()=>{}}={}){
  let target;
  const deadline=Date.now()+timeoutMs;
  for(let i=0;Date.now()<deadline;i++){onProgress({phase:'target_discovery',attempt:i+1});try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json()).find(p=>p.type==='page');if(target)break;}catch{}await wait(250);}
  if(!target)throw Error('No CDP page');
  onProgress({phase:'target_found'});
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{const timer=setTimeout(()=>{try{ws.close()}catch{}j(Error('CDP WebSocket open timeout'))},10000);ws.onopen=()=>{clearTimeout(timer);r()};ws.onerror=e=>{clearTimeout(timer);j(e)};});
  onProgress({phase:'websocket_open'});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p?.timer);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}};
  const call=(method,params={},timeoutMs=25000)=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},timeoutMs);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async (expression,timeoutMs)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},timeoutMs);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  ws.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('CDP socket closed'))}pending.clear()};
  let ready=false;
  for(let i=0;i<50;i++){
    try{ready=await evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)');if(ready)break;}catch{}
    await wait(100);
  }
  if(!ready)throw Error('Tauri IPC did not become ready');
  onProgress({phase:'tauri_ready'});
  return {ws,call,evaluate,invoke:(cmd,args={})=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})`)};
}
