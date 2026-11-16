import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { connect, wait } from './cdp.mjs';
import { services, requestProxy } from './local-services.mjs';
const report = { phase: 'quiet-control-native-sandbox', checks: [], errors: [], screenshots: [], sizes: [] };
const out = 'C:/Results';
const check = (name, passed, details) => { report.checks.push({ name, passed: Boolean(passed), details }); };
const snapshot = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer;override=$p.ProxyOverride}|ConvertTo-Json -Compress"], { encoding: 'utf8' }).trim();
let c, local, pump;
try {
  local = await services(); c = await connect();
  c.ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') report.errors.push(m.params.exceptionDetails.text); });
  await c.call('Runtime.enable');
  await c.call('Page.addScriptToEvaluateOnNewDocument', { source: "window.__qcViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__qcViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}));" });
  await c.call('Page.reload'); await wait(1800);
  const click = expression => c.evaluate(`(()=>{const b=${expression};if(!b)throw Error('Control missing');b.click();return true;})()`);
  const nav = async label => { await click(`document.querySelector('button.qc-nav-item[aria-label=${JSON.stringify(label)}]')`); await wait(500); };
  const select = async (label, value) => { await c.evaluate(`(()=>{const l=Array.from(document.querySelectorAll('.qc-field')).find(l=>l.querySelector('span')?.textContent===${JSON.stringify(label)});const s=l?.querySelector('select');if(!s)throw Error('Select missing');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(700); };
  const until = async (expression, attempts = 30) => { for (let i = 0; i < attempts; i++) { if (await c.evaluate(expression)) return true; await wait(200); } return false; };
  const resize = async (width, height) => { await c.invoke('plugin:window|set_size', { label: 'main', value: { Logical: { width, height } } }); await wait(300); const actual = await c.evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})'); report.sizes.push({ requested: { width, height }, actual }); return actual; };
  const shot = async name => { await c.evaluate("document.activeElement?.blur();document.querySelector('.qc-main').scrollTo(0,0)"); await wait(200); fs.writeFileSync(out + '/' + name + '.png', Buffer.from((await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64')); report.screenshots.push(name + '.png'); };
  const overflow = () => c.evaluate(`(()=>{const m=document.querySelector('.qc-main');return {document:document.documentElement.scrollWidth>innerWidth+1,main:m.scrollWidth>m.clientWidth+1,mainScroll:m.scrollHeight>m.clientHeight};})()`);
  report.proxyBefore = snapshot();
  const initial = await c.invoke('get_proxy_status');
  check('startup_no_auto_connect', !initial.running && !initial.system_proxy && !initial.tun_enabled, initial);
  check('default_CDP_opt_in_only', process.env.SATELITE_TEST_CDP_PORT === undefined);
  for (const kind of ['singbox', 'xray', 'mihomo']) { const core = await c.invoke('get_core_info', { kind }); check('inventory_' + kind, core.installed, core.version); }
  await resize(1400, 1000); await select('Тема оформления', 'dark'); await shot('dark-empty');
  check('empty_connect_disabled', await c.evaluate("document.querySelector('.qc-connect-actions button').disabled"));
  for (const label of ['Профили', 'Узлы', 'Маршрутизация', 'DNS', 'Трафик', 'Инструменты', 'Журнал', 'Настройки']) {
    await nav(label); check('navigation_' + label, await c.evaluate(`document.querySelector('.qc-nav-item[aria-current=page]')?.getAttribute('aria-label')===${JSON.stringify(label)} && document.querySelector('.qc-main').innerText.length>20`));
  }
  await nav('Главная');
  await select('Тема оформления', 'system');
  check('system_preference_saved_in_store', (await c.invoke('get_settings')).quiet_theme === 'system');
  await c.invoke('update_settings', { quietTheme: 'not-a-theme' });
  check('invalid_theme_preserves_preference', (await c.invoke('get_settings')).quiet_theme === 'system');
  for (const theme of ['dark', 'light']) { await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }); await wait(200); check('system_live_' + theme, await c.evaluate(`document.documentElement.dataset.qcTheme===${JSON.stringify(theme)}`)); }
  await select('Тема оформления', 'light'); await c.call('Page.reload'); await wait(1000);
  check('theme_persisted_after_reload', await c.evaluate("document.documentElement.dataset.qcTheme==='light' && document.querySelector('.qc-header-actions select').value==='light'"));
  const imported = await c.invoke('add_subscription_text', { name: 'Локальная проверка · Sandbox', content: 'socks5://127.0.0.1:32191#' + encodeURIComponent('Локальный SOCKS · изолированная среда · длинное имя для проверки компоновки') });
  const nodes = await c.invoke('list_subscription_nodes', { id: imported.subscription.id }); check('real_fixture_import', nodes.length === 1);
  await c.invoke('update_settings', { mixedPort: 32189, apiPort: 39090, bypassLan: false, locale: 'en' });
  await c.invoke('set_current_node', { nodeId: nodes[0].id });
  await nav('Узлы'); await nav('Главная');
  check('real_node_visible', await c.evaluate("document.querySelector('.qc-node-copy strong')?.textContent.includes('Локальный SOCKS')"));
  await select('Маршрутизация', 'global');
  await click("document.querySelector('.qc-connect-actions button')");
  check('connect_button_starts_core', await until("document.querySelector('.qc-connect-actions button')?.textContent.includes('Отключить')"), await c.invoke('get_proxy_status'));
  const response = await requestProxy('203.0.113.10', '/quiet-control');
  check('actual_proxy_payload', response.includes('SATELITE-VM-LOOPBACK /quiet-control'));
  pump = setInterval(() => { void requestProxy('203.0.113.10', '/ui-measurement').catch(() => {}); }, 150);
  await wait(2200);
  await click("document.querySelector('.qc-notice button')");
  check('actual_samples_rendered', await c.evaluate("document.querySelectorAll('.qc-chart polyline').length===2"));
  for (const theme of ['dark', 'light']) {
    await select('Тема оформления', theme);
    for (const [label, width, height] of [['wide', 1400, 1000], ['medium', 1000, 820], ['narrow', 520, 800]]) {
      const actual = await resize(width, height);
      const layout = await overflow();
      const columns = await c.evaluate("getComputedStyle(document.querySelector('.qc-dashboard')).gridTemplateColumns");
      check(`${theme}_${label}_no_horizontal_overflow`, !layout.document && !layout.main, { actual, layout, columns });
      check(`${theme}_${label}_native_window_size`, actual.width === width && actual.height === height, actual);
      await shot(`${theme}-${label}`);
      if (label === 'narrow') {
        await c.evaluate("document.querySelector('.qc-main').scrollTo(0,100000)"); await wait(200);
        fs.writeFileSync(out + '/' + theme + '-narrow-bottom.png', Buffer.from((await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
        check(`${theme}_narrow_bottom_reachable`, await c.evaluate("document.querySelector('.qc-summary').getBoundingClientRect().bottom <= innerHeight+1"));
      }
    }
  }
  await resize(480, 480);
  check('minimum_window_navigation_reachable', await c.evaluate("document.querySelector('.qc-nav-item[aria-label=Настройки]').getBoundingClientRect().bottom <= innerHeight"));
  const minimumLayout = await overflow(); check('minimum_window_no_horizontal_overflow', !minimumLayout.document && !minimumLayout.main, minimumLayout);
  await resize(1000, 820);
  for (const factor of [1.25, 1.5]) {
    await c.call('Emulation.setDeviceMetricsOverride', { width: Math.round(1000 / factor), height: Math.round(820 / factor), deviceScaleFactor: factor, mobile: false }); await wait(200);
    const layout = await overflow(); check('emulated_DPI_' + factor, !layout.document && !layout.main, layout);
  }
  await c.call('Emulation.clearDeviceMetricsOverride');
  await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced_motion', await c.evaluate("getComputedStyle(document.querySelector('.qc-dashboard')).animationName==='none'"));
  await resize(1000, 820);
  await select('Захват трафика', 'system');
  check('capture_confirmation', await c.evaluate("document.querySelector('dialog')?.open===true"));
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(200);
  check('escape_cancels_without_proxy_change', !(await c.invoke('get_proxy_status')).system_proxy && await c.evaluate("!document.querySelector('dialog')"));
  await select('Захват трафика', 'system');
  await click("document.querySelector('dialog button.qc-primary')");
  check('ui_system_proxy_applied', await until("document.querySelector('.qc-system').innerText.includes('Включён')"), snapshot());
  await select('Захват трафика', 'off');
  check('ui_system_proxy_restored', snapshot() === report.proxyBefore, { before: report.proxyBefore, after: snapshot() });
  await select('Захват трафика', 'tun');
  check('tun_explicit_confirmation', await c.evaluate("document.querySelector('dialog')?.open && document.querySelector('dialog').innerText.includes('администратора')"));
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await click("document.querySelector('.qc-connect-actions button')");
  check('disconnect_button_stops_core', await until("document.querySelector('.qc-connect-actions button')?.textContent.trim()==='Подключить'"), await c.invoke('get_proxy_status'));
  clearInterval(pump); pump = undefined;
  for (const kind of ['xray', 'mihomo', 'singbox']) { await select('Сетевое ядро', kind); check('ui_core_switch_' + kind, (await c.invoke('get_proxy_status')).core_type === kind); }
  const occupied = net.createServer(socket => socket.end('foreign test owner'));
  await new Promise(resolve => occupied.listen(32189, '127.0.0.1', resolve));
  await click("document.querySelector('.qc-connect-actions button')");
  check('real_start_error_visible', await until("Boolean(document.querySelector('.qc-main [role=alert]'))"));
  check('foreign_port_owner_preserved', occupied.listening);
  await new Promise(resolve => occupied.close(resolve));
  const custom = await c.invoke('add_subscription_custom', { name: 'Локальная конфигурация · проверка выбора', path: null, content: JSON.stringify({ log: { level: 'warn' }, inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 32189 }], outbounds: [{ type: 'direct', tag: 'direct' }], route: { final: 'direct' } }) });
  await nav('Профили'); await nav('Главная');
  await c.evaluate(`(()=>{const s=document.querySelector('.qc-profile-select');s.value=${JSON.stringify('singbox:' + custom.subscription.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await wait(800);
  check('ui_custom_profile_selection', (await c.invoke('get_settings')).runtime_source === 'singbox:' + custom.subscription.id);
  await c.evaluate("(()=>{const s=document.querySelector('.qc-profile-select');s.value='generated';s.dispatchEvent(new Event('change',{bubbles:true}));})()"); await wait(800);
  check('ui_generated_profile_selection', (await c.invoke('get_settings')).runtime_source === 'generated');
  await resize(520, 800);
  for (const label of ['Профили', 'Узлы', 'Маршрутизация', 'DNS', 'Трафик', 'Инструменты', 'Журнал', 'Настройки']) {
    await nav(label); const layout = await overflow(); check('narrow_navigation_' + label, !layout.document && !layout.main, layout);
  }
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: '3', code: 'Digit3', modifiers: 2, windowsVirtualKeyCode: 51 }); await wait(300);
  check('keyboard_navigation', await c.evaluate("document.querySelector('.qc-nav-item[aria-current=page]').getAttribute('aria-label')==='Узлы'"));
  await nav('Главная');
  report.csp = await c.evaluate('window.__qcViolations ?? []'); check('no_csp_violations', report.csp.length === 0, report.csp);
  report.proxyAfter = snapshot(); check('final_proxy_unchanged', report.proxyAfter === report.proxyBefore);
  report.socksRequests = local.observed.length;
  report.exeSha256 = fs.readFileSync(out + '/tested-exe-sha256.txt', 'utf8');
  await select('Тема оформления', 'dark');
  check('dark_preference_saved_in_store', (await c.invoke('get_settings')).quiet_theme === 'dark');
} catch (e) { report.errors.push(String(e.stack ?? e)); }
finally {
  clearInterval(pump); try { await c?.invoke('stop_proxy'); } catch {}
  c?.ws.close(); local?.close();
  fs.writeFileSync(out + '/validation.json', JSON.stringify(report, null, 2));
}
process.exitCode = report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0;
