// Short VM-only post-cleanup acceptance; no core, provider fetch, TUN or proxy changes.
import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {connect,wait} from './cdp.mjs';
const qa=process.env.QC_QA_ROOT;
if(!qa||!fs.existsSync(qa+'/qa-guest.marker'))throw Error('Marked VMware QA root required');
const out=qa+'/Results',root=qa+'/Extract/Satelite-Research',exec=promisify(execFile);
const report={stage:'cleanup',qaVersion:'QC_CLEAN_V2',checks:[],errors:[],screenshots:[]};
let app,c;
const save=()=>fs.writeFileSync(out+'/cleanup.json',JSON.stringify(report,null,2));
const check=(name,passed)=>{report.checks.push({name,passed:!!passed});save()};
const ps=async code=>JSON.parse((await exec('powershell.exe',['-NoProfile','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new();'+code+' | ConvertTo-Json -Depth 8 -Compress'],{timeout:20000})).stdout.trim()||'null');
const snapshot=()=>ps("[ordered]@{routes=@(Get-NetRoute | Sort-Object InterfaceIndex,DestinationPrefix,NextHop | Select-Object InterfaceIndex,DestinationPrefix,NextHop);dns=@(Get-DnsClientServerAddress | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses)}");
async function until(expression){for(let i=0;i<100;i++){if(await c.evaluate(expression))return;await wait(150)}throw Error('UI readiness timeout')}
async function page(label){await until('!!document.querySelector(".nav-items")');const ok=await c.evaluate(`(()=>{const e=[...document.querySelectorAll('.nav-items button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});e?.click();return !!e})()`);if(!ok)throw Error('Navigation missing: '+label);await wait(450)}
async function launch(){
 app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},windowsHide:true,stdio:['ignore',fs.openSync(out+'/app.stdout.log','a'),fs.openSync(out+'/app.stderr.log','a')]});
 c=await connect();await c.call('Page.enable');await c.invoke('get_settings');
}
async function close(){
 if(app?.exitCode===null){await c.invoke('update_settings',{closeToTray:false});await ps('[Diagnostics.Process]::GetProcessById('+app.pid+').CloseMainWindow()');for(let i=0;i<100&&app.exitCode===null;i++)await wait(100);if(app.exitCode===null)throw Error('Normal exit timeout');check('normal_exit',app.exitCode===0)}
 c?.ws.close();c=null;app=null;await wait(800);
}
async function shot(name){await wait(200);fs.writeFileSync(out+'/'+name+'.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));report.screenshots.push(name+'.png');save()}
const watchdog=setTimeout(()=>{report.errors.push('QA watchdog exceeded four minutes');save();if(app?.exitCode===null)app.kill();process.exit(2)},240000);
try{
 if(!(await ps('(Get-CimInstance Win32_ComputerSystem).Model')).includes('VMware'))throw Error('VMware guest only');
 report.baselineNetwork=await snapshot();report.phase='extract';save();
 await exec('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${qa}/Distribution/Satelite-Quiet-Control-unified-nodes-win-x64-portable.zip' -DestinationPath '${qa}/Extract' -Force`],{timeout:120000});
 const inputs=JSON.parse(fs.readFileSync(out+'/QA-INPUTS.json','utf8').replace(/^\uFEFF/,''));
 const {createHash}=await import('node:crypto');check('extracted_exe_hash_matches',createHash('sha256').update(fs.readFileSync(root+'/satelite-proxy.exe')).digest('hex')===inputs.exeSha256);
 report.phase='launch';save();await launch();await c.invoke('update_settings',{locale:'ru',quietTheme:'dark',closeToTray:false});
 await c.call('Page.reload');await until('!!document.querySelector(".nav-items")');
 for(const label of ['Главная','Узлы','Маршруты','DNS','Статистика','Инструменты','Журнал','Настройки']){await page(label);check('page_'+label,await c.evaluate('document.body.innerText.length>100'))}
 check('no_core_started',!(await c.invoke('get_proxy_status')).running);
 const sub=(await c.invoke('add_subscription_text',{name:'Local QA source',content:'socks5://127.0.0.1:9#Local%20QA%20node'})).subscription;
 const node=(await c.invoke('list_subscription_nodes',{id:sub.id}))[0];check('local_node_saved',!!node);
 await c.invoke('toggle_favorite_node',{id:node.id});await c.invoke('prepare_node_selection',{nodeId:node.id});
 check('selection_does_not_start_core',!(await c.invoke('get_proxy_status')).running);
 for(const theme of ['dark','light']){
  await c.invoke('update_settings',{quietTheme:theme});await c.call('Page.reload');await page('Узлы');
  for(const width of [1200,900]){
   const height=width*3/4;await c.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height}}});await wait(400);
   const viewport=await c.evaluate('({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1})');
   check(theme+'_'+width+'_fits',!viewport.overflow);await shot('cleanup-nodes-'+theme+'-'+width);
  }
  await page('Главная');await shot('cleanup-home-'+theme);
 }
 await close();await launch();const restored=await c.invoke('list_all_nodes',{includeInactive:true});
 check('restart_preserves_local_favorite',restored.some(n=>n.id===node.id&&n.favorite));
 check('restart_does_not_start_core',!(await c.invoke('get_proxy_status')).running);
 await c.invoke('remove_subscription',{id:sub.id});check('local_delete_works',(await c.invoke('list_all_nodes',{includeInactive:true})).length===0);
 await close();report.finalNetwork=await snapshot();check('network_unchanged',JSON.stringify(report.baselineNetwork)===JSON.stringify(report.finalNetwork));
}catch(error){report.errors.push(String(error));try{if(c)await shot('cleanup-failure')}catch{}}
finally{
 try{await close()}catch(error){report.errors.push(String(error));if(app?.exitCode===null)app.kill()}
 report.phase='completed';report.completedAt=new Date().toISOString();save();clearTimeout(watchdog);
}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
