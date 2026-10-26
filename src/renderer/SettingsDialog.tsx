import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Bell, Brain, Check, CheckCircle2, CircleAlert, Clock3, KeyRound, LoaderCircle,
  Pencil, Plus, PlugZap, Save, Sparkles, Trash2, UserRound, X,
} from 'lucide-react';
import { api } from '../shared/client';
import type {
  AiConnectionResult, AppSnapshot, MemoryCategory, SettingsPatch, UserProfile,
} from '../shared/types';
import './settings.css';

type SettingsTab = 'connection' | 'profile' | 'memories';
interface SettingsDialogProps {
  state: AppSnapshot;
  initialTab?: SettingsTab;
  onClose: () => void;
  onUpdate: (state: AppSnapshot) => void;
  onNotice: (message: string) => void;
}

const categories: { value: MemoryCategory; label: string }[] = [
  { value: 'preference', label: '偏好' },
  { value: 'background', label: '个人背景' },
  { value: 'goal', label: '目标' },
  { value: 'routine', label: '作息习惯' },
  { value: 'other', label: '其他' },
];

const tabs: { id: SettingsTab; label: string; icon: typeof PlugZap }[] = [
  { id: 'connection', label: 'AI 连接', icon: PlugZap },
  { id: 'profile', label: '我的画像', icon: UserRound },
  { id: 'memories', label: '长期记忆', icon: Brain },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '这次没有保存成功，请再试一次。';
}

function updatedLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function SettingsDialog({ state, initialTab = 'connection', onClose, onUpdate, onNotice }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [baseUrl, setBaseUrl] = useState(state.settings.baseUrl);
  const [model, setModel] = useState(state.settings.model);
  const [protocol, setProtocol] = useState(state.settings.protocol || 'chat-completions');
  const [apiKey, setApiKey] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(state.settings.notificationsEnabled);
  const [alwaysOnTop, setAlwaysOnTop] = useState(state.settings.alwaysOnTop);
  const [profile, setProfile] = useState<UserProfile>(() => ({ ...state.profile }));
  const [connectionResult, setConnectionResult] = useState<AiConnectionResult | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [testingNotification, setTestingNotification] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null);
  const [memoryContent, setMemoryContent] = useState('');
  const [memoryCategory, setMemoryCategory] = useState<MemoryCategory>('other');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editingCategory, setEditingCategory] = useState<MemoryCategory>('other');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const connectionRevision = useRef(0);
  const alive = useRef(true);
  const headingId = useId();
  const tabPrefix = useId();

  closeRef.current = onClose;

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const frame = requestAnimationFrame(() => dialog?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      )].filter(element => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      alive.current = false;
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, []);

  function changedConnection() {
    connectionRevision.current += 1;
    setConnectionResult(null);
    setError('');
  }

  function connectionPatch(): SettingsPatch {
    const patch: SettingsPatch = { baseUrl: baseUrl.trim(), model: model.trim(), protocol };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    return patch;
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    if (!baseUrl.trim() || !model.trim()) { setError('请填写 API 地址和模型名称。'); return; }
    setSaving(true); setError('');
    try {
      const result = await api.saveSettings({ ...connectionPatch(), notificationsEnabled, alwaysOnTop });
      if (!alive.current) return;
      onUpdate(result); onNotice('设置已保存'); onClose();
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setSaving(false); }
  }

  async function testConnection() {
    if (!baseUrl.trim() || !model.trim()) { setError('请先填写 API 地址和模型名称。'); return; }
    const revision = connectionRevision.current;
    setTestingConnection(true); setError(''); setConnectionResult(null);
    try {
      const result = await api.testAiConnection(connectionPatch());
      if (alive.current && connectionRevision.current === revision) setConnectionResult(result);
    } catch (reason) {
      if (alive.current && connectionRevision.current === revision) {
        setConnectionResult({ ok: false, model: model.trim(), latencyMs: 0, message: errorMessage(reason) });
      }
    } finally { if (alive.current) setTestingConnection(false); }
  }

  async function clearKey() {
    setSaving(true); setError(''); changedConnection();
    try {
      const result = await api.saveSettings({ apiKey: '' });
      if (!alive.current) return;
      setApiKey(''); onUpdate(result); onNotice('已清除保存的 API 密钥');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setSaving(false); }
  }

  async function testNotification() {
    setTestingNotification(true); setError('');
    try {
      const result = await api.testNotification();
      if (alive.current) onNotice(result.supported ? '已发送测试通知，请查看系统通知' : '系统通知暂未获授权，应用内提醒仍会保留');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setTestingNotification(false); }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setSavingProfile(true); setError('');
    try {
      const result = await api.saveProfile(profile);
      if (!alive.current) return;
      onUpdate(result); setProfile(result.profile); onNotice('画像已保存，米卡会更了解你');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setSavingProfile(false); }
  }

  async function toggleMemory() {
    setMemoryBusy('toggle'); setError('');
    try {
      const result = await api.saveSettings({ memoryEnabled: !state.settings.memoryEnabled });
      if (!alive.current) return;
      onUpdate(result); onNotice(result.settings.memoryEnabled ? '已启用长期记忆' : '已暂停使用长期记忆，已有记忆仍保留');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setMemoryBusy(null); }
  }

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (!memoryContent.trim()) return;
    setMemoryBusy('add'); setError('');
    try {
      const result = await api.addMemory({ content: memoryContent.trim(), category: memoryCategory });
      if (!alive.current) return;
      onUpdate(result); setMemoryContent(''); onNotice('米卡记住了');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setMemoryBusy(null); }
  }

  async function updateMemory(event: FormEvent) {
    event.preventDefault();
    if (!editingId || !editingContent.trim()) return;
    setMemoryBusy(editingId); setError('');
    try {
      const result = await api.updateMemory(editingId, { content: editingContent.trim(), category: editingCategory });
      if (!alive.current) return;
      onUpdate(result); setEditingId(null); onNotice('记忆已更新');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setMemoryBusy(null); }
  }

  async function deleteMemory(id: string) {
    setMemoryBusy(id); setError('');
    try {
      const result = await api.deleteMemory(id);
      if (!alive.current) return;
      onUpdate(result); setDeletingId(null); if (editingId === id) setEditingId(null); onNotice('已删除这条记忆');
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setMemoryBusy(null); }
  }

  const memories = [...(state.memories || [])].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const personalFields: { name: keyof UserProfile; label: string; placeholder: string; multiline?: boolean }[] = [
    { name: 'name', label: '姓名 / 称呼', placeholder: '希望米卡怎么称呼你？' },
    { name: 'role', label: '身份 / 职业', placeholder: '例如：设计师、学生、独立开发者' },
    { name: 'about', label: '关于我', placeholder: '介绍一下你自己，让我们逐渐熟悉起来。', multiline: true },
    { name: 'goals', label: '近期目标', placeholder: '你最近希望完成或改变的事情。', multiline: true },
    { name: 'preferences', label: '偏好', placeholder: '你喜欢什么、在意什么，以及不喜欢什么。', multiline: true },
    { name: 'routine', label: '作息', placeholder: '例如：早上九点开始工作，晚上十一点睡觉。', multiline: true },
    { name: 'assistantStyle', label: '希望米卡如何回应', placeholder: '例如：简洁直接、温柔鼓励，或者先给建议再解释原因。', multiline: true },
  ];

  return <div className="settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} ref={dialogRef}>
      <header className="settings-heading">
        <div className="settings-heading-copy"><span className="settings-eyebrow">MIKA, A LITTLE CLOSER</span><h2 id={headingId}>和米卡更熟悉一点</h2><p>连接 AI，也让陪伴更像你喜欢的样子。</p></div>
        <button className="icon-button settings-close" type="button" aria-label="关闭设置" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab" id={`${tabPrefix}-${id}-tab`} aria-selected={tab === id} aria-controls={`${tabPrefix}-${id}-panel`} tabIndex={tab === id ? 0 : -1} className={`settings-tab ${tab === id ? 'settings-tab-active' : ''}`} onClick={() => { setTab(id); setError(''); }} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          setTab(tabs[next].id); setError(''); document.getElementById(`${tabPrefix}-${tabs[next].id}-tab`)?.focus();
        }}><Icon size={15} />{label}</button>)}
      </div>

      <div className="settings-body">
        {error && <p className="settings-error" role="alert"><CircleAlert size={15} /><span>{error}</span></p>}

        {tab === 'connection' && <section role="tabpanel" id={`${tabPrefix}-connection-panel`} aria-labelledby={`${tabPrefix}-connection-tab`}>
          <div className="settings-intro"><span className="settings-section-icon"><Sparkles size={18} /></span><div><h3>给米卡接上 AI</h3><p>使用你自己的 API 接口，让米卡自然地理解、聊天与思考。</p></div></div>
          {state.platform === 'browser' && <p className="settings-preview-note">当前是离线网页预览。画像与记忆可在此管理，AI 连接请使用桌面客户端。</p>}
          <form className="settings-form-stack" onSubmit={saveConnection}>
            <label className="settings-field">API 地址<input type="url" name="baseUrl" value={baseUrl} onChange={event => { setBaseUrl(event.target.value); changedConnection(); }} placeholder="https://api.openai.com/v1" required disabled={saving} /></label>
            <div className="settings-field-grid">
              <label className="settings-field">模型名称<input name="model" value={model} onChange={event => { setModel(event.target.value); changedConnection(); }} placeholder="gpt-6-luna" required disabled={saving} /></label>
              <label className="settings-field">接口协议<select name="protocol" aria-label="接口协议" value={protocol} onChange={event => { setProtocol(event.target.value as typeof protocol); changedConnection(); }} disabled={saving}><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select></label>
            </div>
            <p className="settings-field-help">模型名称请填写服务商实际提供的 ID，预填值不代表已验证可用。</p>
            <label className="settings-field">API 密钥<div className="settings-password-wrap"><KeyRound size={15} /><input type="password" name="apiKey" value={apiKey} onChange={event => { setApiKey(event.target.value); changedConnection(); }} placeholder={state.settings.apiKeyConfigured ? '已保存密钥，留空保留' : '输入服务商提供的 API Key'} autoComplete="off" spellCheck={false} disabled={saving} /></div></label>
            <div className="settings-key-actions"><span>{state.settings.apiKeyConfigured ? '已有保存的密钥；留空保存不会更改。' : '还没有保存 API 密钥。'}</span>{state.settings.apiKeyConfigured && <button className="settings-link-button settings-warm-link" type="button" onClick={clearKey} disabled={saving || testingConnection}><Trash2 size={12} />清除已保存的密钥</button>}</div>
            <div className="settings-test-row"><button className="secondary-button settings-test-button" type="button" disabled={testingConnection || saving || !baseUrl.trim() || !model.trim()} onClick={testConnection}>{testingConnection ? <LoaderCircle size={14} className="spin" /> : <PlugZap size={14} />}{testingConnection ? '正在测试连接…' : '测试连接'}</button><span>使用当前填写的配置测试，不会自动保存。</span></div>
            {connectionResult && <div className={`settings-connection-result ${connectionResult.ok ? 'settings-result-success' : 'settings-result-error'}`} role="status">{connectionResult.ok ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}<div><strong>{connectionResult.ok ? '本次连接测试成功' : '本次连接测试失败'}</strong><p>{connectionResult.message}</p><div className="settings-result-meta"><span>模型：{connectionResult.model || '未返回'}</span>{connectionResult.latencyMs > 0 && <span><Clock3 size={11} />{connectionResult.latencyMs} ms</span>}</div>{connectionResult.ok && <small>配置尚未自动保存，确认后点击“保存设置”。</small>}</div></div>}
            <div className="settings-rule" />
            <div className="settings-toggle-row"><div><strong>系统通知</strong><p>到点提醒你，应用内提醒也会保留。</p></div><button className={`settings-switch ${notificationsEnabled ? 'settings-switch-on' : ''}`} role="switch" aria-label="系统通知" aria-checked={notificationsEnabled} type="button" disabled={saving} onClick={() => setNotificationsEnabled(!notificationsEnabled)}><span /></button></div>
            <div className="settings-toggle-row"><div><strong>宠物始终置顶</strong><p>让米卡待在其他窗口上方。</p></div><button className={`settings-switch ${alwaysOnTop ? 'settings-switch-on' : ''}`} role="switch" aria-label="宠物始终置顶" aria-checked={alwaysOnTop} type="button" disabled={saving} onClick={() => setAlwaysOnTop(!alwaysOnTop)}><span /></button></div>
            <button className="settings-link-button settings-notification-test" type="button" disabled={testingNotification} onClick={testNotification}>{testingNotification ? <LoaderCircle size={14} className="spin" /> : <Bell size={14} />}测试系统通知</button>
            <footer className="settings-form-footer"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={saving || testingConnection}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存设置</button></footer>
          </form>
        </section>}

        {tab === 'profile' && <section role="tabpanel" id={`${tabPrefix}-profile-panel`} aria-labelledby={`${tabPrefix}-profile-tab`}>
          <div className="settings-intro"><span className="settings-section-icon"><UserRound size={18} /></span><div><h3>从认识你开始</h3><p>可以只填一两项，也可以以后随时补充。</p></div></div>
          <form className="settings-form-stack settings-profile-form" onSubmit={saveProfile}>
            <div className="settings-field-grid">{personalFields.slice(0, 2).map(field => <label className="settings-field" key={field.name}>{field.label}<input name={field.name} aria-label={field.label} value={profile[field.name]} onChange={event => setProfile({ ...profile, [field.name]: event.target.value })} placeholder={field.placeholder} maxLength={300} disabled={savingProfile} /></label>)}</div>
            {personalFields.slice(2).map(field => <label className="settings-field" key={field.name}>{field.label}<textarea name={field.name} aria-label={field.label} value={profile[field.name]} onChange={event => setProfile({ ...profile, [field.name]: event.target.value })} placeholder={field.placeholder} maxLength={4000} rows={2} disabled={savingProfile} /></label>)}
            <p className="settings-field-help settings-profile-note">启用长期记忆后，画像会用于个性化对话。你可以在“长期记忆”里控制是否启用。</p>
            <footer className="settings-form-footer"><span className="settings-soft-caption">你决定米卡了解你的程度。</span><button className="primary-button" type="submit" disabled={savingProfile}>{savingProfile ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存画像</button></footer>
          </form>
        </section>}

        {tab === 'memories' && <section role="tabpanel" id={`${tabPrefix}-memories-panel`} aria-labelledby={`${tabPrefix}-memories-tab`}>
          <div className="settings-intro"><span className="settings-section-icon"><Brain size={18} /></span><div><h3>那些值得记住的小事</h3><p>偏好、目标和生活习惯，让每次对话都多一点熟悉。</p></div></div>
          <div className="settings-memory-toggle"><div className="settings-toggle-row"><div><strong>启用长期记忆</strong><p>{state.settings.memoryEnabled ? '米卡会结合画像与记忆理解你。' : '当前暂停使用，已有内容仍可查看与管理。'}</p></div><button className={`settings-switch ${state.settings.memoryEnabled ? 'settings-switch-on' : ''}`} role="switch" aria-label="启用长期记忆" aria-checked={state.settings.memoryEnabled} type="button" disabled={memoryBusy !== null} onClick={toggleMemory}><span /></button></div><p className="settings-field-help">画像会用于个性化对话。启用此开关后，还会向所选 AI 服务发送并自动更新长期记忆；关闭后保留已有记忆。</p></div>
          <form className="settings-memory-add" onSubmit={addMemory}>
            <label className="settings-field">记忆内容<textarea name="memoryContent" aria-label="记忆内容" value={memoryContent} onChange={event => setMemoryContent(event.target.value)} placeholder="例如：我喜欢简洁直接的回答，下午通常更有精神。" rows={2} maxLength={2000} required disabled={memoryBusy !== null} /></label>
            <div className="settings-memory-add-footer"><label className="settings-field settings-category-field">记忆分类<select aria-label="记忆分类" value={memoryCategory} onChange={event => setMemoryCategory(event.target.value as MemoryCategory)} disabled={memoryBusy !== null}>{categories.map(category => <option value={category.value} key={category.value}>{category.label}</option>)}</select></label><button className="primary-button" type="submit" disabled={memoryBusy !== null || !memoryContent.trim()}>{memoryBusy === 'add' ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}添加记忆</button></div>
          </form>
          <div className="settings-memory-list-heading"><h4>已保存的记忆</h4><span>{memories.length} 条</span></div>
          {memories.length === 0 ? <div className="settings-memory-empty"><Brain size={27} strokeWidth={1.3} /><strong>一点一点，更加熟悉</strong><p>还没有保存的记忆。可以在上方添加，或在聊天中告诉米卡想让它记住的事。</p></div> : <div className="settings-memory-list">{memories.map(memory => <article className="settings-memory-card" key={memory.id}>
            {editingId === memory.id ? <form className="settings-memory-edit" onSubmit={updateMemory}><label className="settings-field">编辑记忆<textarea aria-label="编辑记忆" value={editingContent} onChange={event => setEditingContent(event.target.value)} rows={3} maxLength={2000} required autoFocus disabled={memoryBusy !== null} /></label><div className="settings-memory-edit-footer"><label className="settings-field settings-category-field">记忆分类<select aria-label="记忆分类" value={editingCategory} onChange={event => setEditingCategory(event.target.value as MemoryCategory)} disabled={memoryBusy !== null}>{categories.map(category => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label><div><button className="secondary-button" type="button" disabled={memoryBusy !== null} onClick={() => setEditingId(null)}>取消</button><button className="primary-button" type="submit" disabled={memoryBusy !== null || !editingContent.trim()}>{memoryBusy === memory.id ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}保存记忆</button></div></div></form> : <>
              <div className="settings-memory-card-top"><span className="settings-memory-category">{categories.find(category => category.value === memory.category)?.label || '其他'}</span><div className="settings-memory-actions"><button className="icon-button" type="button" aria-label={`编辑记忆 ${memory.content}`} title="编辑记忆" disabled={memoryBusy !== null} onClick={() => { setEditingId(memory.id); setEditingContent(memory.content); setEditingCategory(memory.category); setDeletingId(null); }}><Pencil size={13} /></button><button className="icon-button settings-delete-memory" type="button" aria-label={`删除记忆 ${memory.content}`} title="删除记忆" disabled={memoryBusy !== null} onClick={() => setDeletingId(deletingId === memory.id ? null : memory.id)}><Trash2 size={13} /></button></div></div>
              <p className="settings-memory-content">{memory.content}</p><div className="settings-memory-meta"><span>{memory.source === 'conversation' ? '来自对话' : '手动添加'}</span><span>更新于 {updatedLabel(memory.updatedAt || memory.createdAt)}</span></div>
              {deletingId === memory.id && <div className="settings-memory-delete-confirm"><span>让米卡忘记这条记忆？</span><div><button type="button" className="settings-link-button" disabled={memoryBusy !== null} onClick={() => setDeletingId(null)}>保留</button><button type="button" className="settings-delete-confirm-button" disabled={memoryBusy !== null} onClick={() => deleteMemory(memory.id)}>{memoryBusy === memory.id && <LoaderCircle size={12} className="spin" />}确认删除记忆</button></div></div>}
            </>}
          </article>)}</div>}
        </section>}
      </div>
    </div>
  </div>;
}
