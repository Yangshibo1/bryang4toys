import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, Reminder, SettingsView, Task } from '../shared/types';

export interface SavedSettings extends SettingsView { apiKey: string }
export interface SavedState {
  version: 1;
  tasks: Task[];
  messages: ChatMessage[];
  reminders: Reminder[];
  settings: SavedSettings;
}

export function initialState(): SavedState {
  return {
    version: 1,
    tasks: [],
    reminders: [],
    messages: [{
      id: 'welcome', role: 'assistant', createdAt: new Date().toISOString(),
      text: '你好，我是慢慢。把要记住的事情交给我，我们一件一件来。\n\n试试说：“10分钟后提醒我喝水”，或者“记一下周五要交报告”。',
    }],
    settings: {
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '',
      apiKeyConfigured: false, notificationsEnabled: true, alwaysOnTop: true,
    },
  };
}

export class JsonStore {
  readonly file: string;
  state: SavedState;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'momo-data.json');
    this.state = initialState();
    if (fs.existsSync(this.file)) {
      // A broken store is surfaced, never silently replaced with an empty one.
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.messages)) {
        throw new Error(`无法读取本地任务数据，请保留并检查：${this.file}`);
      }
      this.state = { ...this.state, ...parsed, settings: { ...this.state.settings, ...parsed.settings } };
      this.state.settings.apiKeyConfigured = Boolean(this.state.settings.apiKey);
    }
  }

  save(): void {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
