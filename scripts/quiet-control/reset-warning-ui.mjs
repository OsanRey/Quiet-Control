// Guest-only native regression: injected log fixtures test display, not VPN health.
import fs from 'node:fs';import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {connect,wait} from './cdp.mjs';import {services,requestProxy} from './local-services.mjs';
if(!fs.existsSync('C:/UITests/cdp.mjs')||!fs.existsSync('C:/Build/Satelite-Quiet-Control-stage3-tun-audit-win-x64-portable.zip'))throw Error('Guest mounts required');
const report={checks:[],errors:[],logFixtures:true};const check=(name,passed)=>report.checks.push({name,passed:Boolean(passed)});let c,app,local;
try{
 try{execFileSync('taskkill.exe',['/F','/IM','msedgewebview2.exe'],{stdio:'ignore'});}catch{}
 const dest='C:/WarningCheck-'+Date.now();fs.mkdirSync(dest);
 execFileSync('tar.exe',['-xf','C:/Build/Satelite-Quiet-Control-stage3-tun-audit-win-x64-portable.zip','-C',dest]);const root=dest+'/Satelite-Research';
 const manifest=JSON.parse(fs.readFileSync(root+'/MANIFEST-SHA256.json'));
 check('all_manifest_hashes',manifest.files.every(f=>createHash('sha256').update(fs.readFileSync(root+'/'+f.path)).digest('hex')===f.sha256));
 local=await services();app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});
 c=await connect();await wait(1000);check('no_autoconnect',!(await c.invoke('get_proxy_status')).running);
 const profile=await c.invoke('add_subscription_text',{name:'Sandbox regression fixture',content:'socks5://127.0.0.1:32191#Local-fixture'});
 const nodes=await c.invoke('list_subscription_nodes',{id:profile.subscription.id}),id=nodes[0].id;
 await c.invoke('set_current_node',{nodeId:id});await c.invoke('update_settings',{mixedPort:32189,bypassLan:false});await c.invoke('set_outbound_mode',{mode:'global'});
 await c.invoke('start_proxy',{enableSystemProxy:false});await wait(2000);
 report.status=await c.invoke('get_proxy_status');
 report.mixedPort=(await c.invoke('get_settings')).mixed_port;
 report.coreTail=(await c.invoke('get_core_log_tail',{limit:12,kind:'singbox'})).lines;
 check('real_local_forwarding',(await requestProxy('203.0.113.10','/reset-regression')).includes('SATELITE-VM-LOOPBACK'));
 const path=fs.readdirSync(root+'/logs').filter(n=>n.startsWith('sing-box')).map(n=>root+'/logs/'+n).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
 const prefix=()=>'+0000 '+new Date().toISOString().slice(0,19).replace('T',' ')+' ERROR ';
 const reset=prefix()+'[2233273195 667ms] connection: connection upload closed: raw-read tcp4 172.19.0.1:58744->172.19.0.2:10085: An existing connection was forcibly closed by the remote host.';
 fs.appendFileSync(path,'\n'+reset+'\n');await wait(5000);
 check('reset_stays_in_log',(await c.invoke('get_core_log_tail',{limit:160,kind:'singbox'})).lines.some(l=>l.includes('2233273195')));
 check('reset_has_no_global_warning',!await c.evaluate("!!document.querySelector('.capture-diagnostic')"));
 check('core_status_retained',await c.evaluate("document.querySelector('.status-pill').textContent.includes('Ядро работает')"));
 fs.writeFileSync('C:/Results/reset-no-warning.png',Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
 fs.appendFileSync(path,prefix()+`connection: open connection using outbound/socks[node-${id.slice(0,16)}]: reality verification failed\n`);await wait(5000);
 check('explicit_transport_error_visible',await c.evaluate("document.querySelector('.capture-diagnostic')?.textContent.includes('REALITY')"));
 await c.invoke('stop_proxy');await wait(1500);check('warning_clears_after_stop',!await c.evaluate("!!document.querySelector('.capture-diagnostic')"));
}catch(e){report.errors.push(String(e.stack??e));}finally{try{await c?.invoke('stop_proxy');}catch{}c?.ws.close();app?.kill();local?.close();fs.writeFileSync('C:/Results/reset-warning.json',JSON.stringify(report,null,2));}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
