import { randomUUID } from 'node:crypto';
import type { AppSnapshot, SettingsPatch, Task, TaskInput, TaskPatch } from '../shared/types';
import { interpretLocally } from '../core/assistant';
import { getDueTasks } from '../core/reminders';
import { askAi, type AiAction } from './ai';
import { JsonStore } from './store';

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
    if (patch.model !== undefined && !patch.model.trim()) throw new Error('模型名称不能为空');
    if (patch.baseUrl !== undefined) {
      const url = new URL(patch.baseUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入有效的接口地址');
      this.store.state.settings.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    }
    if (patch.model !== undefined) {
      this.store.state.settings.model = patch.model.trim();
    }
    if (patch.apiKey !== undefined) this.store.state.settings.apiKey = patch.apiKey.trim();
    if (patch.alwaysOnTop !== undefined) this.store.state.settings.alwaysOnTop = Boolean(patch.alwaysOnTop);
    if (patch.notificationsEnabled !== undefined) this.store.state.settings.notificationsEnabled = Boolean(patch.notificationsEnabled);
    this.store.state.settings.apiKeyConfigured = Boolean(this.store.state.settings.apiKey);
    this.store.save();
  }

  private applyAiActions(actions: AiAction[], requestedTasks: Task[]): void {
    const before = structuredClone(this.store.state);
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
      for (const action of actions) {
        if (action.type === 'create') this.createTask(action.task);
        if (action.type === 'complete') this.updateTask(action.id, { status: 'completed' });
        if (action.type === 'update') this.updateTask(action.id, action.patch);
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
    const recent = this.store.state.messages.slice(-10);
    this.store.state.messages.push({ id: randomUUID(), role: 'user', text, createdAt: new Date().toISOString() });
    this.store.save();
    let reply: string;
    if (this.store.state.settings.apiKey) {
      try {
        const requestedTasks = structuredClone(this.store.state.tasks);
        const response = await askAi(text, requestedTasks, this.store.state.settings, recent);
        this.applyAiActions(response.actions, requestedTasks);
        reply = response.reply;
      } catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError' ? '接口连接超时' : error instanceof Error ? error.message : '接口暂时不可用';
        reply = `这次没有完成 AI 请求：${reason}。\n任务没有按这次请求修改。你可以检查设置后重试，或在设置中关闭 AI、使用本地记事。`;
      }
    } else {
      const result = interpretLocally(text, this.store.state.tasks);
      for (const input of result.create || []) this.createTask(input);
      for (const id of result.completeIds || []) this.updateTask(id, { status: 'completed' });
      for (const item of result.snooze || []) this.snoozeTask(item.id, item.minutes);
      reply = result.reply;
    }
    this.store.state.messages.push({ id: randomUUID(), role: 'assistant', text: reply, createdAt: new Date().toISOString() });
    this.store.state.messages = this.store.state.messages.slice(-300);
    this.store.save();
    return this.snapshot();
  }
}
