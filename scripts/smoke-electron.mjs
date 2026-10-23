import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';

const require = createRequire(import.meta.url);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'momo-electron-'));
const failures = [];
let app;
let modelServer;
let releaseModel = () => {};

async function launch() {
  const instance = await electron.launch({
    executablePath: require('electron'),
    args: [...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []), '.'],
    cwd: process.cwd(), timeout: 30_000,
    env: { ...process.env, MOMO_DATA_DIR: dataDir, MOMO_DEV_URL: '' },
  });
  app = instance;
  instance.on('window', win => win.on('pageerror', error => failures.push(error.message)));
  await instance.firstWindow();
  let panel;
  for (let attempt = 0; attempt < 100; attempt++) {
    panel = instance.windows().find(win => win.url().includes('view=panel'));
    if (panel) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!panel) throw new Error(`Panel not found: ${instance.windows().map(win => win.url()).join(', ')}`);
  await panel.waitForFunction(() => Boolean(window.petApi));
  await panel.getByRole('heading', { name: '留一点时间，给自己。' }).waitFor();
  return { instance, panel };
}

try {
  let launched = await launch();
  app = launched.instance;
  let panel = launched.panel;
  assert.equal((await panel.evaluate(() => window.petApi.getState())).platform, process.platform);
  await panel.getByRole('textbox', { name: '告诉慢慢你的安排' }).fill('3秒后提醒我喝水');
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).waitFor();
  const initial = await panel.evaluate(() => window.petApi.getState());
  const id = initial.tasks[0].id;
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('view=panel'));
    window.close();
  });
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('view=panel')).isVisible()), false);
  await panel.locator('.reminder-banner').waitFor({ state: 'attached', timeout: 12_000 });
  const reminded = await panel.evaluate(() => window.petApi.getState());
  assert.equal(reminded.reminders[0].taskId, id);
  assert.ok(reminded.tasks[0].lastNotifiedAt);
  await panel.evaluate(() => window.petApi.openPanel());
  await panel.locator('.reminder-banner').waitFor();
  await fs.mkdir('test-results', { recursive: true });
  await panel.screenshot({ path: 'test-results/desktop-reminder.png' });
  await app.close(); app = null;

  launched = await launch();
  app = launched.instance; panel = launched.panel;
  const restored = await panel.evaluate(() => window.petApi.getState());
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0].id, id);
  assert.equal(restored.tasks[0].lastNotifiedAt, reminded.tasks[0].lastNotifiedAt);
  assert.equal(restored.reminders.length, 1);
  await panel.getByRole('button', { name: '稍后 10 分钟', exact: true }).click();
  await panel.locator('.reminder-banner').waitFor({ state: 'detached' });
  const snoozed = await panel.evaluate(() => window.petApi.getState());
  assert.ok(Date.parse(snoozed.tasks[0].dueAt) > Date.now() + 9 * 60_000);
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).click();
  await panel.getByRole('button', { name: '完成 喝水', exact: true }).waitFor({ state: 'detached' });
  assert.equal((await panel.evaluate(() => window.petApi.getState())).tasks[0].status, 'completed');
  await panel.evaluate(() => window.petApi.saveSettings({ apiKey: 'ipc-test-key' }));
  assert.equal(JSON.stringify(await panel.evaluate(() => window.petApi.getState())).includes('ipc-test-key'), false);
  const pet = app.windows().find(win => win.url().includes('view=pet'));
  assert.ok(pet, 'desktop pet window exists');
  await pet.locator('.pet-character-button').waitFor();
  await pet.screenshot({ path: 'test-results/desktop-pet.png', omitBackground: true });

  let receivedModel;
  const modelRequested = new Promise(resolve => { receivedModel = resolve; });
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  modelServer = http.createServer(async (_req, res) => {
    receivedModel();
    await modelGate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '今天的事情已经完成，休息一下吧。', actions: [] }) } }] }));
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const { port } = modelServer.address();
  await panel.evaluate(baseUrl => window.petApi.saveSettings({ baseUrl, apiKey: 'local-fixture-key', model: 'fixture' }), `http://127.0.0.1:${port}/v1`);
  const replyPending = panel.evaluate(() => window.petApi.sendMessage('帮我安排今天'));
  replyPending.catch(() => {});
  await modelRequested;
  await pet.locator('.momo-pet[data-state="thinking"]').waitFor();
  assert.equal((await panel.evaluate(() => window.petApi.getState())).assistantBusy, true);
  await pet.screenshot({ path: 'test-results/desktop-thinking.png', omitBackground: true });
  releaseModel();
  await replyPending;
  await pet.locator('.momo-pet[data-state="idle"]').waitFor();
  await pet.screenshot({ path: 'test-results/desktop-idle.png', omitBackground: true });
  assert.equal((await panel.evaluate(() => window.petApi.getState())).assistantBusy, false);
  assert.deepEqual(failures, []);
  console.log('Desktop smoke passed: actual Electron IPC, closed-panel reminders, restart persistence, deduplication, snooze, complete, dragon pet, and shared AI thinking state.');
} finally {
  releaseModel();
  if (modelServer) { modelServer.closeAllConnections(); modelServer.close(); }
  if (app) await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
