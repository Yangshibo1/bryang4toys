import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowUp, Bell, Brain, CalendarDays, Check, ChevronRight,
  Clock3, Coffee, GripHorizontal, LoaderCircle, MessageCircle, MoreHorizontal,
  Pencil, Plus, Power, Settings2, Sparkles, Sun, Trash2, UserRound, X,
} from 'lucide-react';
import { api } from '../shared/client';
import type { AppSnapshot, Priority, Task, TaskInput } from '../shared/types';
import { Pet } from './Pet';
import { SettingsDialog } from './SettingsDialog';

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
  return <Modal title={initial ? '调整这件小事' : '记下一件小事'} subtitle={initial ? '计划可以变，米卡会帮你重新记好。' : '腾空脑袋，交给米卡记住。'} onClose={onClose}>
    <form onSubmit={submit} className="form-stack">
      <label>要做什么<input name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="例如：准备明天的会议材料" required /></label>
      <label>什么时候提醒<input name="dueAt" type="datetime-local" value={dueAt} onChange={e => setDueAt(e.target.value)} /><span className="field-help">留空会记入待办，暂不设置到点提醒。按这台电脑的当地时间。</span></label>
      <div className="form-columns"><label>优先级<select value={priority} onChange={e => setPriority(e.target.value as Priority)}><option value="normal">普通</option><option value="high">重要</option><option value="low">不着急</option></select></label><label>预计用时（分钟）<input type="number" min="1" max="1440" value={duration} onChange={e => setDuration(Number(e.target.value))} required /></label></div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="modal-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !title.trim()}>{saving ? <LoaderCircle size={16} className="spin" /> : initial ? <Check size={16} /> : <Plus size={16} />}{initial ? '保存修改' : '记下来了'}</button></div>
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
    <div className="pet-drag-handle" title="拖动米卡"><GripHorizontal size={21} /></div>
    <button className={`pet-bubble ${reminder ? 'has-reminder' : ''}`} onClick={() => api.openPanel()} title={reminder?.title || next?.title || '打开日程面板'}><span>{reminder ? '到时间啦！' : state.assistantBusy ? '让我想一想…' : happy ? '又做好了一件事！' : next ? timeLabel(next) : '有想法，随时和我说。'}</span>{(reminder || (!state.assistantBusy && next && !happy)) && <strong>{reminder?.title || next?.title}</strong>}</button>
    <button className="pet-character-button" onClick={() => api.togglePanel()} aria-label="打开米卡的聊天面板"><Pet className="desktop-character" state={mood} /><span className="pet-task-count">{pending.length ? `${pending.length} 件小事` : '米卡 Mika'}</span></button>
  </div>;
}

export function App() {
  const isPet = new URLSearchParams(window.location.search).get('view') === 'pet';
  const [state, setState] = useState<AppSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [filter, setFilter] = useState<Filter>('today');
  const [modal, setModal] = useState<'task' | 'settings' | null>(null);
  const [settingsTab, setSettingsTab] = useState<'connection' | 'profile' | 'memories'>('connection');
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
  function openSettings(tab: 'connection' | 'profile' | 'memories' = 'connection') { setSettingsTab(tab); setShowMenu(false); setModal('settings'); }
  function openCreate() { setEditTask(null); setModal('task'); }
  function openEdit(task: Task) { setEditTask(task); setModal('task'); }

  if (!state) return <div className={`loading-screen ${isPet ? 'pet-loading' : ''}`}><LoaderCircle size={23} className="spin" /><span>{error || '米卡正在醒来…'}</span>{error && <button className="secondary-button" onClick={() => window.location.reload()}>重新打开</button>}</div>;
  if (isPet) return <PetWindow state={state} />;

  const today = new Date(clock);
  const pending = state.tasks.filter(task => task.status === 'pending');
  const todayTasks = pending.filter(task => !task.dueAt || new Date(task.dueAt).getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime());
  const visibleTasks = [...state.tasks].filter(task => filter === 'completed' ? task.status === 'completed' : filter === 'all' ? task.status === 'pending' : todayTasks.some(item => item.id === task.id)).sort((a, b) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity));
  const upcoming = [...pending].filter(task => task.dueAt && Date.parse(task.dueAt) > clock).sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))[0];
    const prompt = (text: string) => { setInput(text); inputRef.current?.focus(); };

  return <div className={`app-shell ${state.platform === 'darwin' ? 'macos-shell' : ''}`}>
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Pet compact /></span><div><strong>米卡 <span>Mika</span></strong><small>你的私人 AI 助手</small></div></div>
      <div className="header-right"><button className={`mode-badge ${state.settings.apiKeyConfigured ? 'ai-mode' : ''}`} onClick={() => openSettings('connection')} aria-label="打开 AI 连接设置" title={state.settings.apiKeyConfigured ? `已配置 ${state.settings.model}，可在设置中测试连接` : '尚未连接 AI，目前仅支持离线记事规则'}><span /><b className="mode-label">{state.settings.apiKeyConfigured ? state.settings.model : '待连接 AI'}</b></button><button className="memory-nav-button" onClick={() => openSettings('memories')} aria-label="打开长期记忆" title="管理米卡对你的长期记忆"><Brain size={15} /><span>记忆</span><small>{state.memories.length}</small></button><div className="header-divider" /><button className="icon-button" onClick={() => openSettings('connection')} title="设置" aria-label="打开设置"><Settings2 size={18} /></button>{state.platform !== 'browser' && <button className="icon-button" onClick={() => api.hidePanel()} title="收起面板，米卡继续陪你" aria-label="收起到桌面"><ArrowDownToLine size={18} /></button>}<div className="menu-anchor"><button className="icon-button" onClick={() => setShowMenu(!showMenu)} aria-label="更多选项" aria-expanded={showMenu}><MoreHorizontal size={19} /></button>{showMenu && <div className="dropdown-menu"><button onClick={() => openSettings('connection')}><Settings2 size={14} />AI 连接与设置</button><button onClick={() => openSettings('profile')}><UserRound size={14} />我的画像</button><button onClick={() => openSettings('memories')}><Brain size={14} />长期记忆</button>{state.platform !== 'browser' && <button onClick={() => api.quit()}><Power size={14} />退出米卡（停止提醒）</button>}<button onClick={() => { setShowMenu(false); prompt('你能帮我做什么？'); }}><MessageCircle size={14} />和米卡打个招呼</button></div>}</div></div>
    </header>
    <section className="overview"><div><div className="eyebrow"><Sun size={13} />{today.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</div><h1>让每次对话，都更懂你<span>。</span></h1><p>聊聊想法，一起拆解目标，也记住对你重要的事。</p></div><button className="identity-summary" onClick={() => openSettings('profile')} aria-label="打开我的画像"><span className="identity-icon"><UserRound size={19} /></span><span><strong>{state.profile.name ? `你好，${state.profile.name}` : '让米卡认识你'}</strong><small>{state.profile.name ? '查看或更新我的画像' : '从你的目标与偏好开始'}</small></span><ChevronRight size={14} /></button></section>
    {state.platform === 'browser' && <div className="preview-note"><span className="preview-dot" />网页离线预览 · 任务、画像和记忆保存在此浏览器，真实 AI 对话请使用桌面客户端</div>}
    {state.reminders.length > 0 && <section className="reminder-stack" aria-live="assertive">{state.reminders.map(reminder => <div className="reminder-banner" key={reminder.taskId}><span className="reminder-icon"><Bell size={18} /></span><div><small>米卡来提醒你了</small><strong>{reminder.title}</strong></div><button onClick={() => { const task = state.tasks.find(item => item.id === reminder.taskId); if (task) void taskAction(task, 'toggle'); }} className="reminder-done"><Check size={14} />完成</button><button onClick={() => { const task = state.tasks.find(item => item.id === reminder.taskId); if (task) void taskAction(task, 'snooze'); }} className="reminder-later">稍后 10 分钟</button><button className="icon-button" onClick={() => void dismissReminder(reminder.taskId)} aria-label={`关闭提醒 ${reminder.title}`}><X size={16} /></button></div>)}</section>}
    <main className="workspace">
      <section className="chat-panel"><div className="panel-header"><h2><MessageCircle size={16} />和米卡聊聊</h2><span className="quiet-caption">想到什么，就说什么</span></div><div className="chat-scroll" role="log" aria-label="和米卡的对话" aria-live="polite">
        <div className="welcome-card"><div className="welcome-copy"><span className="little-label">MIKA · YOUR PERSONAL AI</span><h3>嗨，我是米卡<span> ✦</span></h3>{state.settings.apiKeyConfigured ? <p>带上你的经历、目标和偏好，<br />我们可以把事情聊得更深入。</p> : <><p>连接 AI，才能展开真正的对话。<br />离线时，我可以按简单规则记事和提醒。</p><button className="welcome-connect" onClick={() => openSettings('connection')}><Sparkles size={12} />连接 AI<ChevronRight size={12} /></button></>}</div><Pet className="welcome-pet" state={sending || state.assistantBusy ? 'thinking' : state.reminders.length ? 'reminder' : happy ? 'happy' : 'idle'} /></div>
        {state.messages.length === 0 && <div className="first-message"><span className="assistant-avatar"><Pet compact /></span><p>{state.settings.apiKeyConfigured ? '最近在忙什么，或者有什么想一起想清楚的事？' : '先连接你的 AI 服务，就可以开始聊想法、目标和生活。现在也可以用“10 分钟后提醒我喝水”这样的简单指令记事。'}</p></div>}
        {state.messages.map(message => <div className={`chat-message ${message.role}`} key={message.id}>{message.role === 'assistant' && <span className="assistant-avatar"><Pet compact /></span>}<div className="message-content"><div className="message-bubble">{message.text}</div><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time></div></div>)}
        {sending && <div className="chat-message assistant"><span className="assistant-avatar"><Pet compact state="thinking" /></span><div className="thinking" aria-label="米卡正在想"><i /><i /><i /></div></div>}<div ref={messagesEnd} />
      </div>
      <div className="composer-wrap"><div className="quick-prompts"><button disabled={sending} onClick={() => prompt('结合我的目标和最近的安排，帮我想想今天最值得专注的事情。')}><Sparkles size={12} />一起理理思路</button><button disabled={sending} onClick={() => openSettings('memories')}><Brain size={12} />米卡记住了什么</button><button disabled={sending} onClick={() => prompt('10分钟后提醒我喝水')}><Coffee size={12} />记个提醒</button></div><form className={`composer ${sending ? 'is-sending' : ''}`} onSubmit={event => { event.preventDefault(); void send(input); }}><textarea ref={inputRef} value={input} placeholder={state.settings.apiKeyConfigured ? '和米卡聊想法、目标，或者今天遇到的事…' : '离线记事：10 分钟后提醒我喝水…'} rows={1} maxLength={4000} aria-label="告诉米卡你的安排" onChange={event => { setInput(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 104)}px`; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }} /><button className="send-button" type="submit" disabled={sending || !input.trim()} aria-label="发送消息">{sending ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={19} />}</button></form><div className="composer-hint"><button onClick={() => openSettings(state.settings.apiKeyConfigured ? 'memories' : 'connection')}>{state.settings.apiKeyConfigured ? state.settings.memoryEnabled ? `长期记忆已开启 · ${state.memories.length} 条` : '长期记忆已关闭' : '离线记事 · 连接 AI 开始对话'}</button><span>Enter 发送 · Shift + Enter 换行</span></div></div>
      </section>
      <aside className="tasks-panel"><div className="panel-header"><h2><CalendarDays size={16} />每一件小事<span className="count-badge">{pending.length}</span></h2><button className="add-task-button" onClick={openCreate} aria-label="添加任务"><Plus size={17} /></button></div><div className="task-filters" role="tablist" aria-label="任务筛选">{([['today', '今天'], ['all', '全部待办'], ['completed', '已完成']] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="task-list">{visibleTasks.length ? visibleTasks.map(task => <TaskRow key={task.id} task={task} busy={busyTask === task.id} onChange={task => void taskAction(task, 'toggle')} onSnooze={task => void taskAction(task, 'snooze')} onDelete={task => void taskAction(task, 'delete')} onEdit={openEdit} />) : <div className="empty-tasks"><div className="empty-illustration"><CalendarDays size={35} strokeWidth={1.2} /><span><Check size={12} strokeWidth={3} /></span></div><h3>{filter === 'completed' ? '每一步都算数' : filter === 'today' ? '今天还有很多可能' : '脑袋空空，也很好'}</h3><p>{filter === 'completed' ? '完成一件小事后，就能在这里看到它。' : '告诉米卡你的计划，或手动记下一件小事。'}</p>{filter !== 'completed' && <button className="text-button" onClick={openCreate}>记下第一件事<ChevronRight size={13} /></button>}</div>}</div><div className="companion-note"><span className="note-spark">✧</span><div><strong>{upcoming ? '下一件小事' : '米卡的小叮咛'}</strong><p>{upcoming ? `${timeLabel(upcoming)} · ${upcoming.title}` : '计划里，也记得给休息留个位置。'}</p></div></div></aside>
    </main>
    <footer className="app-footer"><span><span className="status-dot" />{state.platform === 'browser' ? '在当前浏览器保存' : '在这台电脑安心记住'}</span><span>和米卡一起，把想法变成下一步。</span></footer>
    {error && <div className="error-toast" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={15} /></button></div>}
    {notice && <div className="notice-toast" role="status"><Check size={15} /><span>{notice}</span></div>}
    {modal === 'task' && <AddTask initial={editTask} onClose={() => setModal(null)} onCreate={async task => { setState(editTask ? await api.updateTask(editTask.id, task) : await api.createTask(task)); setFilter(task.dueAt && !sameDay(new Date(task.dueAt), today) ? 'all' : 'today'); setNotice(editTask ? '已重新记好这件事' : '好，米卡记住了'); }} />}
    {modal === 'settings' && <SettingsDialog state={state} initialTab={settingsTab} onClose={() => setModal(null)} onUpdate={setState} onNotice={setNotice} />}
  </div>;
}
