import type { AppSnapshot, PetApi, Task, TaskInput, TaskPatch, UserProfile, MemoryInput, MemoryCategory } from './types';
import { interpretLocally } from '../core/assistant';
import { getDueTasks } from '../core/reminders';

const STORAGE_KEY = 'mika-browser-preview-v2';
const LEGACY_STORAGE_KEY = 'momo-browser-preview-v1';
const blankProfile = (): UserProfile => ({ name: '', role: '', about: '', goals: '', preferences: '', routine: '', assistantStyle: '自然、真诚、简洁；需要时给出具体建议。' });

function browserApi(): PetApi {
  const listeners = new Set<(state: AppSnapshot) => void>();
  const initial = (): AppSnapshot => ({
    tasks: [], reminders: [], platform: 'browser', profile: blankProfile(), memories: [],
    messages: [{ id: 'welcome', role: 'assistant', text: '你好，我是米卡 Mika，你的私人 AI 助手。\n\n先在设置里连接模型，再告诉我你的目标、习惯和偏好。我会结合画像和长期记忆，和你一起想办法。当前网页预览提供离线记事与画像、记忆管理。', createdAt: new Date().toISOString() }],
    settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', protocol: 'chat-completions', memoryEnabled: true, apiKeyConfigured: false, notificationsEnabled: true, alwaysOnTop: true },
  });
  const load = (): AppSnapshot => {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return initial();
    const result = JSON.parse(raw) as AppSnapshot;
    const normalized: AppSnapshot = {
      ...result, profile: { ...blankProfile(), ...result.profile }, memories: result.memories || [],
      platform: 'browser', settings: { ...initial().settings, ...result.settings, apiKeyConfigured: false },
    };
    if (!localStorage.getItem(STORAGE_KEY)) localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
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
    if ('Notification' in window && Notification.permission === 'granted') new Notification('米卡提醒你', { body: title });
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
  const memoryData = (input: MemoryInput) => {
    if (!input.content?.trim()) throw new Error('请填写要记住的内容');
    if (input.content.length > 4000) throw new Error('一条记忆请控制在 4000 字以内');
    const category = input.category || 'other';
    if (!['preference', 'background', 'goal', 'routine', 'other'].includes(category)) throw new Error('记忆分类无效');
    return { content: input.content.trim(), category: category as MemoryCategory };
  };
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
        { id: crypto.randomUUID(), role: 'assistant', text: `（当前未连接 AI，以下是离线记事结果。）\n${result.reply}\n\n请在桌面客户端设置中连接模型，开启米卡的个性化对话。`, createdAt: new Date().toISOString() },
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
      if (settings.baseUrl !== undefined && !['http:', 'https:'].includes(new URL(settings.baseUrl).protocol)) throw new Error('请输入有效的接口地址');
      if (settings.model !== undefined && !settings.model.trim()) throw new Error('模型名称不能为空');
      Object.assign(state.settings, settings, { apiKeyConfigured: false });
      return save();
    },
    async testAiConnection(patch) {
      return { ok: false, model: patch?.model || state.settings.model, latencyMs: 0, message: '网页预览仅支持离线功能，请在桌面客户端中配置并测试 AI 接口。' };
    },
    async saveProfile(patch) {
      refresh();
      const next = { ...state.profile };
      for (const key of Object.keys(next) as (keyof UserProfile)[]) {
        if (patch[key] === undefined) continue;
        if (typeof patch[key] !== 'string' || patch[key]!.length > 6000) throw new Error('画像字段请使用 6000 字以内的文字');
        next[key] = patch[key]!.trim();
      }
      state.profile = next;
      return save();
    },
    async addMemory(input) {
      refresh();
      const data = memoryData(input);
      if (!state.memories.some(memory => memory.content.replace(/\s+/g, '') === data.content.replace(/\s+/g, ''))) {
        const now = new Date().toISOString();
        state.memories.push({ ...data, id: crypto.randomUUID(), source: 'manual', createdAt: now, updatedAt: now });
      }
      return save();
    },
    async updateMemory(id, input) {
      refresh();
      const memory = state.memories.find(item => item.id === id);
      if (!memory) throw new Error('这条记忆已不存在');
      Object.assign(memory, memoryData({ ...input, category: input.category || memory.category }), { source: 'manual', updatedAt: new Date().toISOString() });
      return save();
    },
    async deleteMemory(id) { refresh(); state.memories = state.memories.filter(memory => memory.id !== id); return save(); },
    async testNotification() {
      if (!('Notification' in window)) return { supported: false };
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return { supported: false };
      notify('收到啦。到时间，我也会这样提醒你。');
      return { supported: true };
    },
    openPanel() { if (new URLSearchParams(location.search).get('view') === 'pet') window.open(location.pathname, 'mika-panel'); },
    togglePanel() { this.openPanel(); },
    hidePanel() {},
    quit() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const api: PetApi = window.petApi || browserApi();
