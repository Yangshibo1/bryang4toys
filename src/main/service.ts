import { randomUUID } from 'node:crypto';
import type { AppSnapshot, SettingsPatch, Task, TaskInput, TaskPatch, UserProfile, MemoryInput, PersonalMemory, MemoryCategory } from '../shared/types';
import { interpretLocally } from '../core/assistant';
import { getDueTasks } from '../core/reminders';
import { askAi, testAiConnection, type AiAction, type AiMemoryAction } from './ai';
import { JsonStore, type SavedSettings } from './store';

export class PetService {
  assistantBusy = false;
  constructor(readonly store: JsonStore, readonly platform: AppSnapshot['platform']) {}

  snapshot(): AppSnapshot {
    const { apiKey, ...settings } = this.store.state.settings;
    return structuredClone({ ...this.store.state, settings: { ...settings, apiKeyConfigured: Boolean(apiKey) }, platform: this.platform, assistantBusy: this.assistantBusy });
  }

  createTask(input: TaskInput): Task {
    const title = input.title?.trim();
    if (!title) throw new Error('给这件事起个名字吧');
    if (input.dueAt !== null && !Number.isFinite(Date.parse(input.dueAt))) throw new Error('请选择有效的提醒时间');
    const task: Task = {
      id: randomUUID(), title: title.slice(0, 500), dueAt: input.dueAt,
      durationMinutes: Math.max(1, Math.min(1440, Number(input.durationMinutes) || 30)),
      priority: ['high', 'normal', 'low'].includes(input.priority || '') ? input.priority! : 'normal',
      status: 'pending', createdAt: new Date().toISOString(),
    };
    this.store.state.tasks.push(task);
    this.store.save();
    return task;
  }

  updateTask(id: string, patch: TaskPatch): void {
    const task = this.store.state.tasks.find(item => item.id === id);
    if (!task) throw new Error('没有找到这件事');
    if (patch.title !== undefined && !patch.title.trim()) throw new Error('任务名称不能为空');
    if (patch.dueAt !== undefined && patch.dueAt !== null && !Number.isFinite(Date.parse(patch.dueAt))) throw new Error('提醒时间无效');
    if (patch.title !== undefined) {
      task.title = patch.title.trim().slice(0, 500);
    }
    if (patch.dueAt !== undefined) {
      task.dueAt = patch.dueAt;
      delete task.lastNotifiedAt;
      this.store.state.reminders = this.store.state.reminders.filter(item => item.taskId !== id);
    }
    if (patch.priority !== undefined && ['high', 'normal', 'low'].includes(patch.priority)) task.priority = patch.priority;
    if (patch.durationMinutes !== undefined) task.durationMinutes = Math.max(1, Math.min(1440, Number(patch.durationMinutes) || 30));
    if (patch.status === 'completed') {
      task.status = 'completed';
      task.completedAt = new Date().toISOString();
      this.store.state.reminders = this.store.state.reminders.filter(item => item.taskId !== id);
    } else if (patch.status === 'pending') {
      task.status = 'pending';
      delete task.completedAt;
      delete task.lastNotifiedAt;
    }
    this.store.save();
  }

  deleteTask(id: string): void {
    this.store.state.tasks = this.store.state.tasks.filter(task => task.id !== id);
    this.store.state.reminders = this.store.state.reminders.filter(item => item.taskId !== id);
    this.store.save();
  }

  snoozeTask(id: string, minutes: number, now = new Date()): void {
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10080) throw new Error('请选择合理的推迟时间');
    this.updateTask(id, { dueAt: new Date(now.getTime() + minutes * 60_000).toISOString(), status: 'pending' });
  }

  dismissReminder(id: string): void {
    this.store.state.reminders = this.store.state.reminders.filter(item => item.taskId !== id);
    this.store.save();
  }

  collectReminders(now = new Date()): Task[] {
    const tasks = getDueTasks(this.store.state.tasks, now);
    if (!tasks.length) return [];
    for (const task of tasks) {
      task.lastNotifiedAt = now.toISOString();
      if (!this.store.state.reminders.some(item => item.taskId === task.id)) {
        this.store.state.reminders.push({ taskId: task.id, title: task.title, dueAt: task.dueAt! });
      }
    }
    this.store.save();
    return tasks;
  }

  saveSettings(patch: SettingsPatch): void {
    this.store.state.settings = this.settingsCandidate(patch);
    this.store.save();
  }

  private settingsCandidate(patch: SettingsPatch): SavedSettings {
    const next = { ...this.store.state.settings };
    if (patch.model !== undefined && !patch.model.trim()) throw new Error('模型名称不能为空');
    if (patch.baseUrl !== undefined) {
      const url = new URL(patch.baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入有效的接口地址');
      next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    }
    if (patch.model !== undefined) {
      next.model = patch.model.trim();
    }
    if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim();
    if (patch.alwaysOnTop !== undefined) next.alwaysOnTop = Boolean(patch.alwaysOnTop);
    if (patch.notificationsEnabled !== undefined) next.notificationsEnabled = Boolean(patch.notificationsEnabled);
    if (patch.memoryEnabled !== undefined) next.memoryEnabled = Boolean(patch.memoryEnabled);
    if (patch.protocol !== undefined) {
      if (!['chat-completions', 'responses'].includes(patch.protocol)) throw new Error('请选择有效的接口协议');
      next.protocol = patch.protocol;
    }
    next.apiKeyConfigured = Boolean(next.apiKey);
    return next;
  }

  async testAiConnection(patch: SettingsPatch = {}) {
    return testAiConnection(this.settingsCandidate(patch));
  }

  saveProfile(patch: Partial<UserProfile>): void {
    const next = { ...this.store.state.profile };
    for (const key of Object.keys(next) as (keyof UserProfile)[]) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'string' || patch[key]!.length > 6000) throw new Error('画像字段请使用 6000 字以内的文字');
      next[key] = patch[key]!.trim();
    }
    this.store.state.profile = next;
    this.store.save();
  }

  private memoryContent(input: MemoryInput): { content: string; category: MemoryCategory } {
    if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('请填写要记住的内容');
    if (input.content.length > 4000) throw new Error('一条记忆请控制在 4000 字以内');
    const category = input.category || 'other';
    if (!['preference', 'background', 'goal', 'routine', 'other'].includes(category)) throw new Error('记忆分类无效');
    return { content: input.content.trim(), category };
  }

  addMemory(input: MemoryInput, source: PersonalMemory['source'] = 'manual'): PersonalMemory {
    const data = this.memoryContent(input);
    const duplicate = this.store.state.memories.find(memory => memory.content.replace(/\s+/g, '') === data.content.replace(/\s+/g, ''));
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    const memory: PersonalMemory = { ...data, id: randomUUID(), source, createdAt: now, updatedAt: now };
    this.store.state.memories.push(memory);
    this.store.save();
    return memory;
  }

  updateMemory(id: string, input: MemoryInput, source: PersonalMemory['source'] = 'manual'): void {
    const memory = this.store.state.memories.find(item => item.id === id);
    if (!memory) throw new Error('这条记忆已不存在');
    Object.assign(memory, this.memoryContent({ ...input, category: input.category || memory.category }), { source, updatedAt: new Date().toISOString() });
    this.store.save();
  }

  deleteMemory(id: string): void {
    this.store.state.memories = this.store.state.memories.filter(memory => memory.id !== id);
    this.store.save();
  }

  private applyAiActions(actions: AiAction[], requestedTasks: Task[], memoryActions: AiMemoryAction[] = [], requestedMemories: PersonalMemory[] = []): void {
    const before = structuredClone(this.store.state);
    const activeMemoryActions = this.store.state.settings.memoryEnabled ? memoryActions : [];
    const comparable = (task: Task) => JSON.stringify([task.title, task.dueAt, task.status, task.durationMinutes, task.priority]);
    try {
      // Re-check IDs after the remote call: tasks may have changed while waiting.
      for (const action of actions) {
        if (action.type !== 'create') {
          const current = this.store.state.tasks.find(task => task.id === action.id);
          const requested = requestedTasks.find(task => task.id === action.id);
          if (!current || !requested || comparable(current) !== comparable(requested)) {
            throw new Error('等待 AI 时相关任务已被修改或删除，已保留你的新修改，请重新告诉我');
          }
        }
      }
      for (const action of activeMemoryActions) {
        if (action.type === 'remember') { this.memoryContent(action); continue; }
        const current = this.store.state.memories.find(memory => memory.id === action.id);
        const requested = requestedMemories.find(memory => memory.id === action.id);
        if (!current || !requested || JSON.stringify(current) !== JSON.stringify(requested)) {
          throw new Error('等待 AI 时相关记忆已被修改，已保留你的新修改，请重新告诉我');
        }
        if (action.type === 'update') this.memoryContent(action);
      }
      for (const action of actions) {
        if (action.type === 'create') this.createTask(action.task);
        if (action.type === 'complete') this.updateTask(action.id, { status: 'completed' });
        if (action.type === 'update') this.updateTask(action.id, action.patch);
      }
      if (this.store.state.settings.memoryEnabled) {
        for (const action of activeMemoryActions) {
          if (action.type === 'remember') this.addMemory(action, 'conversation');
          if (action.type === 'update') this.updateMemory(action.id, action, 'conversation');
          if (action.type === 'forget') this.deleteMemory(action.id);
        }
      }
    } catch (error) {
      this.store.state = before;
      this.store.save();
      throw error;
    }
  }

  async sendMessage(raw: string): Promise<AppSnapshot> {
    const text = raw.trim();
    if (!text) return this.snapshot();
    if (text.length > 12_000) throw new Error('这段话有点长，分几次告诉我吧');
    const recent = this.store.state.messages.slice(-24);
    this.store.state.messages.push({ id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString() });
    this.store.save();
    let reply: string;
    if (this.store.state.settings.apiKey) {
      try {
        const requestedTasks = structuredClone(this.store.state.tasks);
        const requestedMemories = structuredClone(this.store.state.memories);
        const settings = structuredClone(this.store.state.settings);
        const response = await askAi(text, requestedTasks, settings, recent, new Date(), {
          profile: structuredClone(this.store.state.profile), memories: requestedMemories,
        });
        this.applyAiActions(response.actions, requestedTasks, settings.memoryEnabled ? response.memoryActions || [] : [], requestedMemories);
        reply = response.reply;
      } catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError' ? '接口连接超时' : error instanceof Error ? error.message : '接口暂时不可用';
        reply = `米卡这次没有完成 AI 请求：${reason}。\n任务和记忆没有按这次请求修改。请到设置检查接口、模型或测试连接后重试。`;
      }
    } else {
      const result = interpretLocally(text, this.store.state.tasks);
      for (const input of result.create || []) this.createTask(input);
      for (const id of result.completeIds || []) this.updateTask(id, { status: 'completed' });
      for (const item of result.snooze || []) this.snoozeTask(item.id, item.minutes);
      reply = `（当前未连接 AI，以下是离线记事结果。）\n${result.reply}\n\n在设置中连接模型后，米卡才能结合你的画像和记忆进行个性化对话。`;
    }
    this.store.state.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() });
    this.store.state.messages = this.store.state.messages.slice(-300);
    this.store.save();
    return this.snapshot();
  }
}
