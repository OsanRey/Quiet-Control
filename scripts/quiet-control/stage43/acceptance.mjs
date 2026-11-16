// Guest-only native acceptance; synthetic servers serve real measured bytes.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {spawn,execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,wait} from '../cdp.mjs';
const qa=process.env.QC_QA_ROOT;
if(!qa||!fs.existsSync(qa+'/qa-guest.marker'))throw Error('Use the VMware guest launcher');
const out=qa+'/Results',root=qa+'/ProfileAcceptance',exec=promisify(execFile);
const report={stage:'4.3',qaVersion:'QC43_V3',checks:[],errors:[],screenshots:[],csp:[],fixtures:'Synthetic loopback SOCKS and HTTP; actual pinned cores',applicationRoot:root};
let app,c,subscriptionBody='',subscriptionCode=200;
const servers=[],sockets=new Set(),children=new Set();
const save=()=>fs.writeFileSync(out+'/stage43.json',JSON.stringify(report,null,2));
const phase=name=>{report.phase=name;report.updatedAt=new Date().toISOString();save();console.log(name)};
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});save()};
const ps=code=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new();'+code+' | ConvertTo-Json -Depth 6 -Compress'],{encoding:'utf8',timeout:20000}).trim()||'null');
const arr=x=>x==null?[]:Array.isArray(x)?x:[x];
const snapshot=()=>ps("[ordered]@{adapters=@(Get-NetAdapter -IncludeHidden | Sort-Object InterfaceIndex | Select-Object Name,InterfaceIndex,Status);routes=@(Get-NetRoute | Sort-Object InterfaceIndex,DestinationPrefix,NextHop | Select-Object InterfaceIndex,DestinationPrefix,NextHop);dns=@(Get-DnsClientServerAddress | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses)}");
const ownCorePids=()=>arr(ps("Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^(sing-box|mihomo|xray)\\.exe$'} | Select-Object ProcessId,ExecutablePath")).filter(p=>p.ExecutablePath?.toLowerCase().startsWith(root.replaceAll('/','\\').toLowerCase())).map(p=>p.ProcessId).sort();
async function listen(server,port){servers.push(server);await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r)})}
async function relay(port){
 await listen(net.createServer(s=>{
  sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});
  let stage=0,b=Buffer.alloc(0);
  const receive=chunk=>{
   b=Buffer.concat([b,chunk]);
   if(stage===0){if(b.length<2||b.length<2+b[1])return;b=b.subarray(2+b[1]);s.write(Buffer.from([5,0]));stage=1}
   if(stage!==1||b.length<5)return;
   const size=b[3]===1?10:b[3]===4?22:7+b[4];if(b.length<size)return;
   const destinationPort=b.readUInt16BE(size-2);b=b.subarray(size);stage=2;
   if(![33300,33304].includes(destinationPort)){s.end(Buffer.from([5,2,0,1,127,0,0,1,0,0]));return}
   s.pause();s.removeListener('data',receive);
   const upstream=net.connect(destinationPort,'127.0.0.1');sockets.add(upstream);upstream.on('close',()=>sockets.delete(upstream));
   upstream.on('error',()=>s.destroy());s.on('close',()=>upstream.destroy());
   upstream.once('connect',()=>{s.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));if(b.length)upstream.write(b);s.pipe(upstream);upstream.pipe(s)});
  };s.on('data',receive);
 }),port);
}
async function fixtureServers(){
 const handler=(q,r)=>{
  q.resume();q.on('end',()=>{
   if(new URL(q.url,'http://fixture').pathname!=='/burst'){setTimeout(()=>{r.writeHead(200,{'Content-Length':2});r.end(q.method==='HEAD'?undefined:'OK')},15);return}
   r.writeHead(200,{'Content-Length':46*1024*1024});let left=46;
   const timer=setInterval(()=>{r.write(Buffer.alloc(1024*1024,120));if(!--left){clearInterval(timer);r.end()}},80);r.on('close',()=>clearInterval(timer));
  });
 };
 await listen(http.createServer(handler),33300);
 await listen(https.createServer({pfx:fs.readFileSync(qa+'/fixture.pfx'),passphrase:'qc43-fixture'},handler),33304);
}
const watchdog=setTimeout(()=>{report.errors.push('Acceptance exceeded 7 minutes');phase('timed_out');void cleanup().finally(()=>process.exit(124))},420000);
process.on('exit',code=>{report.processExitCode=code;save()});
async function launch(){app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore',windowsHide:true});c=await connect();await c.call('Runtime.enable');await c.call('Page.enable');await c.call('Runtime.addBinding',{name:'__qcCsp'});c.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.bindingCalled'&&m.params.name==='__qcCsp')report.csp.push(JSON.parse(m.params.payload))});await c.call('Page.addScriptToEvaluateOnNewDocument',{source:"document.addEventListener('securitypolicyviolation',e=>window.__qcCsp(JSON.stringify({directive:e.violatedDirective,uri:e.blockedURI})))"});await wait(800)}
async function closeApp(){c?.ws.close();if(app?.pid&&app.exitCode===null){execFileSync('taskkill.exe',['/F','/T','/PID',String(app.pid)],{stdio:'ignore'});await wait(700)}app=null;c=null}
async function cleanup(){try{await c?.invoke('stop_proxy');await c?.invoke('set_capture_mode',{mode:'off'})}catch(e){report.cleanupError=String(e)}for(const child of children)if(child.exitCode===null)child.kill();await closeApp();for(const s of sockets)s.destroy();for(const s of servers)s.close()}
const settings=()=>c.invoke('get_settings');
const status=()=>c.invoke('get_proxy_status');
async function probe(id,ids,proxy){return c.evaluate(`(async()=>{const api=window.__TAURI_INTERNALS__;const streamed=[];const callback=api.transformCallback(m=>{if(m.message)streamed.push(m.message)});try {const batch=await api.invoke('test_subscription_nodes',{id:${JSON.stringify(id)},ids:${JSON.stringify(ids)},throughProxy:${proxy},onResult:'__CHANNEL__:'+callback});return {batch,streamed}}finally{api.unregisterCallback(callback)}})()`)}
async function until(expression){for(let i=0;i<60;i++){if(await c.evaluate(expression))return;await wait(150)}throw Error('UI timeout '+expression)}
async function profiles(){await until("document.querySelectorAll('.nav-items button').length>1");await c.evaluate("document.querySelectorAll('.nav-items button')[1].click()");await until("!!document.querySelector('.profile-workspace-panel')");await wait(350)}
async function capture(name){await wait(250);fs.writeFileSync(out+'/'+name+'.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));report.screenshots.push(name+'.png');save()}
async function refresh(id,body,code=200){subscriptionBody=body;subscriptionCode=code;return c.invoke('refresh_subscription',{id,viaProxy:false})}
async function rejected(p){try{await p;return false}catch{return true}}
const payload=name=>`socks5://127.0.0.1:33301#${name}\nsocks5://127.0.0.1:33302#Beta`;
try{
 phase('extracting');
 if(ps('(Get-CimInstance Win32_ComputerSystem).Model')?.includes('VMware')!==true)throw Error('VMware required');
 if(execFileSync('tasklist.exe',['/FI','IMAGENAME eq satelite-proxy.exe','/FO','CSV','/NH'],{encoding:'utf8'}).includes('satelite-proxy.exe'))throw Error('Close other guest Satelite instances first');
 fs.mkdirSync(root+'-unpacked');execFileSync('tar.exe',['-xf',qa+'/Distribution/Satelite-Quiet-Control-stage4.3-win-x64-portable.zip','-C',root+'-unpacked'],{timeout:60000});fs.renameSync(root+'-unpacked/Satelite-Research',root);
 await fixtureServers();await relay(33301);await relay(33302);
 await listen(http.createServer((q,r)=>{r.writeHead(subscriptionCode,{'Content-Type':'text/plain'});r.end(subscriptionBody)}),33303);
 // The pinned sing-box API ignores HTTP URLs. Use real HTTPS with a guest-only
 // temporary trusted certificate and an IP SAN, independent of profile DNS.
 await launch();await c.invoke('update_settings',{mixedPort:32189,apiPort:32190,probeUrl:'https://203.0.113.10:33304/health',locale:'ru',quietTheme:'dark'});
 phase('profile_cache');subscriptionBody=payload('Alpha');
 const a=(await c.invoke('add_subscription_url',{name:'Основной профиль',url:'http://127.0.0.1:33303/subscription',viaProxy:false})).subscription;
 const b=(await c.invoke('add_subscription_text',{name:'Профиль для проверки',content:'socks5://127.0.0.1:33302#Другой сервер\nsocks5://127.0.0.1:1#Недоступный сервер'})).subscription;
 let nodes=await c.invoke('list_subscription_nodes',{id:a.id});const chosen=nodes[0].id;
 await c.invoke('set_current_node',{nodeId:chosen});await c.invoke('toggle_favorite_node',{id:chosen});
 const ping=await probe(a.id,[chosen],false);check('single_tcp_stream',ping.batch.ok===1&&ping.streamed.length===1,ping);
 for(const [name,body,code]of [['http_error','',503],['empty','',200],['invalid','not a proxy configuration',200]]){
  const failed=await rejected(refresh(a.id,body,code));check(name+'_keeps_cache',failed&&(await c.invoke('list_subscription_nodes',{id:a.id})).length===2&&(await settings()).current_node_id===chosen);
 }
 await refresh(a.id,'socks5://127.0.0.1:33302#Beta renamed\nsocks5://127.0.0.1:33301#Alpha renamed');nodes=await c.invoke('list_subscription_nodes',{id:a.id});
 check('rename_reorder_identity',nodes.find(n=>n.id===chosen)?.name==='Alpha renamed'&&nodes.find(n=>n.id===chosen)?.favorite&&nodes.find(n=>n.id===chosen)?.last_probe?.method==='tcp',nodes);
 await refresh(a.id,'socks5://127.0.0.1:33302#Beta renamed');nodes=await c.invoke('list_subscription_nodes',{id:a.id});check('removed_choice_retained',nodes.find(n=>n.id===chosen)?.retained&&(await settings()).current_node_id===chosen);
 await refresh(a.id,payload('Alpha'));
 await closeApp();await launch();nodes=await c.invoke('list_subscription_nodes',{id:a.id});check('restart_persists_choice_and_results',(await settings()).current_node_id===chosen&&nodes.length===2&&nodes.find(n=>n.id===chosen)?.last_probe?.method==='tcp');
 const other=await c.invoke('list_subscription_nodes',{id:b.id});
 // Local routing fixtures avoid public services and include a process bypass
 // for this harness so TUN cannot recursively capture its synthetic relay.
 const dns=await c.invoke('get_dns_settings');dns.rule_sets.push({id:'qa43-hosts',name:'QA hosts',kind:'hosts',builtin:false,read_only:false,enabled:true,dns_rules:[],hosts:[{id:'qa43-tun',enabled:true,domain:'proxy.test',addr:'203.0.113.10'}]});await c.invoke('update_dns_settings',{settings:dns,apply:false});
 const workspace=await c.invoke('routing_workspace');const document=structuredClone(workspace.active);document.rule_sets.forEach(s=>s.enabled=false);document.mode='rule';document.fallback='direct';document.bypass_lan=false;document.find_process=true;document.rule_sets.push({id:'qa43-routes',name:'Acceptance routes',builtin:false,ownership:'user',enabled:true,strategy:'smart',dns_strategy:'remote',dns_rules:[],rules:[{id:'qa43-proxy',ord:10,type:'domain',payload:'proxy.test',target:'proxy',enabled:true,routing:{name:'proxy.test',condition:{field:'domain',values:['proxy.test']}}},{id:'qa43-ip',ord:15,type:'ip_cidr',payload:'203.0.113.10/32',target:'proxy',enabled:true,routing:{name:'Controlled proxy address',condition:{field:'ip_cidr',values:['203.0.113.10/32']}}},{id:'qa43-node',ord:20,type:'process',payload:'node.exe',target:'direct',enabled:true,routing:{name:'QA harness',condition:{field:'process_name',values:['node.exe']}}}]});
 // IP-containing groups do not override Hosts with remote DNS. The synthetic
 // SOCKS server serves HTTP and deliberately cannot act as a DoH resolver.
 const apply=async()=>{const w=await c.invoke('routing_workspace');await c.invoke('routing_apply',{draft:{base_revision:w.revision,document}})};
 for(const core of ['singbox','mihomo','xray']){
  phase(core+'_checks');document.core=core;await apply();await c.invoke('start_proxy',{enableSystemProxy:false});const before=await status(),pids=ownCorePids();
  const result=await probe(b.id,other.map(n=>n.id),core!=='xray');const after=await status();
  check(core+'_streamed_all',result.streamed.length===2&&result.batch.tested===2,result);
  check(core+'_one_real_success',result.batch.ok===1&&result.batch.results.some(r=>r.latency_ms!==null&&r.method===(core==='xray'?'tcp':'clash_api')),result.batch);
  check(core+'_keeps_running_selection',pids.length>0&&before.actual_node_id===chosen&&after.actual_node_id===chosen&&(await settings()).current_node_id===chosen&&JSON.stringify(pids)===JSON.stringify(ownCorePids()),{pids,before:before.actual_node_id,after:after.actual_node_id});
  check(core+'_probe_cleanup',!fs.existsSync(root+'/data/profile-probes')||fs.readdirSync(root+'/data/profile-probes').length===0);
  if(core==='xray'){const unsupported=await probe(b.id,[other[0].id],true);check('xray_proxy_check_explicitly_unsupported',unsupported.batch.results[0].method==='unsupported_proxy',unsupported)}
  if(core==='singbox'){
   await c.invoke('set_current_node',{nodeId:other[0].id});const selected=await status();check('inactive_profile_explicit_apply',selected.running&&selected.actual_node_id===other[0].id&&(await settings()).current_node_id===other[0].id);
   await c.invoke('set_current_node',{nodeId:chosen});check('manual_return_applies',(await status()).actual_node_id===chosen);
  }
  if(core==='mihomo'){
   const bad=(await c.invoke('add_subscription_text',{name:'Invalid dependency fixture',content:'proxies:\n  - name: Broken dialer\n    type: socks5\n    server: 127.0.0.1\n    port: 33301\n    dialer-proxy: Missing dependency\n'})).subscription;
   const badNodes=await c.invoke('list_subscription_nodes',{id:bad.id});const failed=await rejected(c.invoke('set_current_node',{nodeId:badNodes[0].id}));const restored=await status();check('failed_generated_selection_restores_connection',failed&&restored.running&&restored.actual_node_id===chosen&&(await settings()).current_node_id===chosen,restored.error);
  }
  await c.invoke('stop_proxy');
  for(const mode of ['smart','kernel','off']){await c.invoke('update_settings',{autoSelect:mode});await wait(700)}check(core+'_returns_last_manual',(await settings()).current_node_id===chosen&&(await settings()).last_manual_node_id===chosen);
 }
 phase('tun_and_rate');document.core='singbox';await apply();report.beforeTun=snapshot();await c.invoke('set_capture_mode',{mode:'tun'});await c.invoke('start_proxy',{enableSystemProxy:false});await wait(800);const tunBefore=await status(),tunPids=ownCorePids();report.duringTun=snapshot();
 const tunProbe=await probe(b.id,[other[0].id],true);const tunAfter=await status();check('tun_probe_success',tunProbe.batch.ok===1,tunProbe);check('tun_probe_keeps_main_runtime',tunPids.length>0&&tunAfter.core_started_at===tunBefore.core_started_at&&JSON.stringify(tunPids)===JSON.stringify(ownCorePids()),{beforeStarted:tunBefore.core_started_at,afterStarted:tunAfter.core_started_at,beforePids:tunPids,afterPids:ownCorePids()});
 check('tun_adapter_created',report.duringTun.adapters.some(a=>!report.beforeTun.adapters.some(b=>b.InterfaceIndex===a.InterfaceIndex)));
 const result=await exec('curl.exe',['-4','--noproxy','*','--max-time','15','--fail','--silent','--show-error','http://proxy.test:33300/health'],{timeout:20000}).catch(e=>({stdout:'',error:String(e)}));check('tun_actual_payload_and_hosts_dns',result.stdout==='OK',result.error);
 const beforeBytes=(await status()).download_total;const download=spawn('curl.exe',['-4','--proxy','http://127.0.0.1:32189','--max-time','15','--fail','--silent','--output','NUL','http://203.0.113.10:33300/burst'],{stdio:'ignore',windowsHide:true});children.add(download);const finished=new Promise(r=>download.once('exit',r));
 report.rateSamples=[];for(let i=0;i<6;i++){await wait(850);const s=await status();report.rateSamples.push({download_speed:s.download_speed,split:s.split_traffic,download_total:s.download_total})}check('burst_completed',await finished===0);check('burst_46MiB_accounted',(await status()).download_total-beforeBytes>=46*1024*1024);check('burst_numeric_speed_not_missed',report.rateSamples.some(s=>s.split.vpn.download_speed+s.split.direct.download_speed+s.split.unknown.download_speed>7*1024*1024),report.rateSamples);
 await c.invoke('stop_proxy');await c.invoke('set_capture_mode',{mode:'off'});await wait(600);report.afterTun=snapshot();check('tun_dns_restored',JSON.stringify(report.beforeTun.dns)===JSON.stringify(report.afterTun.dns));check('tun_routes_restored',JSON.stringify(report.beforeTun.routes)===JSON.stringify(report.afterTun.routes));
 await c.invoke('update_settings',{probeUrl:'http://203.0.113.10:33300/health'});let httpError='';try{await probe(b.id,[other[0].id],true)}catch(e){httpError=String(e)}check('singbox_http_url_explicit_error',httpError.includes('probe.singbox_https_only')&&(await settings()).current_node_id===chosen&&ownCorePids().length===0,httpError);await c.invoke('update_settings',{probeUrl:'https://203.0.113.10:33304/health'});
 phase('native_ui');await profiles();const beforeBrowse=(await settings()).current_node_id;
 await c.evaluate("[...document.querySelectorAll('.sub-card')].find(e=>e.textContent.includes('Профиль для проверки')).click()");await until("document.querySelector('#profile-browser-title')?.textContent==='Профиль для проверки'");check('browsing_does_not_select',(await settings()).current_node_id===beforeBrowse);
 await c.evaluate("[...document.querySelectorAll('.profile-browser-node-actions button')].find(e=>e.textContent==='Проверить').click()");await wait(1200);check('ui_check_keeps_choice',(await settings()).current_node_id===beforeBrowse);
 await c.evaluate("(()=>{const e=document.querySelectorAll('.profile-browser-tools select')[0];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'latency');e.dispatchEvent(new Event('change',{bubbles:true}))})()");check('latency_sort_keeps_choice',(await settings()).current_node_id===beforeBrowse);
 for(const theme of ['dark','light']){
  await c.invoke('update_settings',{quietTheme:theme});await c.call('Page.reload');await profiles();
  for(const [width,height]of [[1200,900],[1024,768],[520,800]]){
   await c.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height}}});await wait(300);
   check(theme+'_'+width+'_profile_fit',await c.evaluate("document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.profile-workspace-panel,.profile-browser-node')].every(e=>e.getBoundingClientRect().right<=innerWidth+1)"));await capture('profiles-'+theme+'-'+width);
   await c.evaluate("document.querySelectorAll('.nav-items button')[0].click()");await wait(300);
   check(theme+'_'+width+'_home_fit',await c.evaluate("document.documentElement.scrollWidth<=innerWidth&&!!document.querySelector('.split-traffic')"));
   if(width===1200)check(theme+'_default_home_no_vertical_scroll',await c.evaluate("document.querySelector('.app-content').scrollHeight<=document.querySelector('.app-content').clientHeight+2"));
   await capture('home-'+theme+'-'+width);await profiles();
  }
 }
 await c.invoke('update_settings',{quietTheme:'system'});await c.call('Page.reload');await profiles();check('system_theme',await c.evaluate("document.documentElement.dataset.qcTheme===(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')"));check('no_csp_violations',!report.csp.length,report.csp);
 // Choosing an inactive profile is explicit and does not start a stopped core.
 await c.invoke('set_current_node',{nodeId:other[0].id});check('explicit_choice_stopped',(await settings()).current_node_id===other[0].id&&!(await status()).running);
}catch(error){report.errors.push(String(error.stack??error));save()}finally{phase('cleanup');await cleanup();report.completedAt=new Date().toISOString();phase('completed');clearTimeout(watchdog)}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
