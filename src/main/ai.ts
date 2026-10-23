import type { Task, TaskInput, TaskPatch } from '../shared/types';
import type { SavedSettings } from './store';

export type AiAction =
  | { type: 'create'; task: TaskInput }
  | { type: 'complete'; id: string }
  | { type: 'update'; id: string; patch: TaskPatch };
export interface AiResult { reply: string; actions: AiAction[] }

function validDate(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}

export function parseAiResult(content: string, tasks: Task[]): AiResult {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(stripped);
  if (typeof parsed.reply !== 'string' || !Array.isArray(parsed.actions)) throw new Error('模型返回格式不正确');
  if (parsed.actions.length > 30) throw new Error('一次任务数量过多，请分批告诉我');
  const ids = new Set(tasks.map(task => task.id));
  const actions: AiAction[] = [];
  for (const item of parsed.actions) {
    if (item.type === 'create') {
      const t = item.task;
      if (!t || typeof t.title !== 'string' || !t.title.trim() || !validDate(t.dueAt)) {
        throw new Error('模型返回的任务缺少标题或有效时间');
      }
      actions.push({ type: 'create', task: {
        title: t.title.trim(), dueAt: t.dueAt,
        durationMinutes: Number.isFinite(t.durationMinutes) ? Math.max(1, Math.min(1440, t.durationMinutes)) : 30,
        priority: ['high', 'normal', 'low'].includes(t.priority) ? t.priority : 'normal',
      } });
    } else if (item.type === 'complete') {
      if (!ids.has(item.id)) throw new Error('模型引用了不存在的任务');
      actions.push({ type: 'complete', id: item.id });
    } else if (item.type === 'update') {
      if (!ids.has(item.id) || !item.patch || typeof item.patch !== 'object') throw new Error('模型引用了不存在的任务');
      const patch: TaskPatch = {};
      if ('dueAt' in item.patch) {
        if (!validDate(item.patch.dueAt)) throw new Error('模型返回的时间无法识别');
        patch.dueAt = item.patch.dueAt;
      }
      if (typeof item.patch.title === 'string' && item.patch.title.trim()) patch.title = item.patch.title.trim();
      if (['high', 'normal', 'low'].includes(item.patch.priority)) patch.priority = item.patch.priority;
      if (Number.isFinite(item.patch.durationMinutes)) patch.durationMinutes = Math.max(1, Math.min(1440, item.patch.durationMinutes));
      actions.push({ type: 'update', id: item.id, patch });
    } else throw new Error('模型返回了不支持的任务操作');
  }
  return { reply: parsed.reply, actions };
}

export async function askAi(
  text: string, tasks: Task[], settings: SavedSettings,
  recent: { role: string; text: string }[], now = new Date(),
): Promise<AiResult> {
  const url = new URL(settings.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址需要以 https:// 或 http:// 开头');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const system = `你是“慢慢 Momo”，温柔、简洁、可靠的个人日程小伙伴。当前本地时间 ${now.toString()}，时区 ${timezone}，ISO时间 ${now.toISOString()}。
根据用户本次消息记事、完成任务、调整时间、聊天或给出时间安排建议。只有用户明确要求修改时才操作已有任务；安排建议只建议，不自动移动任务。没有明确时间时 dueAt=null 并说明未设置定时提醒；含糊或可能误解的时间先追问。保留用户指定日期，不擅自顺延。所有日期使用带时区偏移或Z的ISO8601，不要无时区字符串。durationMinutes是预计耗时，不是提前提醒时间。若用户同时要事件时间与提前提醒，第一版仅支持单个提醒时间，使用提前提醒时间并在标题写明实际事件时间。
只返回JSON，不要Markdown，结构：{"reply":"给用户的简短回复","actions":[]}。
actions支持：{"type":"create","task":{"title":"事项","dueAt":null,"priority":"normal","durationMinutes":30}}，{"type":"complete","id":"已有ID"}，{"type":"update","id":"已有ID","patch":{"dueAt":"ISO8601"}}。priority可用high/normal/low，不生成删除操作。不能声称已经执行不在actions中的修改。
当前任务（id仅用于操作）：${JSON.stringify(tasks.map(({ id, title, dueAt, durationMinutes, priority, status }) => ({ id, title, dueAt, durationMinutes, priority, status })))}`;
  const response = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(35_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model, temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        ...recent.slice(-10).map(message => ({ role: message.role, content: message.text })),
        { role: 'user', content: text },
      ],
    }),
  });
  if (!response.ok) {
    const reason = response.status === 401 ? 'API Key 无效或未获授权' : response.status === 429 ? '接口额度不足或请求过于频繁' : `接口返回 HTTP ${response.status}`;
    throw new Error(reason);
  }
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型没有返回内容');
  return parseAiResult(content, tasks);
}
