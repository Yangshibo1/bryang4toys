import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, Tray, dialog, shell } from 'electron';
import path from 'node:path';
import { PetService } from './service';
import { JsonStore } from './store';
import type { SettingsPatch, TaskInput, TaskPatch, UserProfile, MemoryInput } from '../shared/types';

const customDataDirectory = process.env.MIKA_DATA_DIR || process.env.MOMO_DATA_DIR;
if (customDataDirectory) app.setPath('userData', path.resolve(customDataDirectory));
app.setName('Mika');
const developmentUrl = process.env.MIKA_DEV_URL || process.env.MOMO_DEV_URL;
let panel: BrowserWindow;
let pet: BrowserWindow;
let tray: Tray;
let service: PetService;
let quitting = false;

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('momo:state', service.snapshot());
}

function openPanel(): void {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.focus();
}

function showNotification(title: string, body: string): boolean {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title, body, silent: false });
  notification.on('click', openPanel);
  notification.show();
  return true;
}

function checkReminders(): void {
  try {
    const due = service.collectReminders();
    if (!due.length) return;
    broadcast();
    // Also show the pet bubble, even when system notifications are unavailable.
    if (pet && !pet.isDestroyed()) pet.showInactive();
    if (service.store.state.settings.notificationsEnabled) {
      for (const task of due) showNotification('米卡提醒你', task.title);
    }
  } catch (error) {
    console.error('Reminder check failed:', error instanceof Error ? error.message : 'unknown error');
  }
}

function loadView(window: BrowserWindow, view: 'panel' | 'pet'): void {
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    url.searchParams.set('view', view);
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { view } });
  }
}

function createWindows(): void {
  const preload = path.join(__dirname, 'preload.cjs');
  const area = screen.getPrimaryDisplay().workArea;
  panel = new BrowserWindow({
    width: 1120, height: 790, minWidth: 930, minHeight: 660,
    title: '米卡 Mika', backgroundColor: '#faf8f7', show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  panel.on('close', event => {
    if (!quitting) { event.preventDefault(); panel.hide(); }
  });
  panel.once('ready-to-show', () => { panel.show(); });
  panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loadView(panel, 'panel');

  pet = new BrowserWindow({
    width: 248, height: 330, x: area.x + area.width - 268, y: area.y + area.height - 350,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: service.store.state.settings.alwaysOnTop, skipTaskbar: true, show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  if (process.platform === 'darwin') pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pet.once('ready-to-show', () => { pet.showInactive(); });
  pet.on('close', event => { if (!quitting) { event.preventDefault(); pet.hide(); } });
  loadView(pet, 'pet');

  const trayImage = nativeImage.createFromPath(path.join(__dirname, 'assets/trayTemplate.png'));
  trayImage.setTemplateImage(true);
  tray = new Tray(trayImage.resize({ width: 18, height: 18 }));
  tray.setToolTip('米卡 Mika · 今天也一件一件来');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开米卡', click: openPanel },
    { label: '显示小宠物', click: () => pet.showInactive() },
    { label: '隐藏小宠物', click: () => pet.hide() },
    { label: '打开数据文件夹', click: () => { void shell.openPath(app.getPath('userData')); } },
    { type: 'separator' },
    { label: '退出米卡', click: () => app.quit() },
  ]));
  tray.on('click', openPanel);
}

function registerIpc(): void {
  ipcMain.handle('momo:get-state', () => service.snapshot());
  ipcMain.handle('momo:send-message', async (_event, text: string) => {
    if (service.assistantBusy) throw new Error('米卡还在思考，稍等一下再告诉我吧');
    service.assistantBusy = true;
    try {
      const request = service.sendMessage(text);
      broadcast();
      await request;
    }
    finally { service.assistantBusy = false; checkReminders(); broadcast(); }
    return service.snapshot();
  });
  const mutate = (name: string, action: (...args: any[]) => void) => {
    ipcMain.handle(name, (_event, ...args) => {
      action(...args); checkReminders(); broadcast(); return service.snapshot();
    });
  };
  mutate('momo:create-task', (input: TaskInput) => service.createTask(input));
  mutate('momo:update-task', (id: string, patch: TaskPatch) => service.updateTask(id, patch));
  mutate('momo:delete-task', (id: string) => service.deleteTask(id));
  mutate('momo:snooze-task', (id: string, minutes: number) => service.snoozeTask(id, minutes));
  mutate('momo:dismiss-reminder', (id: string) => service.dismissReminder(id));
  mutate('momo:save-settings', (patch: SettingsPatch) => {
    service.saveSettings(patch);
    pet?.setAlwaysOnTop(service.store.state.settings.alwaysOnTop);
  });
  ipcMain.handle('momo:test-ai', (_event, patch?: SettingsPatch) => service.testAiConnection(patch));
  mutate('momo:save-profile', (patch: Partial<UserProfile>) => service.saveProfile(patch));
  mutate('momo:add-memory', (input: MemoryInput) => service.addMemory(input));
  mutate('momo:update-memory', (id: string, input: MemoryInput) => service.updateMemory(id, input));
  mutate('momo:delete-memory', (id: string) => service.deleteMemory(id));
  ipcMain.handle('momo:test-notification', () => ({ supported: showNotification('米卡在这里', '收到啦。到时间，我也会这样提醒你。') }));
  ipcMain.on('momo:open-panel', openPanel);
  ipcMain.on('momo:hide-panel', () => panel.hide());
  ipcMain.on('momo:toggle-panel', () => panel.isVisible() ? panel.hide() : openPanel());
  ipcMain.on('momo:quit', () => app.quit());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openPanel);
  app.whenReady().then(() => {
    try {
      const legacyDirectories = customDataDirectory ? [] : ['慢慢 Momo', 'Momo', 'momo-desk-pet'].map(name => path.join(app.getPath('appData'), name));
      service = new PetService(new JsonStore(app.getPath('userData'), legacyDirectories), process.platform as 'darwin' | 'linux' | 'win32');
      registerIpc();
      createWindows();
      checkReminders();
      const timer = setInterval(checkReminders, 3000);
      app.on('before-quit', () => clearInterval(timer));
      powerMonitor.on('resume', checkReminders);
      app.on('activate', openPanel);
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: '米卡 Mika', submenu: [
          { label: '打开米卡', click: openPanel },
          { label: '显示小宠物', click: () => pet.showInactive() },
          { label: '打开数据文件夹', click: () => { void shell.openPath(app.getPath('userData')); } },
          { type: 'separator' }, { role: 'quit', label: '退出米卡' },
        ] },
        { role: 'editMenu', label: '编辑' },
        { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }] },
      ]));
    } catch (error) {
      dialog.showErrorBox('米卡暂时无法启动', error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* The tray keeps reminders running. */ });
}
