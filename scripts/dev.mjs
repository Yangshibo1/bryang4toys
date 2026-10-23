import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const children = [];
const run = (command, args, options = {}) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.push(child);
  return child;
};
const stop = () => { for (const child of children) child.kill(); };
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
const build = run(process.execPath, ['scripts/build-main.mjs']);
await new Promise((resolve, reject) => build.on('exit', code => code === 0 ? resolve() : reject(new Error('Desktop build failed'))));
const vite = run(process.execPath, ['node_modules/vite/bin/vite.js']);
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try { const response = await fetch('http://127.0.0.1:5173'); if (response.ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) { stop(); throw new Error('Web development server did not start'); }
const require = createRequire(import.meta.url);
const electron = require('electron');
const child = run(electron, ['.'], { env: { ...process.env, MOMO_DEV_URL: 'http://127.0.0.1:5173' } });
child.on('exit', code => { vite.kill(); process.exit(code || 0); });
