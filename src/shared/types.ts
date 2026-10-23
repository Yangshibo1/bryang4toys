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
}

export interface SettingsPatch {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  notificationsEnabled?: boolean;
  alwaysOnTop?: boolean;
}

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
  openPanel(): void;
  hidePanel(): void;
  togglePanel(): void;
  quit(): void;
  subscribe(listener: (state: AppSnapshot) => void): () => void;
}

declare global {
  interface Window { petApi?: PetApi }
}
