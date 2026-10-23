import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'test-results');
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const port = Number(process.env.SMOKE_PORT || 5180);
const origin = `http://127.0.0.1:${port}`;
const storageKey = 'momo-browser-preview-v1';

assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'SMOKE_PORT 必须是有效端口');
try {
  await access(path.join(root, 'dist/renderer/index.html'));
  await access(path.join(root, 'dist/main/main.cjs'));
} catch {
  throw new Error('没有完整构建产物，请先运行 npm run build，再运行 npm run test:ui。');
}
await access(chromiumPath).catch(() => {
  throw new Error(`没有找到 Chromium：${chromiumPath}。请设置 CHROMIUM_PATH 指向已安装的浏览器。`);
});
await mkdir(output, { recursive: true });

let browser;
let page;
let server;
let serverOutput = '';
let serverError;
const pageErrors = [];

function recordOutput(data) {
  serverOutput = (serverOutput + data.toString()).slice(-16000);
}

async function startPreview() {
  server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', recordOutput);
  server.stderr.on('data', recordOutput);
  server.on('error', error => { serverError = error; });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Vite preview 启动失败：\n${serverOutput}`);
    // Only connect after our own child reports readiness, so a busy port never
    // silently makes this test exercise another running application's page.
    if (serverOutput.includes(`:${port}/`)) {
      const response = await fetch(origin).catch(() => null);
      if (response?.ok) return;
    }
    await delay(100);
  }
  throw new Error(`等待 Vite preview 超时：\n${serverOutput}`);
}

async function readState() {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), storageKey);
}

async function assertFits() {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert(dimensions.scrollWidth <= dimensions.width && dimensions.scrollHeight <= dimensions.height,
    `页面溢出：${JSON.stringify(dimensions)}`);
}

async function screenshot(name, options = {}) {
  // Let React state updates and layout finish before recording an artifact.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, name), ...options });
}

async function addTask(title, dueAt = '') {
  await page.getByRole('button', { name: '添加任务', exact: true }).click();
  await page.getByLabel('要做什么', { exact: true }).fill(title);
  if (dueAt) await page.locator('input[name="dueAt"]').fill(dueAt);
  await page.getByRole('button', { name: '记下来了', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

try {
  await startPreview();
  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 1080, height: 780 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '留一点时间，给自己。', exact: true }).waitFor();
  await assertFits();
  await screenshot('ui-empty.png', { fullPage: true });

  await page.getByRole('textbox', { name: '告诉慢慢你的安排', exact: true }).fill('10分钟后提醒我喝水');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.task-title').filter({ hasText: /^喝水$/ }).waitFor();
  let state = await readState();
  const water = state.tasks.find(task => task.title === '喝水');
  assert(water && water.status === 'pending', '聊天没有创建真实待办');
  assert(Date.parse(water.dueAt) > Date.now() + 9 * 60000, '相对提醒时间没有正确解析');
  await page.reload();
  await page.locator('.task-title').filter({ hasText: /^喝水$/ }).waitFor();
  assert((await readState()).tasks.some(task => task.id === water.id), '重载后任务丢失');
  console.log('✓ 聊天创建提醒和重载持久化');

  const localDates = await page.evaluate(() => {
    const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const first = new Date(); first.setDate(first.getDate() + 1); first.setHours(9, 30, 0, 0);
    const second = new Date(first); second.setDate(second.getDate() + 1); second.setHours(16, 45, 0, 0);
    return { first: format(first), second: format(second) };
  });
  await addTask('准备会议材料', localDates.first);
  await page.getByRole('tab', { name: '全部待办', exact: true }).click();
  await page.getByRole('button', { name: '修改 准备会议材料', exact: true }).click();
  assert.equal(await page.locator('input[name="dueAt"]').inputValue(), localDates.first, '编辑时发生了时区偏移');
  await page.getByLabel('要做什么', { exact: true }).fill('整理会议材料');
  await page.locator('input[name="dueAt"]').fill(localDates.second);
  await page.getByRole('combobox', { name: /优先级/ }).selectOption('high');
  await page.getByLabel('预计用时（分钟）', { exact: true }).fill('45');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.locator('.task-title').filter({ hasText: /^整理会议材料$/ }).waitFor();
  state = await readState();
  const edited = state.tasks.find(task => task.title === '整理会议材料');
  assert.equal(edited.priority, 'high');
  assert.equal(edited.durationMinutes, 45);
  const editedLocalTime = await page.evaluate(value => {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }, edited.dueAt);
  assert.equal(editedLocalTime, localDates.second, '保存后的提醒时间不是用户输入的本地时间');
  console.log('✓ 手动添加、编辑、优先级、用时及本地时区');

  await addTask('起身走一走');
  // The form intentionally has minute precision. Move this real persisted task
  // 3.5 seconds into the future to test the actual interval without a minute's
  // wait. No timer, reminder implementation, API or assertion is mocked.
  await page.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key));
    const task = saved.tasks.find(item => item.title === '起身走一走');
    task.dueAt = new Date(Date.now() + 3500).toISOString();
    delete task.lastNotifiedAt;
    localStorage.setItem(key, JSON.stringify(saved));
  }, storageKey);
  await page.reload();
  await page.getByRole('heading', { name: '留一点时间，给自己。', exact: true }).waitFor();
  const reminder = page.locator('.reminder-banner').filter({ hasText: '起身走一走' });
  assert.equal(await reminder.count(), 0, '未来任务被过早提醒');
  await reminder.waitFor({ timeout: 12000 });
  state = await readState();
  const dueTask = state.tasks.find(task => task.title === '起身走一走');
  assert(dueTask.lastNotifiedAt, '到点检查没有保存提醒记录');
  assert.equal(state.reminders.filter(item => item.taskId === dueTask.id).length, 1);
  await screenshot('ui-reminder.png', { fullPage: true });
  await reminder.getByRole('button', { name: '稍后 10 分钟', exact: true }).click();
  await reminder.waitFor({ state: 'hidden' });
  state = await readState();
  const snoozed = state.tasks.find(task => task.id === dueTask.id);
  assert(Date.parse(snoozed.dueAt) > Date.now() + 9.8 * 60000, '稍后十分钟没有更新提醒时间');
  assert(!state.reminders.some(item => item.taskId === dueTask.id), '延期后旧提醒未关闭');
  console.log('✓ 真实定时检查、提醒横幅和推迟十分钟');

  await page.getByRole('tab', { name: '全部待办', exact: true }).click();
  await page.getByRole('button', { name: '完成 整理会议材料', exact: true }).click();
  await page.getByRole('tab', { name: '已完成', exact: true }).click();
  await page.locator('.task-title').filter({ hasText: /^整理会议材料$/ }).waitFor();
  await page.getByRole('button', { name: '删除 整理会议材料', exact: true }).click();
  await page.getByRole('button', { name: '移除', exact: true }).click();
  await page.locator('.task-title').filter({ hasText: /^整理会议材料$/ }).waitFor({ state: 'hidden' });
  await page.reload();
  await page.locator('.task-title').filter({ hasText: /^喝水$/ }).waitFor();
  state = await readState();
  assert.equal(state.tasks.length, 2);
  assert(!state.tasks.some(task => task.id === edited.id), '删除结果没有持久化');
  assert(!state.reminders.some(item => item.taskId === dueTask.id), '重载后重复显示已延期提醒');
  console.log('✓ 完成、已完成筛选、确认删除和重载');

  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('switch', { name: '系统通知', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: '系统通知', exact: true }).getAttribute('aria-checked'), 'false');
  await screenshot('ui-settings.png', { fullPage: true });
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await screenshot('ui-main.png', { fullPage: true });
  await page.setViewportSize({ width: 800, height: 650 });
  await assertFits();
  await screenshot('ui-small.png', { fullPage: true });
  console.log('✓ 设置持久化和主面板尺寸适配');

  await page.setViewportSize({ width: 248, height: 330 });
  await page.goto(`${origin}/?view=pet`);
  await page.locator('body.pet-body .pet-desktop').waitFor();
  await page.getByRole('button', { name: '打开慢慢的聊天面板', exact: true }).waitFor();
  const petLayout = await page.evaluate(() => {
    const label = document.querySelector('.pet-task-count').getBoundingClientRect();
    const svg = document.querySelector('.desktop-character').getBoundingClientRect();
    return {
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      labelBottom: label.bottom,
      svgLeft: svg.left,
      svgRight: svg.right,
      characterTop: svg.top,
      characterBottom: svg.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert.equal(petLayout.htmlBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(petLayout.bodyBackground, 'rgba(0, 0, 0, 0)');
  assert(petLayout.labelBottom <= petLayout.height && petLayout.svgLeft >= 0 && petLayout.svgRight <= petLayout.width, '桌宠布局被窗口裁切');
  assert(petLayout.characterTop >= 0 && petLayout.characterBottom <= petLayout.height, '白龙娘的龙角或尾巴超出窗口');
  await screenshot('ui-pet.png', { omitBackground: true });
  assert.deepEqual(pageErrors, [], '页面出现 JavaScript 异常');
  console.log('✓ 透明桌宠布局，无页面 JavaScript 异常');
  console.log(`UI smoke 全部通过，截图已保存到 ${output}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'ui-failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
  if (pageErrors.length) console.error('页面异常：', pageErrors);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
