import type { AppSnapshot, PetApi, Task, TaskInput, TaskPatch } from './types';
import { interpretLocally } from '../core/assistant';
import { getDueTasks } from '../core/reminders';

const STORAGE_KEY = 'momo-browser-preview-v1';

function browserApi(): PetApi {
  const listeners = new Set<(state: AppSnapshot) => void>();
  const initial = (): AppSnapshot => ({
    tasks: [], reminders: [], platform: 'browser',
    messages: [{ id: 'welcome', role: 'assistant', text: '你好，我是慢慢。把要记住的事情交给我，我们一件一件来。\n\n试试说：“10分钟后提醒我喝水”，或者“记一下买牛奶”。', createdAt: new Date().toISOString() }],
    settings: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyConfigured: false, notificationsEnabled: true, alwaysOnTop: true },
  });
  const load = (): AppSnapshot => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initial();
    const result = JSON.parse(raw) as AppSnapshot;
    return { ...result, platform: 'browser', settings: { ...result.settings, apiKeyConfigured: false } };
  };
  let state = load();
  const save = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const snapshot = structuredClone(state);
    listeners.forEach(listener => listener(snapshot));
    return snapshot;
  };
  const refresh = () => { state = load(); };
  const create = (input: TaskInput) => {
    if (!input.title.trim()) throw new Error('给这件事起个名字吧');
    if (input.dueAt !== null && !Number.isFinite(Date.parse(input.dueAt))) throw new Error('提醒时间无效');
    state.tasks.push({
      id: crypto.randomUUID(), title: input.title.trim(), dueAt: input.dueAt,
      durationMinutes: Math.max(1, Math.min(1440, Number(input.durationMinutes) || 30)),
      priority: input.priority || 'normal', status: 'pending', createdAt: new Date().toISOString(),
    });
  };
  const update = (id: string, patch: TaskPatch) => {
    const task = state.tasks.find(item => item.id === id);
    if (!task) throw new Error('没有找到这件事');
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('任务名称不能为空');
    if (patch.dueAt !== undefined && patch.dueAt !== null && !Number.isFinite(Date.parse(patch.dueAt))) throw new Error('提醒时间无效');
    Object.assign(task, patch);
    if (patch.status === 'completed') task.completedAt = new Date().toISOString();
    if (patch.dueAt !== undefined || patch.status === 'pending') delete task.lastNotifiedAt;
    if (patch.dueAt !== undefined || patch.status === 'completed') state.reminders = state.reminders.filter(item => item.taskId !== id);
  };
  const snooze = (id: string, minutes: number) => {
    update(id, { dueAt: new Date(Date.now() + minutes * 60000).toISOString(), status: 'pending' });
  };
  const notify = (title: string) => {
    if ('Notification' in window && Notification.permission === 'granted') new Notification('慢慢提醒你', { body: title });
  };
  const check = () => {
    refresh();
    const due = getDueTasks(state.tasks);
    if (!due.length) return;
    for (const task of due) {
      task.lastNotifiedAt = new Date().toISOString();
      if (!state.reminders.some(item => item.taskId === task.id)) state.reminders.push({ taskId: task.id, title: task.title, dueAt: task.dueAt! });
      if (state.settings.notificationsEnabled) notify(task.title);
    }
    save();
  };
  window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) { refresh(); listeners.forEach(listener => listener(structuredClone(state))); } });
  window.setInterval(check, 3000);
  return {
    async getState() { refresh(); check(); return structuredClone(state); },
    async sendMessage(raw) {
      refresh();
      const text = raw.trim();
      if (!text) return structuredClone(state);
      const result = interpretLocally(text, state.tasks);
      for (const input of result.create || []) create(input);
      for (const id of result.completeIds || []) update(id, { status: 'completed' });
      for (const item of result.snooze || []) snooze(item.id, item.minutes);
      state.messages.push(
        { id: crypto.randomUUID(), role: 'user', text, createdAt: new Date().toISOString() },
        { id: crypto.randomUUID(), role: 'assistant', text: result.reply, createdAt: new Date().toISOString() },
      );
      state.messages = state.messages.slice(-300);
      return save();
    },
    async createTask(input) { refresh(); create(input); save(); check(); return structuredClone(state); },
    async updateTask(id, patch) { refresh(); update(id, patch); return save(); },
    async deleteTask(id) { refresh(); state.tasks = state.tasks.filter(task => task.id !== id); state.reminders = state.reminders.filter(item => item.taskId !== id); return save(); },
    async snoozeTask(id, minutes) { refresh(); snooze(id, minutes); return save(); },
    async dismissReminder(id) { refresh(); state.reminders = state.reminders.filter(item => item.taskId !== id); return save(); },
    async saveSettings(patch) {
      refresh();
      if (patch.apiKey) throw new Error('网页预览支持本地记事，AI 接口请在桌面客户端配置。');
      const { apiKey: _key, ...settings } = patch;
      Object.assign(state.settings, settings, { apiKeyConfigured: false });
      return save();
    },
    async testNotification() {
      if (!('Notification' in window)) return { supported: false };
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return { supported: false };
      notify('收到啦。到时间，我也会这样提醒你。');
      return { supported: true };
    },
    openPanel() { if (new URLSearchParams(location.search).get('view') === 'pet') window.open(location.pathname, 'momo-panel'); },
    togglePanel() { this.openPanel(); },
    hidePanel() {},
    quit() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const api: PetApi = window.petApi || browserApi();
