// Focused regression for the UI -> batched settings -> durable store seam.
import fs from 'node:fs';
import { connect, wait } from './cdp.mjs';
const report = { phase: 'quiet-theme-focused-regression', checks: [], errors: [] };
let c;
try {
  c = await connect(); await wait(800);
  for (const preference of ['system', 'light', 'dark']) {
    await c.evaluate(`(()=>{const s=document.querySelector('.qc-header-actions select');s.value=${JSON.stringify(preference)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(700);
    const actual = (await c.invoke('get_settings')).quiet_theme;
    report.checks.push({ name: 'ui_persists_' + preference, passed: actual === preference, actual });
  }
  await c.invoke('update_settings', { quietTheme: 'invalid' });
  report.checks.push({ name: 'invalid_preserves_dark', passed: (await c.invoke('get_settings')).quiet_theme === 'dark' });
} catch (error) { report.errors.push(String(error.stack ?? error)); }
finally { c?.ws.close(); fs.writeFileSync('C:/Results/validation.json', JSON.stringify(report, null, 2)); }
process.exitCode = report.errors.length || report.checks.some(c => !c.passed) ? 1 : 0;
