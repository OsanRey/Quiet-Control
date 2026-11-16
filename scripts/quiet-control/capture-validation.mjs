// Guest-only Windows 11 test. No host registry, routes or interfaces are changed.
import fs from 'node:fs';
import net from 'node:net';
import {spawn,execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isDeepStrictEqual} from 'node:util';
import {connect,wait} from './cdp.mjs';
import {services} from './capture-services.mjs';
const exec=promisify(execFile),out='C:/Results';
const report={checks:[],errors:[],phase:'generated-capture-ui-windows11'};
let c,local,app,crashed=false,foreign;
const check=(name,passed,details)=>{report.checks.push({name,passed:Boolean(passed),details});fs.writeFileSync(out+'/progress.json',JSON.stringify(report.checks.map(c=>({name:c.name,passed:c.passed})),null,2));};
const ps=code=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',code+' | ConvertTo-Json -Depth 6 -Compress'],{encoding:'utf8'}).trim()||'null');
const snapshot=()=>({adapters:ps('Get-NetAdapter -IncludeHidden | Select-Object Name,InterfaceIndex,Status,InterfaceDescription'),routes:ps('Get-NetRoute | Select-Object InterfaceIndex,DestinationPrefix,NextHop,RouteMetric'),dns:ps('Get-DnsClientServerAddress | Select-Object InterfaceIndex,AddressFamily,ServerAddresses'),proxy:ps("$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; [pscustomobject]@{enabled=$p.ProxyEnable;server=$p.ProxyServer;override=$p.ProxyOverride}")});
const array=x=>x==null?[]:Array.isArray(x)?x:[x];
const curl=async url=>{try {const r=await exec('curl.exe',['-4','--noproxy','*','--max-time','25','--fail','--silent','--show-error',url],{timeout:30000,maxBuffer:1024*1024});return {ok:r.stdout.includes('Example Domain'),body:r.stdout.slice(0,160),stderr:r.stderr};}catch(e){return {ok:false,error:String(e),stderr:e.stderr};}};
try {
 try{execFileSync('taskkill.exe',['/F','/T','/IM','satelite-proxy.exe'],{stdio:'ignore'})}catch{}if(fs.existsSync('C:/Research')){if(fs.realpathSync('C:/Research').replaceAll('\\','/').toLowerCase()!=='c:/research')throw Error('Unexpected guest path');fs.rmSync('C:/Research',{recursive:true,force:true});}
 fs.mkdirSync('C:/Unpacked',{recursive:true});execFileSync('tar.exe',['-xf','C:/Distribution/Satelite-Quiet-Control-stage2-win-x64-portable.zip','-C','C:/Unpacked']);fs.renameSync('C:/Unpacked/Satelite-Research','C:/Research');fs.copyFileSync('C:/Build/satelite-proxy.exe','C:/Research/satelite-proxy.exe');
 local=await services(); report.internetBefore=await curl('https://example.com/');
 app=spawn('C:/Research/satelite-proxy.exe',[],{cwd:'C:/Research',env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});app.unref();c=await connect();await wait(1200);
 report.os=ps('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber');report.before=snapshot();
 const profile=await c.invoke('add_subscription_text',{name:'VM capture test',content:'socks5://127.0.0.1:32191#'+encodeURIComponent('VM · controlled SOCKS')});const nodes=await c.invoke('list_subscription_nodes',{id:profile.subscription.id});await c.invoke('set_current_node',{nodeId:nodes[0].id});await c.invoke('update_settings',{mixedPort:32189,bypassLan:false,findProcess:true,routeFinal:'proxy'});
 for(const set of await c.invoke('list_rule_sets')){if(set.enabled)await c.invoke('set_rule_set_enabled',{id:set.id,enabled:false});}
 const set=await c.invoke('create_rule_set',{name:'VM relay process exclusion'});await c.invoke('save_rule',{input:{set_id:set.id,rule_type:'process',payload:'node.exe',target:'direct',enabled:true,ord:0}});await c.invoke('set_rule_set_strategy',{id:set.id,strategy:'direct'});await c.invoke('set_rule_set_enabled',{id:set.id,enabled:true});
 const dns=await c.invoke('get_dns_settings');dns.remote_dns=['https://1.1.1.1/dns-query'];dns.dns_final='remote';await c.invoke('update_dns_settings',{settings:dns,apply:false});
 await c.call('Page.reload');await wait(1500);
 const settle=async()=>{for(let i=0;i<120;i++){if(await c.evaluate("!document.querySelector('.power-button').disabled"))return true;await wait(250);}return false;};
 const mode=async index=>{await settle();await c.evaluate(`document.querySelectorAll('.capture-modes button')[${index}].click()`);await wait(150);if(index){await c.evaluate("document.querySelector('dialog .primary-button').click()");}await wait(250);};
 const power=async()=>{await settle();await c.evaluate("document.querySelector('.power-button').click()");await wait(500);await settle();};
 await mode(1);check('idle_selection_does_not_change_windows_proxy',isDeepStrictEqual(snapshot().proxy,report.before.proxy));check('idle_selection_does_not_start_core',!(await c.invoke('get_proxy_status')).running);
 await mode(0);await power();check('local_mode_runs_core_without_system_proxy',(await c.invoke('get_proxy_status')).running&&!(await c.invoke('get_proxy_status')).system_proxy);
 await mode(1);await settle();report.system=snapshot();check('system_mode_applies_windows_proxy',report.system.proxy.enabled===1&&report.system.proxy.server==='127.0.0.1:32189',report.system.proxy);
 try{const r=await exec('powershell.exe',['-NoProfile','-Command',"$response=Invoke-WebRequest 'http://203.0.113.10:32192/system' -UseBasicParsing -TimeoutSec 12; [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())"],{timeout:18000});check('system_proxy_http_client',r.stdout.includes('SATELITE-VM-LOOPBACK'),r.stdout.slice(0,200));}catch(e){check('system_proxy_http_client',false,String(e));}
 await mode(2);await settle();report.tun=snapshot();report.tunStatus=await c.invoke('get_proxy_status');check('tun_core_and_elevated_helper',report.tunStatus.running&&report.tunStatus.tun_enabled&&report.tunStatus.core_elevated,report.tunStatus);
 const beforeIds=new Set(array(report.before.adapters).map(a=>a.InterfaceIndex));const added=array(report.tun.adapters).filter(a=>!beforeIds.has(a.InterfaceIndex));report.tunAdapters=added;check('virtual_adapter_created',added.some(a=>a.Status==='Up'),added);
 const tunIds=new Set(added.map(a=>a.InterfaceIndex));const tunRoutes=array(report.tun.routes).filter(r=>tunIds.has(r.InterfaceIndex));check('tun_routes_created',tunRoutes.length>0,tunRoutes);check('tun_disables_system_proxy',isDeepStrictEqual(report.tun.proxy,report.before.proxy));
 try{const r=await exec('curl.exe',['--noproxy','*','--max-time','10','--silent','--show-error','http://203.0.113.10:32192/tun'],{timeout:15000});check('ordinary_socket_through_tun_and_socks',r.stdout.includes('SATELITE-VM-LOOPBACK'));}catch(e){check('ordinary_socket_through_tun_and_socks',false,String(e));}
 try{const r=await exec('powershell.exe',['-NoProfile','-Command',"Resolve-DnsName example.com -Type A -DnsOnly | Select-Object Name,IPAddress | ConvertTo-Json -Compress"],{timeout:20000});report.dnsResolution=JSON.parse(r.stdout);check('windows_dns_resolves',array(report.dnsResolution).some(r=>r.IPAddress));}catch(e){check('windows_dns_resolves',false,String(e));}
 const observedBefore=local.observed.length;report.internetTun=await curl('https://example.com/');report.internetConnections=local.observed.slice(observedBefore);check('https_internet_through_tun',report.internetTun.ok&&report.internetConnections.some(r=>r.port===443),{response:report.internetTun,requests:report.internetConnections});
 await c.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width:1000,height:820}}});await wait(200);fs.writeFileSync(out+'/tun-active.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await power();report.afterStop=snapshot();check('stop_removes_tun_routes',!array(report.afterStop.routes).some(r=>tunIds.has(r.InterfaceIndex)));check('stop_restores_windows_proxy',isDeepStrictEqual(report.afterStop.proxy,report.before.proxy));
 const physicalDns=s=>array(s.dns).filter(r=>beforeIds.has(r.InterfaceIndex));check('physical_dns_unchanged',isDeepStrictEqual(physicalDns(report.before),physicalDns(report.afterStop)));
 report.internetAfterStop=await curl('https://example.com/');check('internet_after_stop',report.internetAfterStop.ok);
 await mode(0);await mode(1);await power();
 let claimed=false;const deadline=Date.now()+20000;
 const takePort=()=>{const server=net.createServer(socket=>socket.destroy());server.on('error',()=>{if(!claimed&&Date.now()<deadline)setTimeout(takePort,25);});server.listen(32189,'127.0.0.1',()=>{foreign=server;claimed=true;});};takePort();
 await mode(2);await settle();report.failureState=await c.invoke('get_proxy_status');check('failed_tun_switch_stops_core',claimed&&!report.failureState.running);check('failed_tun_switch_restores_proxy',isDeepStrictEqual(snapshot().proxy,report.before.proxy));check('foreign_port_owner_not_killed',foreign?.listening);check('tun_error_diagnostic_visible',await c.evaluate("!!document.querySelector('.capture-diagnostic')"));
 if(foreign)await new Promise(resolve=>foreign.close(resolve));
 await c.evaluate("document.querySelector('.capture-diagnostic .primary-outline').click()");await wait(500);await settle();check('explicit_tun_retry', (await c.invoke('get_proxy_status')).running&&(await c.invoke('get_proxy_status')).tun_enabled);

 if(!(await c.invoke('get_proxy_status')).running)await power();report.restart=snapshot();check('tun_restart',(await c.invoke('get_proxy_status')).tun_enabled&&(await c.invoke('get_proxy_status')).running);process.kill(app.pid);crashed=true;c.ws.close();const restartIds=new Set(array(report.restart.adapters).filter(a=>!beforeIds.has(a.InterfaceIndex)).map(a=>a.InterfaceIndex));for(let i=0;i<12;i++){const remaining=array(ps('Get-NetRoute | Select-Object InterfaceIndex,DestinationPrefix'));if(!remaining.some(r=>restartIds.has(r.InterfaceIndex)))break;await wait(750);}report.afterCrash=snapshot();check('crash_removes_tun_routes',!array(report.afterCrash.routes).some(r=>restartIds.has(r.InterfaceIndex)));check('crash_restores_proxy',isDeepStrictEqual(report.afterCrash.proxy,report.before.proxy));
 report.internetAfterCrash=await curl('https://example.com/');check('internet_after_crash',report.internetAfterCrash.ok);report.relayRequests=local.observed;
}catch(e){report.errors.push(String(e.stack??e));}
finally{if(!crashed){try{await c?.invoke('stop_proxy')}catch{}}c?.ws.close();foreign?.close();local?.close();fs.writeFileSync(out+'/capture-validation.json',JSON.stringify(report,null,2));}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
