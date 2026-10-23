import type { Task } from '../shared/types';

/** Overdue reminders survive a restart; a persisted delivery marker prevents repeats. */
export function getDueTasks(tasks: Task[], now: Date = new Date()): Task[] {
  const nowMs = now.getTime();
  return tasks.filter(task => {
    if (task.status !== 'pending' || !task.dueAt) return false;
    const due = Date.parse(task.dueAt);
    if (!Number.isFinite(due) || due > nowMs) return false;
    const notified = task.lastNotifiedAt ? Date.parse(task.lastNotifiedAt) : Number.NaN;
    return !Number.isFinite(notified) || notified < due;
  }).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
}
