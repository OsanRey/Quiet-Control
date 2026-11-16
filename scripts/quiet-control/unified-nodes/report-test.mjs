import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const code=fs.readFileSync(new URL('./acceptance.mjs',import.meta.url),'utf8');
const source=code.slice(code.indexOf('const save='),code.indexOf('const phase='))+'save();';
for(const permanent of [false,true]){
 const files=new Map([['/qa/Results/unified-nodes.json','previous complete report']]);let attempts=0;
 const io={writeFileSync:(path,value)=>files.set(path,value),renameSync:(from,to)=>{
  attempts++;if(permanent||attempts<3)throw Object.assign(Error('Synthetic sharing violation'),{code:'EPERM'});
  files.set(to,files.get(from));files.delete(from);
 }};
 const context={fs:io,out:'/qa/Results',report:{phase:'checked'},Atomics:{wait:()=>{}},Int32Array,SharedArrayBuffer,console:{error:()=>{}}};
 if(permanent){assert.throws(()=>vm.runInNewContext(source,context),/Synthetic sharing/);assert.equal(files.get('/qa/Results/unified-nodes.json'),'previous complete report');assert.equal(attempts,6)}
 else{vm.runInNewContext(source,context);assert.equal(JSON.parse(files.get('/qa/Results/unified-nodes.json')).phase,'checked');assert.equal(attempts,3)}
}
console.log('Passed: transient sharing violation retries; permanent failure preserves prior report.');
