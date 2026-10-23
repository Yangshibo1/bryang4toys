const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
export const NUMBER_PATTERN = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';

export function readNumber(value: string): number {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  let total = 0;
  let digit = 0;
  for (const char of value) {
    if (char === '十' || char === '百') {
      total += (digit || 1) * (char === '十' ? 10 : 100);
      digit = 0;
    } else if (char in DIGITS) digit = DIGITS[char];
    else return Number.NaN;
  }
  return total + digit;
}

export interface ParsedTime {
  dueAt: Date | null;
  remaining: string;
  mentionedTime: boolean;
  clarification?: string;
}

const weekdays: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/** Parse wall-clock dates in the machine's local timezone, then store an ISO instant. */
export function parseTaskTime(text: string, now: Date = new Date()): ParsedTime {
  const relative = text.match(new RegExp(`(${NUMBER_PATTERN}|半)\\s*(?:个)?\\s*(秒(?:钟)?|分钟|分|小时|天)\\s*(?:之后|以后|后)`));
  if (relative) {
    const count = readNumber(relative[1]);
    const unit = relative[2];
    const milliseconds = count * (unit.startsWith('秒') ? 1_000 : unit.startsWith('分') ? 60_000 : unit === '小时' ? 3_600_000 : 86_400_000);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 366 * 86_400_000) {
      return { dueAt: null, remaining: text, mentionedTime: true, clarification: '请给一个大于零、且在一年以内的提醒间隔。' };
    }
    return { dueAt: new Date(now.getTime() + milliseconds), remaining: text.replace(relative[0], ''), mentionedTime: true };
  }

  const clock = text.match(new RegExp(`(?:(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚)\\s*)?(${NUMBER_PATTERN})(?:[:：](\\d{1,2})(?!\\d)|点(?:钟)?(半|一刻|三刻|${NUMBER_PATTERN}(?:分)?)?)`));
  if (!clock) {
    return { dueAt: null, remaining: text, mentionedTime: /今天|明天|后天|今晚|明晚|周[一二三四五六日天]|星期[一二三四五六日天]|早上|上午|下午|晚上|\d+月\d+[日号]/.test(text) };
  }

  let hour = readNumber(clock[2]);
  let minute = clock[3] ? Number(clock[3]) : 0;
  const suffix = clock[4];
  if (suffix === '半') minute = 30;
  else if (suffix === '一刻') minute = 15;
  else if (suffix === '三刻') minute = 45;
  else if (suffix) minute = readNumber(suffix.replace(/分$/, ''));
  const period = clock[1];
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { dueAt: null, remaining: text, mentionedTime: true, clarification: '这个时间不太对，请用有效的时间，例如“明天15:30提醒我开会”。' };
  }
  if (period && hour > 12) {
    return { dueAt: null, remaining: text, mentionedTime: true, clarification: '时段和小时有些冲突，请直接写“15:00”这样的时间。' };
  }
  if (!period && !clock[3] && hour > 0 && hour < 12) {
    return { dueAt: null, remaining: text, mentionedTime: true, clarification: `你说的${clock[2]}点是上午还是下午？请补全后再发一次，例如“明天下午三点提醒我开会”。` };
  }
  if (/下午|傍晚|晚上|今晚|明晚/.test(period || '') && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  if ((period === '凌晨' || period === '早上' || period === '早晨') && hour === 12) hour = 0;

  const dueAt = new Date(now);
  let remaining = text.replace(clock[0], '');
  let explicitDay = false;
  const numericDate = text.match(/(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})(?:日|号)?/);
  const dayWord = text.match(/大后天|后天|明天|今天|今日|明晚|今晚/);
  const weekday = text.match(/(下下周|下周|本周|这周|下下星期|下星期|本星期|这星期|星期|周)([一二三四五六日天])/);
  if (numericDate) {
    explicitDay = true;
    const year = numericDate[1] ? Number(numericDate[1]) : now.getFullYear();
    const month = Number(numericDate[2]);
    const day = Number(numericDate[3]);
    dueAt.setFullYear(year, month - 1, day);
    if (dueAt.getFullYear() !== year || dueAt.getMonth() !== month - 1 || dueAt.getDate() !== day) {
      return { dueAt: null, remaining: text, mentionedTime: true, clarification: '这个日期不存在，请检查月份和日期后再试一次。' };
    }
    remaining = remaining.replace(numericDate[0], '');
  } else if (dayWord) {
    explicitDay = true;
    const offsets: Record<string, number> = { 大后天: 3, 后天: 2, 明天: 1, 今天: 0, 今日: 0, 明晚: 1, 今晚: 0 };
    dueAt.setDate(dueAt.getDate() + offsets[dayWord[0]]);
    remaining = remaining.replace(dayWord[0], '');
  } else if (weekday) {
    explicitDay = true;
    const target = weekdays[weekday[2]];
    const mondayOffset = (now.getDay() + 6) % 7;
    const targetOffset = (target + 6) % 7;
    if (/^下下/.test(weekday[1])) dueAt.setDate(now.getDate() - mondayOffset + 14 + targetOffset);
    else if (/^下/.test(weekday[1])) dueAt.setDate(now.getDate() - mondayOffset + 7 + targetOffset);
    else if (/^(本|这)/.test(weekday[1])) dueAt.setDate(now.getDate() - mondayOffset + targetOffset);
    else dueAt.setDate(now.getDate() + (target - now.getDay() + 7) % 7);
    remaining = remaining.replace(weekday[0], '');
  }
  dueAt.setHours(hour, minute, 0, 0);
  if (dueAt.getHours() !== hour || dueAt.getMinutes() !== minute) {
    return { dueAt: null, remaining: text, mentionedTime: true, clarification: '这个本地时间可能遇到夏令时跳变，请换一个明确的时间。' };
  }
  if (dueAt.getTime() <= now.getTime()) {
    if (explicitDay || period === '今晚') {
      return { dueAt: null, remaining: text, mentionedTime: true, clarification: '你指定的时间已经过去了。请确认是要换到明天，还是指定其他未来时间；我还没有创建任务。' };
    }
    dueAt.setDate(dueAt.getDate() + 1);
  }
  return { dueAt, remaining, mentionedTime: true };
}

export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatWhen(date: Date, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const label = day.getTime() === today.getTime() ? '今天' : day.getTime() === tomorrow.getTime() ? '明天' : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${label} ${formatClock(date)}`;
}
