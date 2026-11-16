import {createHash} from 'node:crypto';
// Guest-only native Tauri commands, synthetic HTTP and unchanged core lifecycle.
import fs from 'node:fs';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,wait} from '../cdp.mjs';
const qa=process.env.QC_QA_ROOT;
if(!qa||!fs.existsSync(qa+'/qa-guest.marker'))throw Error('Marked VMware QA root required');
const out=qa+'/Results',root=qa+'/SubscriptionAcceptance',exec=promisify(execFile),children=[];
const report={stage:'subscription-compat',qaVersion:'QC_SUB_V3',checks:[],errors:[],screenshots:[],evidence_files:[],applicationRoot:root};
let app,c;
const save=()=>fs.writeFileSync(out+'/subscription.json',JSON.stringify(report,null,2));
const phase=name=>{report.phase=name;save();console.log(name)};
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});save()};
const ps=async code=>JSON.parse((await exec('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new();'+code+' | ConvertTo-Json -Depth 8 -Compress'],{timeout:30000})).stdout.trim()||'null');
const snapshot=()=>ps("[ordered]@{routes=@(Get-NetRoute | Sort-Object InterfaceIndex,DestinationPrefix,NextHop | Select-Object InterfaceIndex,DestinationPrefix,NextHop);dns=@(Get-DnsClientServerAddress | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses)}");
const http=client=>({client,send_device_id:false});
async function fixture(file,args=[]){const child=spawn(process.execPath,[file,...args],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});children.push(child);let error='';child.stderr.on('data',b=>error+=b);await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('Fixture timeout '+error)),10000);child.once('message',m=>{clearTimeout(t);m.ready?r():j(Error('Fixture failure'))});child.once('exit',n=>{clearTimeout(t);j(Error('Fixture exited '+n+' '+error))})});}
async function launch(){
 app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore',windowsHide:true});
 const launched=app;const attempt={pid:app.pid,at:new Date().toISOString()};(report.launches??=[]).push(attempt);save();
 launched.once('exit',(code,signal)=>{attempt.exitCode=code;attempt.signal=signal;save()});
 try{c=await connect();await c.call('Page.enable');await wait(700);attempt.connected=true;save()}
 catch(error){attempt.connected=false;attempt.processes=await ps("@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -like '"+root.replaceAll('/','\\')+"*' -or $_.CommandLine -like '*"+root.replaceAll('/','\\')+"*'} | Select-Object ProcessId,ParentProcessId,Name,CommandLine)");save();throw error;}
}
async function close(force=false){
 if(app?.pid&&app.exitCode===null){
  const current=app;
  if(c&&!force){
   await c.invoke('update_settings',{closeToTray:false});
   const sent=await ps('[Diagnostics.Process]::GetProcessById('+current.pid+').CloseMainWindow()');
   check('normal_window_close_requested',sent);
   for(let i=0;i<80&&current.exitCode===null;i++)await wait(100);
  }
  if(!force&&current.exitCode!==null)check('normal_process_exit',current.exitCode===0,{exitCode:current.exitCode});
  if(current.exitCode===null){
   if(!force)throw Error('Normal guest application exit timed out');
   execFileSync('taskkill.exe',['/F','/T','/PID',String(current.pid)],{stdio:'ignore'});
  }
 }
 c?.ws.close();app=null;c=null;await wait(1500);
}
async function cleanup(){try{await c?.invoke('stop_proxy');await c?.invoke('set_capture_mode',{mode:'off'})}catch{}await close(true);for(const child of children)if(child.exitCode===null)child.kill();}
const watchdog=setTimeout(()=>{report.errors.push('Watchdog exceeded 6 minutes');phase('timed_out');void cleanup().finally(()=>process.exit(2))},360000);
async function preview(path,options=http('auto')){return c.invoke('check_subscription',{url:'http://127.0.0.1:34567/'+path,viaProxy:false,userAgent:null,http:options})}
async function fill(selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(150)}
async function click(selector,text){const ok=await c.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>(e.querySelector('.glass-btn-label')??e).textContent.trim()===${JSON.stringify(text)});e?.click();return !!e})()`);if(!ok)throw Error('Missing action '+text);await wait(250)}
async function shot(name){await wait(250);fs.writeFileSync(out+'/'+name+'.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));report.screenshots.push(name+'.png');save()}
try{
 phase('prepare');if(!(await ps('(Get-CimInstance Win32_ComputerSystem).Model')).includes('VMware'))throw Error('VMware required');
 if(execFileSync('tasklist.exe',['/FI','IMAGENAME eq satelite-proxy.exe','/FO','CSV','/NH'],{encoding:'utf8'}).includes('satelite-proxy.exe'))throw Error('Close other Satelite guest instances first');
 fs.mkdirSync(root,{recursive:true});report.baselineNetwork=await snapshot();
 await exec('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${qa}/Distribution/Satelite-Quiet-Control-subscription-compat-win-x64-portable.zip' -DestinationPath '${qa}/Extract' -Force; Copy-Item -Path '${qa}/Extract/Satelite-Research/*' -Destination '${root}' -Recurse -Force`],{timeout:120000});
 execFileSync(process.env.WINDIR+'/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:exe','/reference:System.Web.Extensions.dll','/out:'+(root+'/Probe.exe').replaceAll('/','\\'),(qa+'/Scripts/subscription-compat/ProcessProbe.cs').replaceAll('/','\\')],{timeout:30000});
 await fixture(qa+'/Scripts/subscription-compat/fixtures.mjs');await fixture(qa+'/Scripts/routing-usability/fixtures.mjs',[out+'/subscription-network-fixtures.jsonl']);report.evidence_files.push('subscription-network-fixtures.jsonl');
 await launch();await c.invoke('update_settings',{locale:'ru',quietTheme:'dark',mixedPort:32189,apiPort:32190});
 phase('negotiation');let r=await preview('normal');check('ordinary_subscription',r.usable&&r.attempts.length===1,r);
 r=await preview('happ');check('automatic_stub_then_happ',r.usable&&r.attempts[0].result==='placeholder'&&r.successful_client==='happ',r);
 for(const mode of ['happ','mihomo','singbox']){r=await preview('formats',http(mode));check(mode+'_format',r.usable,r);}
 r=await preview('device');check('no_automatic_device_identity',!r.usable&&r.attempts.length===1&&r.attempts[0].result==='device_required',r);
 const identity={...http('happ'),send_device_id:true,device_id:'abcdefab-1234-4567-89ab-abcdefabcdef'};
 r=await preview('device',identity);check('explicit_local_device_identity',r.usable,r);
 r=await preview('all-fail');check('bounded_all_fail',!r.usable&&r.attempts.length===5,r);
 r=await preview('permission');check('authorization_terminal',!r.usable&&r.attempts.length===1&&r.attempts[0].result==='permission_denied',r);
 r=await preview('rate');check('retry_after_reported',r.retry_after_seconds===90,r);r=await preview('rate');check('retry_after_embargo',r.attempts[0].result==='retry_after',r);
 const added=await c.invoke('add_subscription_url',{name:'Synthetic subscription',url:'http://127.0.0.1:34567/refresh',viaProxy:false,userAgent:null,http:http('auto')});
 const subId=added.subscription.id;const nodes=await c.invoke('list_subscription_nodes',{id:subId});
 check('payload_server_and_protocol',nodes.length===1&&nodes[0].server==='vpn.example'&&nodes[0].protocol==='vless',nodes.map(n=>({protocol:n.protocol,server:n.server,port:n.port})));
 const deviceSub=await c.invoke('add_subscription_url',{name:'Device fixture',url:'http://127.0.0.1:34567/device',viaProxy:false,userAgent:null,http:identity});
 const detail=await c.invoke('get_subscription',{id:subId});check('successful_mode_remembered',detail.http.last_success==='happ',detail.http);
 phase('previous_native_evidence');
 const previousBytes=fs.readFileSync(qa+'/Scripts/subscription-compat/previous-report.json');
 const previous=JSON.parse(previousBytes);
 report.previousNative={sha256:createHash('sha256').update(previousBytes).digest('hex'),qaVersion:previous.qaVersion,completedAt:previous.completedAt,checks:previous.checks,errors:previous.errors};
 check('retained_native_tun_and_restoration_evidence',previous.qaVersion==='QC_SUB_V2'&&['real_tun_started','real_tun_transfer_before','real_tun_transfer_after','real_core_pid_unchanged','active_routes_and_dns_unchanged','cached_store_unchanged','routes_restored','dns_restored'].every(name=>previous.checks.some(c=>c.name===name&&c.passed)));
 phase('native_form');for(const theme of ['dark','light']){
   await c.invoke('update_settings',{quietTheme:theme});await c.call('Page.reload');await wait(850);await c.evaluate("document.querySelectorAll('.nav-items button')[1].click()");await wait(700);
   await click('button','Добавить профиль');await fill('input[type=url]','http://127.0.0.1:34567/happ');
   await click('.subscription-compat>button','Проверить подписку');
   for(let i=0;i<70;i++){if(await c.evaluate("!!document.querySelector('[data-testid=subscription-check-result]')"))break;await wait(150)}
   check(theme+'_actual_check_ui',await c.evaluate("document.querySelector('[data-testid=subscription-check-result]')?.textContent.includes('Подписка проверена')"));
   check(theme+'_actual_theme',await c.evaluate('document.documentElement.dataset.qcTheme')===theme);
   await shot('subscription-'+theme+'-check');
   await click('.subscription-http summary', 'Дополнительные настройки HTTP');await c.evaluate("document.querySelector('.subscription-http').scrollIntoView({block:'center'})");await shot('subscription-'+theme+'-advanced');
   await click('.modal-actions button, .modal-footer button, .modal button','Отмена');
 }
 phase('normal_restart'); await close();await launch();const savedIdentity=(await c.invoke('get_subscription',{id:deviceSub.subscription.id})).http;check('identity_settings_survive_restart',savedIdentity.client===identity.client&&savedIdentity.device_id===identity.device_id&&savedIdentity.send_device_id);
 check('successful_mode_survives_restart',(await c.invoke('get_subscription',{id:subId})).http.last_success==='happ');

}catch(e){report.errors.push(String(e.stack??e));
 try{if(c){report.failureUi=await c.evaluate("({theme:document.documentElement.dataset.qcTheme,buttons:[...document.querySelectorAll('button')].map(e=>({label:(e.querySelector('.glass-btn-label')??e).textContent.trim(),disabled:e.disabled})),headings:[...document.querySelectorAll('h1,h2')].map(e=>e.textContent)})");await shot('subscription-failure-ui')}}catch(error){report.diagnosticError=String(error)}save()}

finally{phase('cleanup');await cleanup();for(const name of fs.existsSync(root+'/logs')?fs.readdirSync(root+'/logs'):[]){if(name.endsWith('.log')){const dest='subscription-'+name;fs.copyFileSync(root+'/logs/'+name,out+'/'+dest);report.evidence_files.push(dest)}}report.completedAt=new Date().toISOString();phase('completed');clearTimeout(watchdog)}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
