import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, PersonalMemory, Reminder, SettingsView, Task, UserProfile } from '../shared/types';

export interface SavedSettings extends SettingsView { apiKey: string }
export interface SavedState {
  version: 2;
  tasks: Task[];
  messages: ChatMessage[];
  reminders: Reminder[];
  settings: SavedSettings;
  profile: UserProfile;
  memories: PersonalMemory[];
}

export function initialProfile(): UserProfile {
  return {
    name: '', role: '', about: '', goals: '', preferences: '', routine: '',
    assistantStyle: '自然、真诚、直接。根据我的背景提供具体建议；不确定时先问，不假装了解我。',
  };
}

export function initialState(): SavedState {
  return {
    version: 2,
    tasks: [],
    reminders: [],
    memories: [],
    profile: initialProfile(),
    messages: [{
      id: 'welcome', role: 'assistant', createdAt: new Date().toISOString(),
      text: '你好，我是米卡 Mika，你的个人 AI 助手。我们可以聊想法、解决问题，也可以一起安排日程。\n\n先在设置里连接你的模型接口，再告诉我希望怎样称呼你、你的目标和偏好。我会按你的选择记住长期信息；你随时可以查看、修改或删除记忆。',
    }],
    settings: {
      baseUrl: 'https://api.openai.com/v1',
      // This is the user's preferred, editable model ID, not a claim of API availability.
      model: 'gpt-6-luna', apiKey: '', protocol: 'chat-completions', memoryEnabled: true,
      apiKeyConfigured: false, notificationsEnabled: true, alwaysOnTop: true,
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readState(file: string): SavedState {
  const defaults = initialState();
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`无法读取本地数据，请保留并检查：${file}`); }
  if (!isObject(parsed) || ![1, 2].includes(parsed.version as number)
    || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.messages)
    || (parsed.reminders !== undefined && !Array.isArray(parsed.reminders))
    || (parsed.memories !== undefined && !Array.isArray(parsed.memories))
    || (parsed.settings !== undefined && !isObject(parsed.settings))
    || (parsed.profile !== undefined && !isObject(parsed.profile))) {
    throw new Error(`无法读取本地数据，请保留并检查：${file}`);
  }
  const savedSettings = isObject(parsed.settings) ? parsed.settings : {};
  if (savedSettings.apiKey !== undefined && typeof savedSettings.apiKey !== 'string') {
    throw new Error(`本地接口设置格式不正确，请保留并检查：${file}`);
  }
  const settings = { ...defaults.settings, ...savedSettings } as SavedSettings;
  // An untouched, keyless Momo default is not a user-selected provider. Upgrade
  // only that exact v1 combination; configured or custom providers remain intact.
  if (parsed.version === 1 && settings.baseUrl === 'https://api.deepseek.com/v1'
    && settings.model === 'deepseek-chat' && !settings.apiKey.trim()) {
    settings.baseUrl = defaults.settings.baseUrl;
    settings.model = defaults.settings.model;
  }
  // Momo v1 used Chat Completions. Never reinterpret its saved provider as Responses.
  settings.protocol = savedSettings.protocol === 'responses' ? 'responses' : 'chat-completions';
  settings.memoryEnabled = typeof savedSettings.memoryEnabled === 'boolean' ? savedSettings.memoryEnabled : true;
  settings.apiKeyConfigured = Boolean(settings.apiKey);
  const profile = initialProfile();
  if (isObject(parsed.profile)) {
    for (const key of Object.keys(profile) as (keyof UserProfile)[]) {
      if (typeof parsed.profile[key] === 'string') profile[key] = parsed.profile[key];
    }
  }
  return {
    version: 2,
    tasks: parsed.tasks as Task[], messages: parsed.messages as ChatMessage[],
    reminders: (parsed.reminders || []) as Reminder[],
    memories: (parsed.memories || []) as PersonalMemory[],
    profile, settings,
  };
}

export class JsonStore {
  readonly file: string;
  state: SavedState;

  constructor(directory: string, legacyDirectories: string[] = []) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'mika-data.json');
    this.state = initialState();
    if (fs.existsSync(this.file)) {
      // Invalid new data must surface; falling back could resurrect outdated tasks.
      this.state = readState(this.file);
      return;
    }
    const candidates = [
      path.join(directory, 'momo-data.json'),
      ...legacyDirectories.flatMap(legacy => [path.join(legacy, 'mika-data.json'), path.join(legacy, 'momo-data.json')]),
    ];
    const source = [...new Set(candidates)].find(file => fs.existsSync(file));
    if (source) {
      this.state = readState(source);
      // Copy into the new name only. The original remains a recoverable migration backup.
      this.save();
    }
  }

  save(): void {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
