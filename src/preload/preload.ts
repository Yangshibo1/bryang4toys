import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, PetApi } from '../shared/types';

const api: PetApi = {
  getState: () => ipcRenderer.invoke('momo:get-state'),
  sendMessage: text => ipcRenderer.invoke('momo:send-message', text),
  createTask: input => ipcRenderer.invoke('momo:create-task', input),
  updateTask: (id, patch) => ipcRenderer.invoke('momo:update-task', id, patch),
  deleteTask: id => ipcRenderer.invoke('momo:delete-task', id),
  snoozeTask: (id, minutes) => ipcRenderer.invoke('momo:snooze-task', id, minutes),
  dismissReminder: id => ipcRenderer.invoke('momo:dismiss-reminder', id),
  saveSettings: patch => ipcRenderer.invoke('momo:save-settings', patch),
  testNotification: () => ipcRenderer.invoke('momo:test-notification'),
  testAiConnection: patch => ipcRenderer.invoke('momo:test-ai', patch),
  saveProfile: patch => ipcRenderer.invoke('momo:save-profile', patch),
  addMemory: input => ipcRenderer.invoke('momo:add-memory', input),
  updateMemory: (id, input) => ipcRenderer.invoke('momo:update-memory', id, input),
  deleteMemory: id => ipcRenderer.invoke('momo:delete-memory', id),
  openPanel: () => ipcRenderer.send('momo:open-panel'),
  hidePanel: () => ipcRenderer.send('momo:hide-panel'),
  togglePanel: () => ipcRenderer.send('momo:toggle-panel'),
  quit: () => ipcRenderer.send('momo:quit'),
  subscribe: listener => {
    const handler = (_event: unknown, state: AppSnapshot) => listener(state);
    ipcRenderer.on('momo:state', handler);
    return () => { ipcRenderer.removeListener('momo:state', handler); };
  },
};
contextBridge.exposeInMainWorld('petApi', api);
