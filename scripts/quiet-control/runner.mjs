// Run ONLY inside the disposable Windows Sandbox. All paths are guest paths.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, wait } from './cdp.mjs';
const out = 'C:/Results';
try {
  try { execFileSync('taskkill.exe', ['/F', '/IM', 'satelite-proxy.exe'], { stdio: 'ignore' }); } catch {}
  if (!fs.existsSync('C:/Research/portable.flag')) {
    fs.mkdirSync('C:/Unpacked', { recursive: true });
    const archive = process.argv.includes('--final') ? 'Satelite-Quiet-Control-stage1-win-x64-portable.zip' : 'Satelite-Research-1.0.46-runtime0.5-win-x64-portable.zip';
    execFileSync('tar.exe', ['-xf', 'C:/Distribution/' + archive, '-C', 'C:/Unpacked']);
    fs.renameSync('C:/Unpacked/Satelite-Research', 'C:/Research');
  }
  if (!process.argv.includes('--final')) fs.copyFileSync('C:/Build/satelite-proxy.exe', 'C:/Research/satelite-proxy.exe');
  const hash = createHash('sha256').update(fs.readFileSync('C:/Research/satelite-proxy.exe')).digest('hex');
  fs.writeFileSync(out + '/tested-exe-sha256.txt', hash);
  const app = spawn('C:/Research/satelite-proxy.exe', [], { cwd: 'C:/Research', env: { ...process.env, SATELITE_TEST_CDP_PORT: '9222' }, stdio: ['ignore', fs.openSync(out + '/app-stdout.log', 'w'), fs.openSync(out + '/app-stderr.log', 'w')] });
  fs.writeFileSync(out + '/app-pid.txt', String(app.pid)); app.unref();
  await import('./' + (process.argv.includes('--inspect') ? 'inspect.mjs' : process.argv.includes('--preferences') ? 'preferences.mjs' : 'validate.mjs'));
  if (!process.exitCode && !process.argv.includes('--inspect')) {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' }); await wait(800);
    const again = spawn('C:/Research/satelite-proxy.exe', [], { cwd: 'C:/Research', env: { ...process.env, SATELITE_TEST_CDP_PORT: '9222' }, stdio: 'ignore' }); again.unref();
    const c = await connect(); await wait(900);
    const report = JSON.parse(fs.readFileSync(out + '/validation.json', 'utf8'));
    report.checks.push({ name: 'theme_persisted_after_process_restart', passed: await c.evaluate("document.documentElement.dataset.qcTheme==='dark' && document.querySelector('.qc-header-actions select').value==='dark'") });
    report.checks.push({ name: 'restart_no_auto_connect', passed: !(await c.invoke('get_proxy_status')).running });
    c.ws.close(); execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(again.pid)], { stdio: 'ignore' }); await wait(800);
    const normal = spawn('C:/Research/satelite-proxy.exe', [], { cwd: 'C:/Research', env: { ...process.env }, stdio: 'ignore' }); normal.unref(); await wait(1800);
    let debugOpen = false; try { debugOpen = (await fetch('http://127.0.0.1:9222/json/list')).ok; } catch {}
    report.checks.push({ name: 'normal_launch_no_debug_port', passed: normal.exitCode === null && !debugOpen });
    fs.writeFileSync(out + '/validation.json', JSON.stringify(report, null, 2));
    process.exitCode = report.checks.some(c => !c.passed) ? 1 : 0;
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(normal.pid)], { stdio: 'ignore' });
  }
} catch (e) { fs.writeFileSync(out + '/runner-error.txt', String(e.stack ?? e)); process.exitCode = 1; }
