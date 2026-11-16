import fs from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {connect,wait} from './cdp.mjs';
import {services,requestProxy} from './local-services.mjs';
const report={checks:[],screenshots:[],errors:[]};let c,local,pump;
try {
 try{execFileSync('taskkill.exe',['/F','/IM','satelite-proxy.exe'],{stdio:'ignore'})}catch{};fs.rmSync('C:/Research',{recursive:true,force:true});
 fs.mkdirSync('C:/Unpacked',{recursive:true});execFileSync('tar.exe',['-xf','C:/Distribution/Satelite-Quiet-Control-stage1-win-x64-portable.zip','-C','C:/Unpacked']);fs.renameSync('C:/Unpacked/Satelite-Research','C:/Research');fs.copyFileSync('C:/Build/satelite-proxy.exe','C:/Research/satelite-proxy.exe');
 const app=spawn('C:/Research/satelite-proxy.exe',[],{cwd:'C:/Research',env:{...process.env,SATELITE_TEST_CDP_PORT:'9222'},stdio:'ignore'});app.unref();c=await connect();c.ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.text)});await c.call('Runtime.enable');await wait(1000);
 await c.call('Page.addScriptToEvaluateOnNewDocument',{source:"window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));"});await c.call('Page.reload');await wait(800);await c.evaluate("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective))");
 const check=(name,passed,details)=>report.checks.push({name,passed,details});
 check('no_auto_start',!(await c.invoke('get_proxy_status')).running);
 for(const state of ['empty','live']) {
  if(state==='live') {
   local=await services();const profile=await c.invoke('add_subscription_text',{name:'Sandbox · локальная проверка',content:'socks5://127.0.0.1:32191#'+encodeURIComponent('Sandbox · локальный SOCKS')});const nodes=await c.invoke('list_subscription_nodes',{id:profile.subscription.id});await c.invoke('set_current_node',{nodeId:nodes[0].id});await c.invoke('toggle_favorite_node',{id:nodes[0].id});await c.invoke('update_settings',{mixedPort:32189,bypassLan:false});await c.invoke('set_outbound_mode',{mode:'global'});await c.call('Page.reload');await wait(800);await c.evaluate("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective))");
   await c.evaluate("document.querySelector('.power-button').click()");for(let i=0;i<150;i++){await wait(250);if(await c.evaluate("!document.querySelector('.power-button').disabled && document.querySelector('.power-button').classList.contains('active')"))break;}check('power_starts_core',(await c.invoke('get_proxy_status')).running);await c.evaluate("document.querySelector('.qc-notice button')?.click()");check('real_payload',(await requestProxy('203.0.113.10','/stage1.1')).includes('SATELITE-VM-LOOPBACK'));pump=setInterval(()=>void requestProxy('203.0.113.10','/measurement').catch(()=>{}),250);await wait(2200);
  }
  for(const theme of ['dark','light']) {
   if(state==='live') await wait(6500);
   await c.evaluate("document.querySelector('.theme-cycle').click()");await wait(100);await c.evaluate(`document.querySelectorAll('.theme-popover button')[${theme==='dark'?0:1}].click()`);await wait(400);
   for(const [width,height] of [[1400,1000],[1000,820],[520,800],[480,480]]) {
    await c.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height}}});await wait(250);await c.evaluate("document.querySelector('.app-content').scrollTo(0,0);document.activeElement?.blur()");
    const layout=await c.evaluate("(()=>{const m=document.querySelector('.app-content');const power=document.querySelector('.power-button').getBoundingClientRect();return {width:innerWidth,height:innerHeight,overflow:m.scrollWidth>m.clientWidth+1,powerBottom:power.bottom,heights:[...document.querySelectorAll('.panel')].map(e=>Math.round(e.getBoundingClientRect().height))}})()");check(`${state}_${theme}_${width}`,!layout.overflow && layout.width===width && layout.height===height && layout.powerBottom<height,layout);
    const name=`${state}-${theme}-${width}x${height}.png`;fs.writeFileSync('C:/Results/'+name,Buffer.from((await c.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));report.screenshots.push(name);
   }
  }
 }

 await c.evaluate("document.querySelectorAll('.status-cell')[2].click()");await wait(150);await c.evaluate("document.querySelectorAll('dialog .modal-choice')[1].click()");await wait(150);await c.evaluate("document.querySelector('dialog .primary-button').click()");for(let i=0;i<40;i++){if((await c.invoke('get_proxy_status')).system_proxy)break;await wait(200);}check('system_proxy_ui_applies',(await c.invoke('get_proxy_status')).system_proxy);
 await wait(1500);await c.evaluate("document.querySelectorAll('.status-cell')[2].click()");await wait(150);await c.evaluate("document.querySelectorAll('dialog .modal-choice')[0].click()");await wait(1500);check('system_proxy_ui_off',!(await c.invoke('get_proxy_status')).system_proxy);
 await c.evaluate("document.querySelector('.power-button').click()");await wait(2500);
 for(const [i,label] of [[0,'Тёмная'],[1,'Светлая'],[2,'Системная']]){await c.evaluate("document.querySelector('.theme-cycle').click()");await wait(100);await c.evaluate(`document.querySelectorAll('.theme-popover button')[${i}].click()`);await wait(350);check('theme_saved_'+i,(await c.invoke('get_settings')).quiet_theme===['dark','light','system'][i]);}
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await wait(200);check('system_dark',await c.evaluate("document.querySelector('.application').dataset.theme==='dark'"));
 await c.call('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await wait(200);check('system_light',await c.evaluate("document.querySelector('.application').dataset.theme==='light'"));
 await c.call('Page.reload');await wait(1200);check('theme_reload',await c.evaluate("document.querySelector('.application').dataset.theme==='light'"));
 for(const label of ['Профили','Узлы','Маршруты','DNS','Статистика','Инструменты','Журнал','Настройки','Главная']) {await c.evaluate(`document.querySelector('button.nav-link[aria-label=${JSON.stringify(label)}]').click()`);await wait(400);check('navigation_'+label,await c.evaluate(`document.querySelector('.nav-link.selected')?.getAttribute('aria-label')===${JSON.stringify(label)}`));}
 check('power_stops_core',!(await c.invoke('get_proxy_status')).running);
 await c.evaluate("document.querySelectorAll('.status-cell')[0].click()");await wait(150);check('core_dialog',await c.evaluate("document.querySelector('dialog')?.open===true"));await c.evaluate("document.querySelectorAll('dialog .modal-choice')[1].click()");await wait(1500);check('core_picker_api',(await c.invoke('get_proxy_status')).core_type==='xray');
 await c.evaluate("document.querySelectorAll('.status-cell')[1].click()");await wait(150);await c.evaluate("document.querySelectorAll('dialog .modal-choice')[2].click()");await wait(150);check('tun_confirmation',await c.evaluate("document.querySelector('dialog')?.innerText.includes('администратора')"));await c.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait(150);check('tun_cancelled',!(await c.invoke('get_proxy_status')).tun_enabled && await c.evaluate("!document.querySelector('dialog')"));

 const custom=await c.invoke('add_subscription_custom',{name:'VM Custom Profile',path:null,content:JSON.stringify({log:{level:'warn'},inbounds:[{type:'mixed',listen:'127.0.0.1',listen_port:32190}],outbounds:[{type:'direct',tag:'direct'}],route:{final:'direct'}})});
 await c.evaluate("document.querySelector('.page-actions .small-action').click()");await wait(1200);await c.evaluate("document.querySelectorAll('.connection-bottom .option-chip')[0].click()");await wait(150);await c.evaluate("document.querySelectorAll('dialog .modal-choice')[1].click()");await wait(1500);check('custom_profile_api',(await c.invoke('get_settings')).runtime_source==='singbox:'+custom.subscription.id);check('custom_server_not_invented',await c.evaluate("document.querySelector('.server-names b').innerText==='Из конфигурации' && document.querySelector('.connection-bottom .option-chip strong').innerText.includes('VM Custom Profile')"));
 await c.evaluate("document.querySelectorAll('.connection-bottom .option-chip')[0].click()");await wait(150);await c.evaluate("document.querySelector('dialog .modal-choice').click()");await wait(1500);check('generated_profile_api',(await c.invoke('get_settings')).runtime_source==='generated');
 report.csp=await c.evaluate('window.__csp ?? []');check('csp',report.csp.length===0);
} catch(e){report.errors.push(String(e.stack??e));}finally {clearInterval(pump);try{await c?.invoke('stop_proxy')}catch{}c?.ws.close();local?.close();fs.writeFileSync('C:/Results/visual-validation.json',JSON.stringify(report,null,2));}
process.exitCode=report.errors.length||report.checks.some(x=>!x.passed)?1:0;
