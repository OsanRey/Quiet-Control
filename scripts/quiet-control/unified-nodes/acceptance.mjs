// Run only inside the marked VMware guest. No user profiles or remote providers.
import fs from 'node:fs';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,wait} from '../cdp.mjs';
const qa=process.env.QC_QA_ROOT;
if(!qa||!fs.existsSync(qa+'/qa-guest.marker'))throw Error('Marked VMware QA root required');
const out=qa+'/Results',root=qa+'/Extract/Satelite-Research',exec=promisify(execFile),children=[];
const report={stage:'unified-nodes',qaVersion:'QC_NODES_V2',checks:[],errors:[],screenshots:[],evidence_files:[],applicationRoot:root};
let app,c;
const save=()=>{
 const target=out+'/unified-nodes.json',pending=target+'.pending';
 for(let attempt=0;;attempt++){
  try {fs.writeFileSync(pending,JSON.stringify(report,null,2));fs.renameSync(pending,target);return}
  catch(error){if(attempt>=5||!['EBUSY','EPERM','EACCES'].includes(error.code)){console.error('REPORT_WRITE_FAILED',error);throw error}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50)}
 }
};
const phase=name=>{report.phase=name;save();console.log(name)};
const check=(name,passed,details)=>{report.checks.push({name,passed:!!passed,details});save()};
const ps=async code=>JSON.parse((await exec('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new();'+code+' | ConvertTo-Json -Depth 8 -Compress'],{timeout:30000})).stdout.trim()||'null');
const snapshot=()=>ps("[ordered]@{routes=@(Get-NetRoute | Sort-Object InterfaceIndex,DestinationPrefix,NextHop | Select-Object InterfaceIndex,DestinationPrefix,NextHop);dns=@(Get-DnsClientServerAddress | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses)}");
const settings=()=>c.invoke('get_settings');
const status=()=>c.invoke('get_proxy_status');
const identity=s=>JSON.stringify([s.current_node_id,s.last_manual_node_id,s.auto_select]);
async function rejected(p){try{await p;return false}catch(e){return String(e)}}
async function fixture(file,args=[]){const child=spawn(process.execPath,[file,...args],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});children.push(child);await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('Fixture timeout')),10000);child.once('message',m=>{clearTimeout(timer);m.ready?r():j(Error('Fixture failure'))});child.once('exit',n=>{clearTimeout(timer);j(Error('Fixture exited '+n))})});}
async function until(expression){for(let i=0;i<65;i++){if(await c.evaluate(expression))return;await wait(150)}throw Error('UI timeout '+expression)}
async function launch(){app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore',windowsHide:true});c=await connect();await c.call('Page.enable');await wait(650)}
async function close(){if(app?.exitCode===null){await c.invoke('update_settings',{closeToTray:false});await ps('[Diagnostics.Process]::GetProcessById('+app.pid+').CloseMainWindow()');for(let i=0;i<80&&app.exitCode===null;i++)await wait(100);if(app.exitCode===null)throw Error('Normal exit timed out');check('normal_exit',app.exitCode===0)}c?.ws.close();app=null;c=null;await wait(1500)}
async function cleanup(){try{await c?.invoke('stop_proxy');await c?.invoke('set_capture_mode',{mode:'off'});await close()}catch(error){report.errors.push('Cleanup: '+String(error));if(app?.exitCode===null)execFileSync('taskkill.exe',['/F','/T','/PID',String(app.pid)],{stdio:'ignore'})}for(const child of children)if(child.exitCode===null)child.kill()}
async function click(selector){await until(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);await c.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(300)}
async function clickText(selector,text){const ok=await c.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>(e.querySelector('.glass-btn-label')??e).textContent.trim()===${JSON.stringify(text)});e?.click();return !!e})()`);if(!ok)throw Error('Missing action '+text);await wait(250)}
async function fill(selector,value){await c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(400)}
async function nodesPage(){await until("!!document.querySelector('.nav-items button[aria-label=\"Узлы\"]')");await click('.nav-items button[aria-label="Узлы"]');await until("!!document.querySelector('[data-testid=node-source]')");await wait(450)}
async function probe(id,ids,proxy){return c.evaluate(`(async()=>{const api=window.__TAURI_INTERNALS__;const callback=api.transformCallback(()=>{});try{return await api.invoke('test_subscription_nodes',{id:${JSON.stringify(id)},ids:${JSON.stringify(ids)},throughProxy:${proxy},onResult:'__CHANNEL__:'+callback})}finally{api.unregisterCallback(callback)}})()`)}
async function shot(name){await wait(250);fs.writeFileSync(out+'/'+name+'.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));report.screenshots.push(name+'.png');save()}
const watchdog=setTimeout(()=>{report.errors.push('Watchdog exceeded 6 minutes');save();void cleanup().finally(()=>process.exit(2))},360000);
try{
 phase('prepare');if(!(await ps('(Get-CimInstance Win32_ComputerSystem).Model')).includes('VMware'))throw Error('VMware required');
 if(execFileSync('tasklist.exe',['/FI','IMAGENAME eq satelite-proxy.exe','/FO','CSV','/NH'],{encoding:'utf8'}).includes('satelite-proxy.exe'))throw Error('Close other Satelite guest instances first');
 fs.mkdirSync(root,{recursive:true});report.baselineNetwork=await snapshot();
 phase('extract');await exec('powershell.exe',['-NoProfile','-Command',`$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${qa}/Distribution/Satelite-Quiet-Control-unified-nodes-win-x64-portable.zip' -DestinationPath '${qa}/Extract' -Force`],{timeout:120000});
 check('executable_extracted',fs.existsSync(root+'/satelite-proxy.exe'));phase('fixtures');
 await fixture(qa+'/Scripts/unified-nodes/fixtures.mjs');await fixture(qa+'/Scripts/routing-usability/fixtures.mjs',[out+'/unified-network-fixtures.jsonl']);report.evidence_files.push('unified-network-fixtures.jsonl');
 phase('launch');await launch();phase('seed');await c.invoke('update_settings',{locale:'ru',quietTheme:'dark',mixedPort:32189,apiPort:32190,autoSelect:'off'});
 const a=(await c.invoke('add_subscription_url',{name:'Subscription A',url:'http://127.0.0.1:34610/subscription',viaProxy:false})).subscription;
 const b=(await c.invoke('add_subscription_url',{name:'Subscription B',url:'http://127.0.0.1:34610/second',viaProxy:false})).subscription;
 const local=(await c.invoke('add_subscription_text',{name:'Local fixture',content:'socks5://127.0.0.1:33301#Local%20server'})).subscription;
 const an=(await c.invoke('list_subscription_nodes',{id:a.id}))[0],bn=(await c.invoke('list_subscription_nodes',{id:b.id}))[0];
 await c.invoke('set_current_node',{nodeId:an.id});await c.invoke('toggle_favorite_node',{id:an.id});
 const before=identity(await settings());await nodesPage();
 check('one_nodes_navigation',await c.evaluate("!!document.querySelector('.nav-items button[aria-label=\"Узлы\"]')&&!document.querySelector('.nav-items button[aria-label=\"Профили\"]')"));
 check('all_sources_visible',(await c.invoke('list_all_nodes',{includeInactive:true})).length===3);
 await fill('[data-testid=node-source]',b.id);await until(`document.querySelectorAll('[data-node-id]').length===1&&!!document.querySelector('[data-node-id="${bn.id}"]')`);
 check('browse_inactive_does_not_select',identity(await settings())===before);
 await clickText('.nodes-page button','TCP-проверка');await until("document.querySelectorAll('.nodes-page .lat-spinner').length===0");
 check('ui_tcp_keeps_choice',identity(await settings())===before);
 for(const label of ['По имени','По подписке','По протоколу','По стране','Без группировки','Карточки','Таблица'])await clickText('.nodes-page .glass-seg-btn',label);
 check('sort_group_and_view_keep_choice',identity(await settings())===before);
 const tcp=await probe(b.id,[bn.id],false);check('inactive_tcp_real_result',tcp.results.length===1&&typeof tcp.results[0].latency_ms==='number'&&tcp.results[0].latency_ms>=0,tcp);
 await c.invoke('refresh_subscription',{id:b.id,viaProxy:false});check('refresh_and_probe_preserve_choice',identity(await settings())===before);
 await until(`!!document.querySelector('[data-node-id="${bn.id}"]')`);await click(`[data-node-id="${bn.id}"]`);check('choose_stages_without_activation',(await settings()).last_manual_node_id===bn.id&&(await settings()).current_node_id===an.id&&!(await status()).running);
 await click('[data-testid=connect-chosen-node]');await wait(800);check('explicit_connect_applies',!!(await status()).running&&(await settings()).current_node_id===bn.id);
 const started=(await status()).core_started_at;await c.invoke('prepare_node_selection',{nodeId:an.id});check('prepare_keeps_live_core',(await status()).core_started_at===started&&(await status()).running&&(await settings()).current_node_id===bn.id);
 const refused=await rejected(c.invoke('remove_subscription',{id:b.id}));check('backend_active_delete_blocked',String(refused).includes('sources.stop_before_delete'));
 await probe(a.id,[an.id],false);check('live_probe_keeps_core',(await status()).core_started_at===started&&(await status()).running);
 await c.invoke('stop_proxy');await c.invoke('set_current_node',{nodeId:an.id});
 phase('core_compatibility');
 for(const core of ['xray','mihomo','singbox']){
  await c.invoke('set_core_type',{kind:core});await c.invoke('set_current_node',{nodeId:an.id});await c.invoke('start_proxy',{enableSystemProxy:false});
  const beforeCore=await status();await c.invoke('prepare_node_selection',{nodeId:bn.id});await probe(b.id,[bn.id],false);const afterCore=await status();
  check(core+'_staged_choice_and_tcp_preserve_live_core',afterCore.running&&afterCore.core_started_at===beforeCore.core_started_at&&(await settings()).current_node_id===an.id&&(await settings()).last_manual_node_id===bn.id);
  await c.invoke('stop_proxy');
 }
 phase('tun_preservation');await c.invoke('set_current_node',{nodeId:an.id});await c.invoke('set_outbound_mode',{mode:'global'});
 const beforeAdapters=await ps('@(Get-NetAdapter -IncludeHidden | Select-Object ifIndex,Name,InterfaceDescription)');
 await c.invoke('set_capture_mode',{mode:'tun'});await c.invoke('start_proxy',{enableSystemProxy:false});await wait(800);
 const tunBefore=await status(),adapters=await ps('@(Get-NetAdapter -IncludeHidden | Select-Object ifIndex,Name,InterfaceDescription)');
 check('tun_adapter_created',tunBefore.running&&tunBefore.tun_enabled&&adapters.some(a=>!beforeAdapters.some(b=>b.ifIndex===a.ifIndex)),{beforeAdapters,adapters});
 await c.invoke('prepare_node_selection',{nodeId:bn.id});await probe(b.id,[bn.id],false);await c.invoke('refresh_subscription',{id:b.id,viaProxy:false});
 const tunAfter=await status();check('tun_prepare_refresh_probe_preserve_core',tunAfter.running&&tunAfter.core_started_at===tunBefore.core_started_at&&(await settings()).current_node_id===an.id);
 const transfer=await exec('curl.exe',['-4','--noproxy','*','--max-time','2','--silent','--show-error','http://203.0.113.10:33300/health'],{timeout:6000}).catch(e=>({stdout:e.stdout??'',error:String(e)}));
 check('tun_real_payload_after_operations',transfer.stdout.startsWith('VPN\n'),{prefix:transfer.stdout.slice(0,30)});
 await c.invoke('stop_proxy');await c.invoke('set_capture_mode',{mode:'off'});await c.invoke('set_current_node',{nodeId:an.id});
 phase('source_management');await c.call('Page.reload');await nodesPage();await click('[data-testid=manage-sources]');
 await until(`!!document.querySelector('[data-profile-id="${b.id}"]')`);
 check('management_has_no_duplicate_node_browser',await c.evaluate("!document.querySelector('.unified-source-drawer .profile-workspace-panel')"));
 await click(`[data-profile-id="${b.id}"] .sub-menu-trigger`);await click(`[data-profile-id="${b.id}"] [data-testid=source-delete]`);
 check('delete_confirmation_names_and_count',await c.evaluate("document.querySelector('[data-testid=source-delete-confirm]').textContent.includes('Subscription B')&&document.querySelector('[data-testid=source-delete-confirm]').textContent.includes('1')"));
 await shot('nodes-delete-confirm');await clickText('[data-testid=source-delete-confirm] button','Отмена');check('cancel_does_not_delete',(await c.invoke('list_subscriptions')).some(p=>p.id===b.id));
 await click(`[data-profile-id="${b.id}"] .sub-menu-trigger`);await click(`[data-profile-id="${b.id}"] [data-testid=source-delete]`);await click('[data-testid=source-delete-confirm] .danger');await until(`!document.querySelector('[data-profile-id="${b.id}"]')`);
 const afterDelete=await c.invoke('list_all_nodes',{includeInactive:true});check('delete_only_owned_nodes',afterDelete.length===2&&afterDelete.some(n=>n.id===an.id&&n.favorite)&&afterDelete.some(n=>n.subscription_id===local.id)&&!afterDelete.some(n=>n.subscription_id===b.id));
 await click('.source-close button');await fill('[data-testid=node-source]','local');await until("document.querySelectorAll('[data-node-id]').length===1");check('local_filter',await c.evaluate("document.querySelector('[data-node-id] .node-list-name')?.textContent.includes('Local server')"));
 phase('themes_and_sizes');await fill('[data-testid=node-source]','all');
 for(const theme of ['dark','light']){await c.invoke('update_settings',{quietTheme:theme});await c.call('Page.reload');await nodesPage();for(const width of [1200,900]){await c.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(350);check(theme+'_'+width+'_no_horizontal_overflow',await c.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await shot('nodes-'+theme+'-'+width)}await click('[data-testid=manage-sources]');await shot('nodes-sources-'+theme);await click('.source-close button')}
 for(const mode of ['smart','kernel','off']){await c.invoke('update_settings',{autoSelect:mode});check('selection_mode_'+mode,(await settings()).auto_select===mode)}
 phase('persistence');await close();await launch();const saved=await c.invoke('list_all_nodes',{includeInactive:true});check('restart_keeps_sources_and_favorite',saved.length===2&&saved.some(n=>n.id===an.id&&n.favorite)&&(await settings()).last_manual_node_id===an.id);
 await c.invoke('stop_proxy');await c.invoke('set_capture_mode',{mode:'off'});report.finalNetwork=await snapshot();check('routes_restored',JSON.stringify(report.baselineNetwork.routes)===JSON.stringify(report.finalNetwork.routes));check('dns_restored',JSON.stringify(report.baselineNetwork.dns)===JSON.stringify(report.finalNetwork.dns));
}catch(error){report.errors.push(String(error));try{report.ui=await c?.evaluate('document.body.innerText');await shot('nodes-failure')}catch{}save()}
finally{phase('cleanup');await cleanup();report.completedAt=new Date().toISOString();phase('completed');clearTimeout(watchdog)}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
