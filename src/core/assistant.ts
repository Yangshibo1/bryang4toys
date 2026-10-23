import type { Task, TaskInput } from '../shared/types';
import { NUMBER_PATTERN, formatClock, formatWhen, parseTaskTime, readNumber } from './time';

export interface LocalResult {
  reply: string;
  create?: TaskInput[];
  completeIds?: string[];
  snooze?: { id: string; minutes: number }[];
}

const help = '可以直接告诉我：“明天下午三点提醒我开会”“10分钟后提醒我喝水”“记一下买牛奶”。也可以说“今天怎么安排”“完成 写报告”或“把开会推迟10分钟”。';

function titleKey(text: string): string {
  return text.replace(/[\s，。！!、：:“”"'‘’]/g, '').replace(/^(?:把|将)/, '').trim();
}

function matchTask(query: string, tasks: Task[]): Task[] {
  const key = titleKey(query);
  if (!key) return [];
  const pending = tasks.filter(task => task.status === 'pending');
  const exact = pending.filter(task => titleKey(task.title) === key);
  return exact.length ? exact : pending.filter(task => titleKey(task.title).includes(key));
}

function clarifyMatches(query: string, matches: Task[]): string | null {
  if (!query.trim()) return '想修改哪一项？请带上任务名称，例如“完成 写报告”。';
  if (!matches.length) return `没有找到待完成的“${query}”。可以在任务列表里查看名称后再试一次。`;
  if (matches.length > 1) return `找到了多项相关任务：${matches.map(t => `“${t.title}”`).join('、')}。请给我完整名称，我再修改。`;
  return null;
}

export function interpretLocally(text: string, tasks: Task[], now: Date = new Date()): LocalResult {
  const input = text.trim();
  if (!input) return { reply: help };
  if (input.length > 4_000) return { reply: '这段有点长，请把要记的事情分成几条发给我。' };
  if (/^(?:不要|别|取消|删除|停止)/.test(input)) return { reply: '我没有添加或修改任务。要取消提醒，可以在任务卡片里删除任务或清除提醒时间。' };
  if (/提前.{0,20}(?:提醒|通知|叫我)/.test(input)) {
    return { reply: '你同时提到了事项时间和提前提醒。当前本地模式需要直接指定提醒时间，例如“明天14:30提醒我准备15:00的会议”。我还没有创建任务。' };
  }
  if (/今天.*(?:怎么安排|如何安排|有什么|待办|计划|日程)|(?:规划|安排)(?:一下)?今天|今日(?:计划|日程|安排)|帮我(?:规划|安排)(?:一下)?(?:今天|今日)/.test(input)) {
    return { reply: planDay(tasks, now) };
  }

  const complete = input.match(/^(?:(?:请|帮我)\s*)?(?:完成(?:了)?|做完(?:了)?|搞定(?:了)?)\s*[:：]?\s*(.*)$/)
    || input.match(/^(?:(?:请|帮我)\s*)?(?:把|将)?(.+?)(?:标记为|标为)?(?:完成了|已完成|完成)[。！!]?$/);
  if (complete) {
    const query = complete[1].trim().replace(/[。！!]$/, '');
    const matches = matchTask(query, tasks);
    const clarification = clarifyMatches(query, matches);
    if (clarification) return { reply: clarification };
    return { completeIds: [matches[0].id], reply: `完成啦，已勾掉“${matches[0].title}”。做得不错，给自己一个小小的休息。` };
  }

  const snooze = input.match(new RegExp(`^(?:(?:请|帮我)\\s*)?(?:把|将)?(.*?)(?:再)?(?:推迟|延后|延迟)\\s*(${NUMBER_PATTERN}|半)\\s*(?:个)?\\s*(分钟|分|小时)[。！!！]?$`));
  if (snooze) {
    const query = snooze[1].trim();
    const matches = matchTask(query, tasks);
    const clarification = clarifyMatches(query, matches);
    if (clarification) return { reply: clarification };
    const minutes = readNumber(snooze[2]) * (snooze[3] === '小时' ? 60 : 1);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 7 * 24 * 60) return { reply: '请给一个大于零、且在七天以内的延后时长。' };
    return {
      snooze: [{ id: matches[0].id, minutes }],
      reply: `好，“${matches[0].title}”改为从现在起${minutes}分钟后提醒（${formatWhen(new Date(now.getTime() + minutes * 60_000), now)}）。`,
    };
  }
  if (/推迟|延后|延迟/.test(input)) return { reply: '请带上任务名称和延后时长，例如“把开会推迟10分钟”。' };

  const parts = input.split(/[；;\n]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    if (parts.length > 10) return { reply: '一次先记十件以内的事情吧，分开发更容易确认。' };
    const results = parts.map(part => interpretLocally(part, tasks, now));
    const incomplete = results.find(result => !result.create?.length);
    if (incomplete) return { reply: `这次还没有添加任务，先确认一下：${incomplete.reply}` };
    return { create: results.flatMap(result => result.create!), reply: results.map(result => result.reply).join('\n') };
  }

  const timedClauses = input.split(/[，,、]/).filter(part => {
    const parsed = parseTaskTime(part, now);
    return parsed.dueAt !== null || parsed.clarification !== undefined;
  });
  if (timedClauses.length > 1) {
    return { reply: '我看到这里有多个时间和事项。请每条单独发送，或用分号分开并为每条写明日期和时间，例如“今天15:00开会；今天20:00运动”。我还没有添加任务。' };
  }

  const time = parseTaskTime(input, now);
  const explicitTask = /(?:提醒(?:我|一下)?|记一下|记下|记得|帮我记|记录|待办|添加(?:任务)?|新建(?:任务)?)/.test(input);
  if (!explicitTask && /[?？]|(?:吗|么|呢)[。！!]?\s*$/.test(input)) return { reply: help };
  const actionable = /^(?:(?:请|帮我|我要|我想|需要|今天|明天|后天|下午|上午|晚上|早上|重要|紧急|优先|\s|[，！!：:])+)?(?:买|写|读|做|准备|整理|提交|复习|学习|运动|跑步|健身|开会|交|发邮件|打电话|联系|预约|吃药|喝水|取快递|看医生|看牙|回邮件|洗|修|检查|备份|完成|还没完成)/.test(input);
  if (time.clarification) return { reply: time.clarification };
  if (!explicitTask && !time.dueAt && !actionable) return { reply: help };

  let remainder = time.remaining;
  const duration = remainder.match(new RegExp(`(?:预计|大概|大约|耗时|用时|时长|持续|需要)(?:要|花)?\\s*(${NUMBER_PATTERN}|半)\\s*(?:个)?\\s*(分钟|分|小时)(?:左右)?`));
  let durationMinutes = 30;
  if (duration) {
    durationMinutes = readNumber(duration[1]) * (duration[2] === '小时' ? 60 : 1);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 1_440) return { reply: '预计耗时请设置在 1 分钟到 24 小时之间。' };
    remainder = remainder.replace(duration[0], '');
  }
  const priority = /重要|紧急|优先|高优先级/.test(input) ? 'high' : /不急|有空再|低优先级/.test(input) ? 'low' : 'normal';
  const title = remainder
    .replace(/(?:高优先级|低优先级|优先级[：:]?(?:高|中|低)|很重要|重要|紧急|不急|有空再做|有空再)/g, '')
    .replace(/^[\s，,。:：！!]+/, '')
    .replace(/^(?:(?:请|麻烦|帮我|我要|我想|需要)\s*)+/, '')
    .replace(/^(?:记一下|记录一下|记下|记得|记录|添加待办|添加任务|新建任务|待办[：:]?|提醒一下我|提醒我|提醒一下|提醒)[\s：:]*/, '')
    .replace(/(?:提醒我|提醒一下)$/, '')
    .replace(/^[\s，,。:：！!]+|[\s，,。！!]+$/g, '')
    .trim();
  if (!title || title.length < 2) return { reply: '要提醒你做什么呢？例如“十分钟后提醒我喝水”。' };
  if (title.length > 160) return { reply: '任务名称有点长，请用 160 个字以内描述要做的事情。' };
  const task: TaskInput = { title, dueAt: time.dueAt?.toISOString() ?? null, durationMinutes, priority };
  return {
    create: [task],
    reply: time.dueAt
      ? `记好啦：${formatWhen(time.dueAt, now)}提醒你“${title}”${duration ? `，预计${durationMinutes}分钟` : ''}。`
      : `已把“${title}”放进待办。还没有具体提醒时间，因此不会定时提醒；可以在任务卡片里设置时间。`,
  };
}

export function planDay(tasks: Task[], now: Date = new Date()): string {
  const pending = tasks.filter(task => task.status === 'pending');
  if (!pending.length) return '今天还没有待办，给自己留一点空白也很好。把想做的事情告诉我，我来帮你安排。';
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const validTime = (task: Task) => task.dueAt && Number.isFinite(Date.parse(task.dueAt));
  const overdue = pending.filter(task => validTime(task) && Date.parse(task.dueAt!) < now.getTime());
  const fixed = pending.filter(task => validTime(task) && Date.parse(task.dueAt!) >= now.getTime() && Date.parse(task.dueAt!) < end.getTime())
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
  const untimed = pending.filter(task => !validTime(task));
  const deferred = untimed.filter(task => /明天|后天|下周|下星期/.test(task.title));
  const rank = { high: 0, normal: 1, low: 2 };
  const flexible = untimed.filter(task => !deferred.includes(task)).sort((a, b) => rank[a.priority] - rank[b.priority]);
  const lines = ['今天的安排建议（只提供建议，不会自动移动任务）：'];
  if (overdue.length) lines.push('', '已过提醒时间：', ...overdue.map(task => `• ${task.title}（原定${formatWhen(new Date(task.dueAt!), now)}），先确认是否仍需处理。`));
  if (fixed.length) lines.push('', '已有固定提醒：', ...fixed.map(task => `• ${formatClock(new Date(task.dueAt!))} ${task.title}，预留${task.durationMinutes || 30}分钟。`));
  const conflicts: string[] = [];
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      if (Date.parse(fixed[j].dueAt!) < Date.parse(fixed[i].dueAt!) + (fixed[i].durationMinutes || 30) * 60_000) conflicts.push(`• “${fixed[i].title}”和“${fixed[j].title}”时间重叠，建议你调整其中一项。`);
    }
  }
  if (conflicts.length) lines.push('', '需要留意的冲突：', ...conflicts);

  const cursorDate = new Date(now);
  cursorDate.setSeconds(0, 0);
  cursorDate.setMinutes(Math.ceil(now.getMinutes() / 5) * 5);
  if (cursorDate.getTime() < now.getTime()) cursorDate.setMinutes(cursorDate.getMinutes() + 5);
  let cursor = cursorDate.getTime();
  const stop = new Date(start); stop.setHours(21, 0, 0, 0);
  const intervals = fixed.map(task => ({ start: Date.parse(task.dueAt!), end: Date.parse(task.dueAt!) + (task.durationMinutes || 30) * 60_000 }));
  const suggestions: string[] = [];
  const remaining: string[] = [];
  for (const task of flexible) {
    const length = (task.durationMinutes || 30) * 60_000;
    for (const occupied of intervals) {
      if (cursor < occupied.end + 10 * 60_000 && cursor + length > occupied.start - 10 * 60_000) cursor = occupied.end + 10 * 60_000;
    }
    if (cursor + length > stop.getTime()) { remaining.push(task.title); continue; }
    suggestions.push(`• ${formatClock(new Date(cursor))}–${formatClock(new Date(cursor + length))} ${task.title}${task.priority === 'high' ? '（优先）' : ''}。`);
    cursor += length + 10 * 60_000;
  }
  if (suggestions.length) lines.push('', '空闲时间可以这样用：', ...suggestions);
  if (remaining.length) lines.push('', `今天 21:00 前剩余时间放不下：${remaining.map(title => `“${title}”`).join('、')}。建议另选时间，别把一天塞太满。`);
  if (deferred.length) lines.push('', `这些待办提到了未来日期，但还没设置具体提醒时间：${deferred.map(task => `“${task.title}”`).join('、')}。`);
  if (!overdue.length && !fixed.length && !flexible.length && !deferred.length) lines.push('今天没有需要安排的任务；已设在未来日期的提醒会按原时间保留。');
  return lines.join('\n');
}
