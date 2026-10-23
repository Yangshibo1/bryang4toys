import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretLocally, planDay } from '../src/core/assistant';
import { getDueTasks } from '../src/core/reminders';
import { parseTaskTime } from '../src/core/time';
import type { Task } from '../src/shared/types';

const now = new Date(2026, 9, 23, 10, 0, 0); // Friday, in the process's local timezone.
const local = (iso: string) => {
  const date = new Date(iso);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
};
const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'report', title: '写报告', dueAt: null, durationMinutes: 30, priority: 'normal',
  status: 'pending', createdAt: now.toISOString(), ...overrides,
});

test('Chinese tomorrow afternoon creates a task at the correct local instant', () => {
  const result = interpretLocally('明天下午三点提醒我开会', [], now);
  assert.equal(result.create?.length, 1);
  assert.equal(result.create![0].title, '开会');
  assert.deepEqual(local(result.create![0].dueAt!), [2026, 10, 24, 15, 0]);
  assert.match(result.reply, /明天 15:00/);
});

test('relative reminder and estimated duration remain distinct', () => {
  const result = interpretLocally('十分钟后提醒我开会，预计半小时', [], now);
  const created = result.create![0];
  assert.equal(created.title, '开会');
  assert.equal(new Date(created.dueAt!).getTime() - now.getTime(), 10 * 60_000);
  assert.equal(created.durationMinutes, 30);
  const seconds = interpretLocally('10秒后提醒我喝水', [], now).create![0];
  assert.equal(Date.parse(seconds.dueAt!) - now.getTime(), 10_000);
});

test('24 hour clock and Chinese half-hours both parse', () => {
  assert.deepEqual(local(interpretLocally('今天18:30运动', [], now).create![0].dueAt!), [2026, 10, 23, 18, 30]);
  assert.deepEqual(local(interpretLocally('明天凌晨十二点半提醒我吃药', [], now).create![0].dueAt!), [2026, 10, 24, 0, 30]);
  assert.deepEqual(local(interpretLocally('下午两点半提醒我开会', [], now).create![0].dueAt!), [2026, 10, 23, 14, 30]);
});

test('weekdays and next calendar week retain local calendar semantics', () => {
  assert.deepEqual(local(interpretLocally('周五下午三点交报告', [], now).create![0].dueAt!), [2026, 10, 23, 15, 0]);
  assert.deepEqual(local(interpretLocally('下周一上午九点提醒我复习', [], now).create![0].dueAt!), [2026, 10, 26, 9, 0]);
  assert.deepEqual(local(interpretLocally('周日上午十点提醒我运动', [], now).create![0].dueAt!), [2026, 10, 25, 10, 0]);
  const yearEnd = new Date(2026, 11, 31, 10, 0);
  assert.deepEqual(local(interpretLocally('下周一上午九点开会', [], yearEnd).create![0].dueAt!), [2027, 1, 4, 9, 0]);
});

test('ambiguous AM/PM and explicitly past times need clarification, never silent rollover', () => {
  const ambiguous = interpretLocally('明天三点开会', [], now);
  assert.equal(ambiguous.create, undefined);
  assert.match(ambiguous.reply, /上午还是下午/);
  const past = interpretLocally('今天上午九点提醒我开会', [], now);
  assert.equal(past.create, undefined);
  assert.match(past.reply, /已经过去/);
  const pastWeekday = interpretLocally('周五上午九点交报告', [], now);
  assert.equal(pastWeekday.create, undefined);
  assert.match(pastWeekday.reply, /已经过去/);
});

test('invalid date, clock and negative or zero intervals never create broken tasks', () => {
  for (const text of ['2026年2月30日15:00提醒我开会', '今天24:00提醒我运动', '0分钟后提醒我喝水', '明天15:99提醒我喝水']) {
    assert.equal(interpretLocally(text, [], now).create, undefined, text);
  }
});

test('no hour means an unscheduled todo, and greetings do not become tasks', () => {
  const result = interpretLocally('记一下买牛奶', [], now);
  assert.equal(result.create![0].title, '买牛奶');
  assert.equal(result.create![0].dueAt, null);
  assert.match(result.reply, /不会定时提醒/);
  const tomorrow = interpretLocally('明天买牛奶', [], now);
  assert.equal(tomorrow.create![0].dueAt, null);
  assert.match(tomorrow.create![0].title, /明天/);
  for (const text of ['你好', '谢谢你', '今天会下雨吗', '我今天好累', '我很累了', '明天下午三点会下雨吗', '不要提醒我明天下午三点开会']) assert.equal(interpretLocally(text, [], now).create, undefined, text);
});

test('priority and duration metadata are applied without polluting task titles', () => {
  const result = interpretLocally('重要！记一下写报告，预计要两小时', [], now);
  assert.equal(result.create![0].priority, 'high');
  assert.equal(result.create![0].durationMinutes, 120);
  assert.equal(result.create![0].title, '写报告');
  assert.equal(interpretLocally('还没完成写报告，预计要两小时', [task()], now).completeIds, undefined);
});

test('complete selects one exact match and refuses ambiguous fuzzy matches', () => {
  const all = [task({ id: 'first', title: '写报告初稿' }), task({ id: 'last', title: '写报告终稿' })];
  const ambiguous = interpretLocally('完成 写报告', all, now);
  assert.equal(ambiguous.completeIds, undefined);
  assert.match(ambiguous.reply, /多项/);
  assert.deepEqual(interpretLocally('完成 写报告初稿', all, now).completeIds, ['first']);
  assert.equal(interpretLocally('完成', all, now).completeIds, undefined);
  assert.equal(interpretLocally('完成 写报告', [task({ status: 'completed' })], now).completeIds, undefined);
});

test('snooze matches one pending task and declares its now-based behavior', () => {
  const result = interpretLocally('把开会推迟十分钟', [task({ title: '开会' })], now);
  assert.deepEqual(result.snooze, [{ id: 'report', minutes: 10 }]);
  assert.match(result.reply, /从现在起10分钟/);
  assert.equal(interpretLocally('把开会推迟十分钟', [task({ id: 'a', title: '开会A' }), task({ id: 'b', title: '开会B' })], now).snooze, undefined);
  assert.equal(interpretLocally('把开会推迟0分钟', [task({ title: '开会' })], now).snooze, undefined);
});

test('multiple explicit messages add atomically and a clarification prevents partial writes', () => {
  const result = interpretLocally('明天15:00开会；10分钟后提醒我喝水', [], now);
  assert.equal(result.create?.length, 2);
  const ambiguous = interpretLocally('明天三点开会；10分钟后提醒我喝水', [], now);
  assert.equal(ambiguous.create, undefined);
});

test('advance reminders and ambiguous comma-separated multi-task messages are not misrepresented', () => {
  const advance = interpretLocally('明天下午三点开会，提前半小时提醒', [], now);
  assert.equal(advance.create, undefined);
  assert.match(advance.reply, /直接指定提醒时间/);
  const multiple = interpretLocally('今天下午3点开会，晚上8点运动', [], now);
  assert.equal(multiple.create, undefined);
  assert.match(multiple.reply, /多个时间和事项/);
  const explicit = interpretLocally('今天15:00开会；今天20:00运动', [], now);
  assert.equal(explicit.create?.length, 2);
});

test('due reminders are ordered, survive restarts and skip completed or delivered tasks', () => {
  const before = new Date(now.getTime() - 10_000).toISOString();
  const future = new Date(now.getTime() + 10_000).toISOString();
  const tasks = [
    task({ id: 'untimed' }),
    task({ id: 'future', dueAt: future }),
    task({ id: 'now', dueAt: now.toISOString() }),
    task({ id: 'overdue', dueAt: before }),
    task({ id: 'done', dueAt: before, status: 'completed' }),
    task({ id: 'notified', dueAt: before, lastNotifiedAt: now.toISOString() }),
    task({ id: 'invalid', dueAt: 'not a date' }),
  ];
  assert.deepEqual(getDueTasks(JSON.parse(JSON.stringify(tasks)), now).map(t => t.id), ['overdue', 'now']);
  assert.equal(getDueTasks([task({ dueAt: before, lastNotifiedAt: before })], now).length, 0);
  assert.equal(getDueTasks([task({ dueAt: before, lastNotifiedAt: new Date(now.getTime() - 20_000).toISOString() })], now).length, 1);
});

test('planning reserves fixed intervals and buffers, prioritizes tasks and reports conflicts', () => {
  const tasks = [
    task({ id: 'meeting', title: '项目会', dueAt: new Date(2026, 9, 23, 10, 10).toISOString(), durationMinutes: 30 }),
    task({ id: 'overlap', title: '面试', dueAt: new Date(2026, 9, 23, 10, 20).toISOString(), durationMinutes: 40 }),
    task({ id: 'low', title: '买牛奶', priority: 'low' }),
    task({ id: 'high', title: '写报告', priority: 'high', durationMinutes: 60 }),
  ];
  const plan = planDay(tasks, now);
  assert.match(plan, /时间重叠/);
  assert.match(plan, /11:10–12:10 写报告/);
  assert.ok(plan.indexOf('11:10–12:10 写报告') < plan.indexOf('12:20–12:50 买牛奶'));
  assert.equal(tasks.find(t => t.id === 'high')!.dueAt, null);
});

test('planning labels overdue tasks and never automatically schedules beyond 21:00', () => {
  const evening = new Date(2026, 9, 23, 20, 50);
  const plan = planDay([
    task({ id: 'late', title: '逾期报告', dueAt: new Date(2026, 9, 22, 12).toISOString() }),
    task({ id: 'flex', title: '运动', durationMinutes: 30 }),
    task({ id: 'tomorrow', title: '明天买牛奶' }),
  ], evening);
  assert.match(plan, /已过提醒时间/);
  assert.match(plan, /剩余时间放不下/);
  assert.match(plan, /未来日期/);
  assert.doesNotMatch(plan, /20:50–21:20/);
});

test('time helpers do not mutate the supplied clock', () => {
  const original = now.getTime();
  parseTaskTime('下周一上午九点开会', now);
  planDay([task()], now);
  assert.equal(now.getTime(), original);
});
