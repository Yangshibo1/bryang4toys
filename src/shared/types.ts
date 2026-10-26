export type Priority = 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  dueAt: string | null;
  durationMinutes: number;
  priority: Priority;
  status: 'pending' | 'completed';
  createdAt: string;
  completedAt?: string;
  lastNotifiedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface SettingsView {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  notificationsEnabled: boolean;
  alwaysOnTop: boolean;
  protocol: 'chat-completions' | 'responses';
  memoryEnabled: boolean;
}

export interface SettingsPatch {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  notificationsEnabled?: boolean;
  alwaysOnTop?: boolean;
  protocol?: 'chat-completions' | 'responses';
  memoryEnabled?: boolean;
}

export interface UserProfile {
  name: string;
  role: string;
  about: string;
  goals: string;
  preferences: string;
  routine: string;
  assistantStyle: string;
}

export type MemoryCategory = 'preference' | 'background' | 'goal' | 'routine' | 'other';
export interface PersonalMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  source: 'manual' | 'conversation';
  createdAt: string;
  updatedAt: string;
}
export interface MemoryInput { content: string; category?: MemoryCategory }
export interface AiConnectionResult { ok: boolean; model: string; latencyMs: number; message: string }

export interface Reminder {
  taskId: string;
  title: string;
  dueAt: string;
}

export interface AppSnapshot {
  tasks: Task[];
  messages: ChatMessage[];
  settings: SettingsView;
  reminders: Reminder[];
  platform: 'darwin' | 'win32' | 'linux' | 'browser';
  assistantBusy?: boolean;
  profile: UserProfile;
  memories: PersonalMemory[];
}

export interface TaskInput {
  title: string;
  dueAt: string | null;
  durationMinutes?: number;
  priority?: Priority;
}

export type TaskPatch = Partial<Pick<Task, 'title' | 'dueAt' | 'durationMinutes' | 'priority' | 'status'>>;

export interface PetApi {
  getState(): Promise<AppSnapshot>;
  sendMessage(text: string): Promise<AppSnapshot>;
  createTask(input: TaskInput): Promise<AppSnapshot>;
  updateTask(id: string, patch: TaskPatch): Promise<AppSnapshot>;
  deleteTask(id: string): Promise<AppSnapshot>;
  snoozeTask(id: string, minutes: number): Promise<AppSnapshot>;
  dismissReminder(id: string): Promise<AppSnapshot>;
  saveSettings(patch: SettingsPatch): Promise<AppSnapshot>;
  testNotification(): Promise<{ supported: boolean }>;
  testAiConnection(patch?: SettingsPatch): Promise<AiConnectionResult>;
  saveProfile(patch: Partial<UserProfile>): Promise<AppSnapshot>;
  addMemory(input: MemoryInput): Promise<AppSnapshot>;
  updateMemory(id: string, patch: MemoryInput): Promise<AppSnapshot>;
  deleteMemory(id: string): Promise<AppSnapshot>;
  openPanel(): void;
  hidePanel(): void;
  togglePanel(): void;
  quit(): void;
  subscribe(listener: (state: AppSnapshot) => void): () => void;
}

declare global {
  interface Window { petApi?: PetApi }
}
