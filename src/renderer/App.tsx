import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowUp, Bell, CalendarDays, Check, CheckCheck, ChevronRight,
  Clock3, Coffee, GripHorizontal, LoaderCircle, MessageCircle, MoreHorizontal,
  Pencil, Plus, Power, Settings2, Sparkles, Sun, Trash2, X,
} from 'lucide-react';
import { api } from '../shared/client';
import type { AppSnapshot, Priority, SettingsPatch, Task, TaskInput } from '../shared/types';
import { Pet } from './Pet';

type Filter = 'today' | 'all' | 'completed';

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function timeLabel(task: Task) {
  if (!task.dueAt) return '待安排时间';
  const date = new Date(task.dueAt);
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay(date, now)) return `今天 ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(date, tomorrow)) return `明天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function isOverdue(task: Task) {
  return task.status === 'pending' && !!task.dueAt && new Date(task.dueAt).getTime() < Date.now();
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : '刚才没有成功，再试一次吧。';
}

function useHappyReaction(tasks: Task[] = []) {
  const [happy, setHappy] = useState(false);
  const latest = tasks.reduce((time, task) => task.status === 'completed' && task.completedAt ? Math.max(time, Date.parse(task.completedAt) || 0) : time, 0);
  useEffect(() => {
    const remaining = latest + 2400 - Date.now();
    setHappy(remaining > 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setHappy(false), remaining);
    return () => window.clearTimeout(timer);
  }, [latest]);
  return happy;
}

function Modal({ title, subtitle, children, onClose }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    (element?.querySelector<HTMLElement>('input, textarea, select') || element?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && element) {
        const focusable = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]'));
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button></div>
        {children}
      </div>
    </div>
  );
}

function localDateInput(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function AddTask({ initial, onClose, onCreate }: { initial?: Task | null; onClose: () => void; onCreate: (task: TaskInput) => Promise<void> }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [dueAt, setDueAt] = useState(localDateInput(initial?.dueAt));
  const [priority, setPriority] = useState<Priority>(initial?.priority || 'normal');
  const [duration, setDuration] = useState(initial?.durationMinutes || 30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true); setError('');
    try { await onCreate({ title: title.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null, priority, durationMinutes: duration }); onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }
  return <Modal title={initial ? '调整这件小事' : '记下一件小事'} subtitle={initial ? '计划可以变，慢慢会帮你重新记好。' : '腾空脑袋，交给慢慢记住。'} onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <label>要做什么<input name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="例如：准备明天的会议材料" required /></label>
      <label>什么时候提醒<input name="dueAt" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} /><span className="field-help">留空会记入待办，暂不设置到点提醒。按这台电脑的当地时间。</span></label>
      <div className="form-columns"><label>优先级<select value={priority} onChange={e => setPriority(e.target.value as Priority)}><option value="normal">普通</option><option value="high">重要</option><option value="low">不着急</option></select></label><label>预计用时（分钟）<input type="number" min="1" max="1440" value={duration} onChange={e => setDuration(Number(e.target.value))} required /></label></div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="modal-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : initial ? <Check size={16} /> : <Plus size={16} />}{initial ? '保存修改' : '记下来了'}</button></div>
    </form>
  </Modal>;
}

function Settings({ state, onClose, onUpdate, onNotice }: {
  state: AppSnapshot; onClose: () => void; onUpdate: (state: AppSnapshot) => void; onNotice: (message: string) => void;
}) {
  const [baseUrl, setBaseUrl] = useState(state.settings.baseUrl);
  const [model, setModel] = useState(state.settings.model);
  const [apiKey, setApiKey] = useState('');
  const [notificationsEnabled, setNotifications] = useState(state.settings.notificationsEnabled);
  const [alwaysOnTop, setAlwaysOnTop] = useState(state.settings.alwaysOnTop);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [keyConfigured, setKeyConfigured] = useState(state.settings.apiKeyConfigured);
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setSaving(true);
    const patch: SettingsPatch = { baseUrl: baseUrl.trim(), model: model.trim(), notificationsEnabled, alwaysOnTop };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    try { onUpdate(await api.saveSettings(patch)); onNotice('设置已保存'); onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }
  async function clearKey() {
    setSaving(true); setError('');
    try { onUpdate(await api.saveSettings({ apiKey: '' })); setKeyConfigured(false); setApiKey(''); onNotice('已清除密钥，切回本地模式'); }
    catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  }
  async function testNotification() {
    setTesting(true); setError('');
    try {
      const result = await api.testNotification();
      onNotice(result.supported ? '已发送测试通知，请查看系统通知' : '暂时无法显示系统通知，请检查通知授权；到点仍会显示应用内提醒');
    } catch (reason) { setError(errorText(reason)); }
    finally { setTesting(false); }
  }
  return <Modal title="慢慢的设置" subtitle="先轻松用起来，再给慢慢一点 AI 超能力。" onClose={onClose}>
    <form onSubmit={save} className="form-stack settings-form">
      <div className="settings-section-title"><Sparkles size={16} />AI 对话<span className="optional-pill">可选</span></div>
      <p className="settings-description">不配置也能记事、安排时间和提醒。连接兼容 OpenAI 的接口后，可以更自然地聊计划。</p>
      <label>API 地址<input type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" required /></label>
      <div className="form-columns"><label>模型名称<input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-chat" required /></label><label>API 密钥<input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={keyConfigured ? '已配置，留空保留' : '输入你的 API Key'} autoComplete="off" /></label></div>
      {keyConfigured && <button className="text-button clear-key" type="button" disabled={saving} onClick={clearKey}><Trash2 size={13} />清除已保存的密钥</button>}
      <div className="settings-divider" />
      <div className="setting-row"><div><strong>系统通知</strong><span>到点弹出通知，应用内提醒始终保留</span></div><button className={`switch ${notificationsEnabled ? 'on' : ''}`} type="button" role="switch" aria-label="系统通知" aria-checked={notificationsEnabled} onClick={() => setNotifications(!notificationsEnabled)}><span /></button></div>
      <div className="setting-row"><div><strong>宠物始终置顶</strong><span>让慢慢待在其他窗口上方</span></div><button className={`switch ${alwaysOnTop ? 'on' : ''}`} type="button" role="switch" aria-label="宠物始终置顶" aria-checked={alwaysOnTop} onClick={() => setAlwaysOnTop(!alwaysOnTop)}><span /></button></div>
      <button className="secondary-button notification-test" type="button" disabled={testing} onClick={testNotification}>{testing ? <LoaderCircle size={15} className="spin" /> : <Bell size={15} />}测试系统通知</button>
      {state.platform === 'browser' && <p className="field-help">网页预览会在页面打开时检查提醒；桌面常驻提醒请使用客户端。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving && <LoaderCircle size={15} className="spin" />}保存设置</button></div>
    </form>
  </Modal>;
}

function TaskRow({ task, busy, onChange, onSnooze, onDelete, onEdit }: {
  task: Task; busy: boolean; onChange: (task: Task) => void; onSnooze: (task: Task) => void; onDelete: (task: Task) => void; onEdit: (task: Task) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const completed = task.status === 'completed';
  return <article className={`task-card ${completed ? 'is-completed' : ''} ${isOverdue(task) ? 'is-overdue' : ''}`}>
    <button className={`task-check ${completed ? 'checked' : ''}`} aria-label={`${completed ? '重新打开' : '完成'} ${task.title}`} disabled={busy} onClick={() => onChange(task)}>{busy ? <LoaderCircle size={13} className="spin" /> : completed && <Check size={13} strokeWidth={3} />}</button>
    <div className="task-content"><button className="task-title task-title-button" onClick={() => onEdit(task)} title="修改这件事">{task.title}</button><div className="task-meta"><span className={isOverdue(task) ? 'overdue-time' : ''}><Clock3 size={11} />{timeLabel(task)}</span>{task.durationMinutes > 0 && <span>{task.durationMinutes} 分钟</span>}{task.priority === 'high' && <span className="priority-tag">重要</span>}{isOverdue(task) && <span className="overdue-tag">待跟进</span>}</div>
      {confirmDelete && <div className="delete-confirm"><span>移除这件事？</span><button onClick={() => onDelete(task)} disabled={busy}>移除</button><button onClick={() => setConfirmDelete(false)}>保留</button></div>}
    </div>
    <div className="task-actions"><button className="icon-button" disabled={busy} aria-label={`修改 ${task.title}`} title="修改任务" onClick={() => onEdit(task)}><Pencil size={13} /></button>{!completed && <button className="icon-button" disabled={busy || !task.dueAt} aria-label={`推迟十分钟 ${task.title}`} title="推迟十分钟" onClick={() => onSnooze(task)}><Clock3 size={14} /></button>}<button className="icon-button delete-task" disabled={busy} aria-label={`删除 ${task.title}`} title="删除任务" onClick={() => setConfirmDelete(!confirmDelete)}><Trash2 size={14} /></button></div>
  </article>;
}

function PetWindow({ state }: { state: AppSnapshot }) {
  const pending = state.tasks.filter(task => task.status === 'pending');
  const next = [...pending].filter(task => task.dueAt).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
  const reminder = state.reminders[0];
  const happy = useHappyReaction(state.tasks);
  const mood = reminder ? 'reminder' : state.assistantBusy ? 'thinking' : happy ? 'happy' : 'idle';
  return <div className="pet-desktop" onContextMenu={event => { event.preventDefault(); api.openPanel(); }}>
    <div className="pet-drag-handle" title="拖动慢慢"><GripHorizontal size={21} /></div>
    <button className={`pet-bubble ${reminder ? 'has-reminder' : ''}`} onClick={() => api.openPanel()} title={reminder?.title || next?.title || '打开日程面板'}><span>{reminder ? '到时间啦！' : state.assistantBusy ? '让我想一想…' : happy ? '又做好了一件事！' : next ? timeLabel(next) : '今天，也慢慢来。'}</span>{(reminder || (!state.assistantBusy && next && !happy)) && <strong>{reminder?.title || next?.title}</strong>}</button>
    <button className="pet-character-button" onClick={() => api.togglePanel()} aria-label="打开慢慢的聊天面板"><Pet className="desktop-character" state={mood} /><span className="pet-task-count">{pending.length ? `${pending.length} 件小事` : '慢慢 Momo'}</span></button>
  </div>;
}

export function App() {
  const isPet = new URLSearchParams(window.location.search).get('view') === 'pet';
  const [state, setState] = useState<AppSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [filter, setFilter] = useState<Filter>('today');
  const [modal, setModal] = useState<'task' | 'settings' | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestSequence = useRef(0);
  const happy = useHappyReaction(state?.tasks);

  useEffect(() => {
    document.body.classList.toggle('pet-body', isPet);
    let active = true;
    const unsubscribe = api.subscribe(value => { if (active) setState(value); });
    api.getState().then(value => { if (active) setState(value); }).catch(reason => { if (active) setError(errorText(reason)); });
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); document.body.classList.remove('pet-body'); };
  }, [isPet]);
  useEffect(() => {
    if ((state?.messages.length || 0) > 1 || sending) messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state?.messages.length, sending]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function send(text: string) {
    if (!text.trim() || sending) return;
    const sequence = ++requestSequence.current;
    setSending(true); setInput(''); setError('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    try { const next = await api.sendMessage(text.trim()); if (sequence === requestSequence.current) setState(next); }
    catch (reason) { setError(errorText(reason)); setInput(text); }
    finally { setSending(false); inputRef.current?.focus(); }
  }
  async function taskAction(task: Task, action: 'toggle' | 'snooze' | 'delete') {
    setBusyTask(task.id); setError('');
    try {
      const result = action === 'toggle' ? await api.updateTask(task.id, { status: task.status === 'completed' ? 'pending' : 'completed' }) : action === 'snooze' ? await api.snoozeTask(task.id, 10) : await api.deleteTask(task.id);
      setState(result);
      if (action === 'snooze') setNotice('记住了，十分钟后再提醒你');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusyTask(null); }
  }
  async function dismissReminder(taskId: string) {
    try { setState(await api.dismissReminder(taskId)); } catch (reason) { setError(errorText(reason)); }
  }
  function openCreate() { setEditTask(null); setModal('task'); }
  function openEdit(task: Task) { setEditTask(task); setModal('task'); }

  if (!state) return <div className={`loading-screen ${isPet ? 'pet-loading' : ''}`}><LoaderCircle size={23} className="spin" /><span>{error || '慢慢正在醒来…'}</span>{error && <button className="secondary-button" onClick={() => window.location.reload()}>重新打开</button>}</div>;
  if (isPet) return <PetWindow state={state} />;

  const today = new Date(clock);
  const pending = state.tasks.filter(task => task.status === 'pending');
  const todayCompleted = state.tasks.filter(task => task.status === 'completed' && task.completedAt && sameDay(new Date(task.completedAt), today)).length;
  const todayTasks = pending.filter(task => !task.dueAt || new Date(task.dueAt).getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime());
  const visibleTasks = [...state.tasks].filter(task => filter === 'completed' ? task.status === 'completed' : filter === 'all' ? task.status === 'pending' : todayTasks.some(item => item.id === task.id)).sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
  const upcoming = [...pending].filter(task => task.dueAt && Date.parse(task.dueAt) > clock).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
  const totalToday = todayTasks.length + todayCompleted;
  const progress = totalToday ? Math.round(todayCompleted / totalToday * 100) : 0;
  const prompt = (text: string) => { setInput(text); inputRef.current?.focus(); };

  return <div className={`app-shell ${state.platform === 'darwin' ? 'macos-shell' : ''}`}>
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Pet compact /></span><div><strong>慢慢 <span>Momo</span></strong><small>你的日程小伙伴</small></div></div>
      <div className="header-right"><span className={`mode-badge ${state.settings.apiKeyConfigured ? 'ai-mode' : ''}`}><span />{state.settings.apiKeyConfigured ? 'AI 已配置' : '本地模式'}</span><div className="header-divider" /><button className="icon-button" onClick={() => setModal('settings')} title="设置" aria-label="打开设置"><Settings2 size={18} /></button>{state.platform !== 'browser' && <button className="icon-button" onClick={() => api.hidePanel()} title="收起面板，慢慢继续陪你" aria-label="收起到桌面"><ArrowDownToLine size={18} /></button>}<div className="menu-anchor"><button className="icon-button" onClick={() => setShowMenu(!showMenu)} aria-label="更多选项" aria-expanded={showMenu}><MoreHorizontal size={19} /></button>{showMenu && <div className="dropdown-menu"><button onClick={() => { setShowMenu(false); setModal('settings'); }}><Settings2 size={14} />偏好设置</button>{state.platform !== 'browser' && <button onClick={() => api.quit()}><Power size={14} />退出慢慢（停止提醒）</button>}<button onClick={() => { setShowMenu(false); prompt('你能帮我做什么？'); }}><MessageCircle size={14} />和慢慢打个招呼</button></div>}</div></div>
    </header>
    <section className="overview"><div><div className="eyebrow"><Sun size={13} />{today.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</div><h1>留一点时间，给自己<span>。</span></h1><p>把事情交给慢慢，把注意力留给当下。</p></div><div className="daily-summary"><div className="summary-ring" style={{ '--progress': `${progress}%` } as CSSProperties}><CheckCheck size={22} /></div><div><strong>{todayCompleted}<span> / {totalToday}</span></strong><small>今天完成的小事</small></div></div></section>
    {state.platform === 'browser' && <div className="preview-note"><span className="preview-dot" />网页预览 · 数据保存在此浏览器，桌面常驻提醒需使用客户端</div>}
    {state.reminders.length > 0 && <section className="reminder-stack" aria-live="assertive">{state.reminders.map(reminder => <div className="reminder-banner" key={reminder.taskId}><span className="reminder-icon"><Bell size={18} /></span><div><small>慢慢来提醒你了</small><strong>{reminder.title}</strong></div><button onClick={() => { const task = state.tasks.find(item => item.id === reminder.taskId); if (task) void taskAction(task, 'toggle'); }} className="reminder-done"><Check size={14} />完成</button><button onClick={() => { const task = state.tasks.find(item => item.id === reminder.taskId); if (task) void taskAction(task, 'snooze'); }} className="reminder-later">稍后 10 分钟</button><button className="icon-button" onClick={() => void dismissReminder(reminder.taskId)} aria-label={`关闭提醒 ${reminder.title}`}><X size={16} /></button></div>)}</section>}
    <main className="workspace">
      <section className="chat-panel"><div className="panel-header"><h2><MessageCircle size={16} />和慢慢聊聊</h2><span className="quiet-caption">想到什么，就说什么</span></div><div className="chat-scroll" role="log" aria-label="和慢慢的对话" aria-live="polite">
        <div className="welcome-card"><div className="welcome-copy"><span className="little-label">YOUR LITTLE COMPANION</span><h3>嗨，我是慢慢<span> ✦</span></h3><p>你的计划、琐事和突发奇想，<br />我都愿意听。今天想先做点什么？</p></div><Pet className="welcome-pet" state={sending || state.assistantBusy ? 'thinking' : state.reminders.length ? 'reminder' : happy ? 'happy' : 'idle'} /></div>
        {state.messages.length === 0 && <div className="first-message"><span className="assistant-avatar"><Pet compact /></span><p>告诉我一件要做的事吧。比如“10 分钟后提醒我喝水”，或者让我帮你安排今天。</p></div>}
        {state.messages.map(message => <div className={`chat-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <span className="assistant-avatar"><Pet compact /></span>}<div className="message-content"><div className="message-bubble">{message.text}</div><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div></div>)}
        {sending && <div className="chat-message assistant"><span className="assistant-avatar"><Pet compact state="thinking" /></span><div className="thinking" aria-label="慢慢正在想"><i /><i /><i /></div></div>}<div ref={messagesEnd} />
      </div>
      <div className="composer-wrap"><div className="quick-prompts"><button disabled={sending} onClick={() => void send('帮我安排一下今天')}><Sparkles size={12} />安排今天</button><button disabled={sending} onClick={() => prompt('10分钟后提醒我喝水')}><Coffee size={12} />记个提醒</button><button disabled={sending} onClick={() => prompt('记一下买牛奶')}><Plus size={12} />随手记一件事</button></div><form className={`composer ${sending ? 'is-sending' : ''}`} onSubmit={event => { event.preventDefault(); void send(input); }}><textarea ref={inputRef} value={input} placeholder="明天下午三点提醒我开会…" rows={1} maxLength={4000} aria-label="告诉慢慢你的安排" onChange={event => { setInput(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 104)}px`; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} /><button className="send-button" type="submit" disabled={sending || !input.trim()} aria-label="发送消息">{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button></form><div className="composer-hint"><span>{state.settings.apiKeyConfigured ? 'AI 帮你理解，慢慢帮你记住' : '本地模式也能记事和提醒'}</span><span>Enter 发送 · Shift + Enter 换行</span></div></div>
      </section>
      <aside className="tasks-panel"><div className="panel-header"><h2><CalendarDays size={16} />每一件小事<span className="count-badge">{pending.length}</span></h2><button className="add-task-button" onClick={openCreate} aria-label="添加任务"><Plus size={17} /></button></div><div className="task-filters" role="tablist" aria-label="任务筛选">{([['today', '今天'], ['all', '全部待办'], ['completed', '已完成']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="task-list">{visibleTasks.length ? visibleTasks.map(task => <TaskRow key={task.id} task={task} busy={busyTask === task.id} onChange={task => void taskAction(task, 'toggle')} onSnooze={task => void taskAction(task, 'snooze')} onDelete={task => void taskAction(task, 'delete')} onEdit={openEdit} />) : <div className="empty-tasks"><div className="empty-illustration"><CalendarDays size={35} strokeWidth={1.2} /><span><Check size={12} strokeWidth={3} /></span></div><h3>{filter === 'completed' ? '每一步都算数' : filter === 'today' ? '今天还有很多可能' : '脑袋空空，也很好'}</h3><p>{filter === 'completed' ? '完成一件小事后，就能在这里看到它。' : '告诉慢慢你的计划，或手动记下一件小事。'}</p>{filter !== 'completed' && <button className="text-button" onClick={openCreate}>记下第一件事<ChevronRight size={13} /></button>}</div>}</div><div className="companion-note"><span className="note-spark">✧</span><div><strong>{upcoming ? '下一件小事' : '慢慢的小叮咛'}</strong><p>{upcoming ? `${timeLabel(upcoming)} · ${upcoming.title}` : '计划里，也记得给休息留个位置。'}</p></div></div></aside>
    </main>
    <footer className="app-footer"><span><span className="status-dot" />{state.platform === 'browser' ? '在当前浏览器保存' : '在这台电脑安心记住'}</span><span>不必赶路，慢慢也会到。</span></footer>
    {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={15} /></button></div>}
    {notice && <div className="notice-toast" role="status"><Check size={15} /><span>{notice}</span></div>}
    {modal === 'task' && <AddTask initial={editTask} onClose={() => setModal(null)} onCreate={async task => { setState(editTask ? await api.updateTask(editTask.id, task) : await api.createTask(task)); setFilter(task.dueAt && !sameDay(new Date(task.dueAt), today) ? 'all' : 'today'); setNotice(editTask ? '已重新记好这件事' : '好，慢慢记住了'); }} />}
    {modal === 'settings' && <Settings state={state} onClose={() => setModal(null)} onUpdate={setState} onNotice={setNotice} />}
  </div>;
}
