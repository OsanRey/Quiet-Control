// Guest-only final archive verification; no profile import or network capture.
import fs from 'node:fs';import {spawn,execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {connect,wait} from './cdp.mjs';
if(!fs.existsSync('C:/UserSource/portable.flag')||!fs.existsSync('C:/UITests/cdp.mjs'))throw Error('Guest mounts required');
const report={checks:[],errors:[]};let c,app;const check=(name,passed)=>report.checks.push({name,passed});
try{
 try{execFileSync('taskkill.exe',['/F','/IM','msedgewebview2.exe'],{stdio:'ignore'});}catch{}
 const base='C:/AuditPackage';if(fs.existsSync(base))throw Error('Use a fresh package directory');fs.mkdirSync(base);
 execFileSync('tar.exe',['-xf','C:/Build/Satelite-Quiet-Control-stage3-tun-audit-win-x64-portable.zip','-C',base]);
 const root=base+'/Satelite-Research',manifest=JSON.parse(fs.readFileSync(root+'/MANIFEST-SHA256.json'));
 const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 report.exeSha256=hash(root+'/satelite-proxy.exe');report.build=JSON.parse(fs.readFileSync(root+'/BUILD-INFO.json'));
 check('all_payload_hashes',manifest.files.every(f=>hash(root+'/'+f.path)===f.sha256));
 app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});
 c=await connect();await wait(500);check('native_gui',await c.evaluate("!!document.querySelector('.application .dashboard-top')"));
 check('no_user_profiles',(await c.invoke('list_subscriptions')).length===0);
 check('no_autoconnect',!(await c.invoke('get_proxy_status')).running);
 check('default_ru',(await c.invoke('get_settings')).locale==='ru');
 for(const kind of ['singbox','xray','mihomo'])check('bundled_'+kind,(await c.invoke('get_core_info',{kind})).installed);
}catch(e){report.errors.push(String(e.stack??e));}finally{c?.ws.close();app?.kill();fs.writeFileSync('C:/Results/audit-package.json',JSON.stringify(report,null,2));}
process.exitCode=report.errors.length||report.checks.some(c=>!c.passed)?1:0;
