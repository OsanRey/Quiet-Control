// Guest-only A/B: the identical Xray config, changing only grpcSettings.multiMode.
import fs from 'node:fs';
import {spawn, execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {connect, wait} from './cdp.mjs';
const exec = promisify(execFile), root = 'C:/UserRun', report = {runs:[]};
if (!fs.existsSync('C:/UserSource/portable.flag') || !fs.existsSync('C:/UITests/cdp.mjs')) throw Error('Guest mounts required');
let app, c, core;
const walk = p => fs.readdirSync(p,{withFileTypes:true}).flatMap(e => e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
try {
  try {execFileSync('taskkill.exe',['/F','/IM','msedgewebview2.exe'],{stdio:'ignore'});} catch {}
  app=spawn(root+'/satelite-proxy.exe',[],{cwd:root,env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});
  c=await connect(); await wait(500);
  await c.invoke('set_capture_mode',{mode:'off'});
  await c.invoke('set_core_type',{kind:'xray'});
  await c.invoke('start_proxy',{enableSystemProxy:false});
  const config=JSON.parse(fs.readFileSync(root+'/config/active.json','utf8'));
  await c.invoke('stop_proxy');
  const store=JSON.parse(fs.readFileSync(root+'/data/store.json','utf8'));
  const target=config.outbounds.find(o=>o.tag==='node-'+store.settings.current_node_id.slice(0,16));
  if (!target?.streamSettings?.grpcSettings) throw Error('No selected gRPC outbound');
  report.selectedWasDefault=config.outbounds[0].tag===target.tag;
  report.routingTargets=config.routing?.rules?.map(r=>r.outboundTag??r.balancerTag);
  config.log={loglevel:'debug'};
  const redact=text=>{
    for(const n of store.nodes) for(const secret of [n.server,n.config?.uuid,n.config?.password,n.transport?.service_name])
      if(secret) text=text.split(secret).join('[redacted]');
    return text;
  };
  const binary=walk(root+'/bin').find(p=>/\/xray\.exe$/i.test(p));
  if (!binary) throw Error('Missing trusted Xray');
  report.grpcOutboundCount=config.outbounds.filter(o=>o.streamSettings?.grpcSettings).length;
  for (const multiMode of [false,true]) {
    target.streamSettings.grpcSettings.multiMode=multiMode;
    const file=root+'/config/grpc-multi-test.json'; fs.writeFileSync(file,JSON.stringify(config));
    let logs='';
    core=spawn(binary,['run','-config',file],{cwd:binary.slice(0,binary.lastIndexOf('/')),stdio:['ignore','pipe','pipe']});
    core.stdout.on('data',b=>logs+=b);core.stderr.on('data',b=>logs+=b);
    await wait(1500);
    const run={multiMode}; report.runs.push(run);
    for (const [name,url] of [['https','https://example.com/'],['geo','https://api.ip.sb/geoip']]) {
      try {
        const r=await exec('curl.exe',['-4','--proxy','socks5h://127.0.0.1:32080','--max-time','20','--fail','--silent','--show-error',url],{timeout:25000});
        run[name]=name==='geo'?{ok:true,country:JSON.parse(r.stdout).country_code}:{ok:r.stdout.includes('Example Domain'),bytes:r.stdout.length};
      } catch(e) {run[name]={ok:false,code:e.code,stderr:e.stderr?.slice(0,180)};}
    }
    run.coreExit=core.exitCode;
    run.errors=redact(logs).split(/\r?\n/).filter(l=>/grpc|failed|error|transport|rejected/i.test(l)).slice(-18);
    core.kill(); await wait(1500);
    fs.writeFileSync('C:/Results/grpc-multi.json',JSON.stringify(report,null,2));
  }
} catch(e) {report.error=String(e.stack??e);} finally {
  core?.kill(); try {await c?.invoke('stop_proxy');} catch {}
  c?.ws.close(); app?.kill();
  fs.writeFileSync('C:/Results/grpc-multi.json',JSON.stringify(report,null,2));
}
