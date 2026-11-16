export const wait=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect(){
  let target;
  for(let i=0;i<40;i++){try{target=(await(await fetch('http://127.0.0.1:9222/json/list')).json()).find(p=>p.type==='page');if(target)break;}catch{}await wait(500);}
  if(!target)throw Error('No CDP page');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p?.timer);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}};
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method));},25000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  let ready=false;
  for(let i=0;i<50;i++){
    try{ready=await evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)');if(ready)break;}catch{}
    await wait(100);
  }
  if(!ready)throw Error('Tauri IPC did not become ready');
  return {ws,call,evaluate,invoke:(cmd,args={})=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})`)};
}
