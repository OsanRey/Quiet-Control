import fs from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {connect,wait} from './cdp.mjs';
import {services,requestProxy} from './local-services.mjs';
const report={checks:[],screenshots:[],errors:[]};let c,local,pump;
try {
 try{execFileSync('taskkill.exe',['/F','/IM','satelite-proxy.exe'],{stdio:'ignore'})}catch{};fs.rmSync('C:/Research',{recursive:true,force:true});
 fs.mkdirSync('C:/Unpacked',{recursive:true});execFileSync('tar.exe',['-xf','C:/Distribution/Satelite-Quiet-Control-stage1-win-x64-portable.zip','-C','C:/Unpacked']);fs.renameSync('C:/Unpacked/Satelite-Research','C:/Research');fs.copyFileSync('C:/Build/satelite-proxy.exe','C:/Research/satelite-proxy.exe');
 const app=spawn('C:/Research/satelite-proxy.exe',[],{cwd:'C:/Research',env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});app.unref();c=await connect();await wait(1000);
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:"window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));"});await c.call('Page.reload');await wait(800);await c.evaluate("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective))");
 const check=(name,passed,details)=>report.checks.push({name,passed,details});
 check('no_auto_start',!(await c.invoke('get_proxy_status')).running);
 for(const state of ['empty','live']) {
  if(state==='live') {
   local=await services();const profile=await c.invoke('add_subscription_text',{name:'Sandbox · локальная проверка',content:'socks5://127.0.0.1:32191#'+encodeURIComponent('Sandbox · локальный SOCKS')});const nodes=await c.invoke('list_subscription_nodes',{id:profile.subscription.id});await c.invoke('set_current_node',{nodeId:nodes[0].id});await c.invoke('update_settings',{mixedPort:32189,bypassLan:false});await c.invoke('set_outbound_mode',{mode:'global'});await c.call('Page.reload');await wait(800);await c.evaluate("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective))");
   await c.evaluate("document.querySelector('.qc-power').click()");for(let i=0;i<150;i++){await wait(250);if(await c.evaluate("!document.querySelector('.qc-power').disabled && document.querySelector('.qc-connect-actions').innerText.includes('Остановить')"))break;}check('power_starts_core',(await c.invoke('get_proxy_status')).running);await c.evaluate("document.querySelector('.qc-notice button')?.click()");check('real_payload',(await requestProxy('203.0.113.10','/stage1.1')).includes('SATELITE-VM-LOOPBACK'));pump=setInterval(()=>void requestProxy('203.0.113.10','/measurement').catch(()=>{}),250);await wait(2200);
  }
  for(const theme of ['dark','light']) {
   if(state==='live') await wait(6500);
   await c.evaluate(`(()=>{const s=document.querySelector('.qc-header-actions select');s.value=${JSON.stringify(theme)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(400);
   for(const [width,height] of [[1400,1000],[1000,820],[520,800],[480,480]]) {
    await c.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height}}});await wait(250);await c.evaluate("document.querySelector('.qc-main').scrollTo(0,0);document.activeElement?.blur()");
    const layout=await c.evaluate("(()=>{const m=document.querySelector('.qc-main');const power=document.querySelector('.qc-power').getBoundingClientRect();return {width:innerWidth,height:innerHeight,overflow:m.scrollWidth>m.clientWidth+1,powerBottom:power.bottom,heights:[...document.querySelectorAll('.qc-card')].map(e=>Math.round(e.getBoundingClientRect().height))}})()");check(`${state}_${theme}_${width}`,!layout.overflow && layout.width===width && layout.height===height && layout.powerBottom<height,layout);
    const name=`${state}-${theme}-${width}x${height}.png`;fs.writeFileSync('C:/Results/'+name,Buffer.from((await c.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));report.screenshots.push(name);
   }
  }
 }
 await c.evaluate("document.querySelector('.qc-power').click()");await wait(2500);check('power_stops_core',!(await c.invoke('get_proxy_status')).running);report.csp=await c.evaluate('window.__csp ?? []');check('csp',report.csp.length===0);
} catch(e){report.errors.push(String(e.stack??e));}finally {clearInterval(pump);try{await c?.invoke('stop_proxy')}catch{}c?.ws.close();local?.close();fs.writeFileSync('C:/Results/visual-validation.json',JSON.stringify(report,null,2));}
process.exitCode=report.errors.length||report.checks.some(x=>!x.passed)?1:0;
