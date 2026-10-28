import { ChevronDown, ChevronRight, CircleAlert, Database, FileText, LoaderCircle, MessageSquareText, PanelLeft, Plus, RotateCcw, Search, Send, Sparkles, Tags, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { MarkdownReader } from '../components/MarkdownReader';
import { conversationHistory, conversationStorageKey, createLocalId, readConversations, sourceTitle, type Conversation, type Model, type Platform, type Retrieval, type Source, type Turn } from '../knowledge/conversations';
import { filterChatModels, knowledgeModelKey, readEnabledChatModelKeys, readSelectedKnowledgeModelKey, saveSelectedKnowledgeModelKey } from '../knowledge/model-selection';
import { SourceDrawer } from '../knowledge/SourceDrawer';
import { readServerEvents } from '../knowledge/stream';
import '../knowledge/knowledge.css';

// Adapted from backup/IMDM/manage/apps/web/src/pages/InsightsPage.tsx.
// Runtime code and styles live here; no dependency on the backup application.
const suggestionGroups = [
  { label: '论文主题', items: ['论文中常见的检索增强生成方法有哪些？', '如何梳理一个研究主题的关键论文与发展脉络？', '不同论文对同一问题的实验设置有哪些差异？', '如何从论文中提取可复用的数据集与评价指标？'] },
  { label: '研究方法', items: ['论文中如何说明研究问题、方法和实验结论？', '如何比较多篇论文的研究假设、模型和实验结果？'] }
];

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({})) as T & { detail?: string; error?: string };
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : payload.error ?? '请求失败。');
  return payload;
}

interface AnswerModel extends Model { platformId: string; key: string; }

async function streamAnswer(path: string, options: RequestInit, onDelta: (content: string) => void) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { detail?: string; error?: string };
    throw new Error(typeof payload.detail === 'string' ? payload.detail : payload.error ?? '请求失败。');
  }
  if (!response.body) throw new Error('当前浏览器不支持流式回答。');
  let answer = '';
  let finalAnswer = '';
  await readServerEvents(response.body, ({ event, data }) => {
    const payload = data as { content?: string; answer?: string; error?: string };
    if (event === 'delta' && typeof payload.content === 'string') {
      answer += payload.content;
      onDelta(payload.content);
    } else if (event === 'done') {
      finalAnswer = typeof payload.answer === 'string' ? payload.answer : answer;
    } else if (event === 'error') {
      throw new Error(payload.error || '生成回答失败。');
    }
  });
  const result = finalAnswer || answer;
  if (!result.trim()) throw new Error('模型未返回文本回答。');
  return { answer: result };
}

function savedSidebarWidth() {
  try {
    const stored = Number(localStorage.getItem('paperbox-knowledge-sidebar-width'));
    return Number.isFinite(stored) && stored > 0 ? Math.min(480, Math.max(190, stored)) : 260;
  } catch { return 260; }
}

export function KnowledgePage() {
  const [conversations, setConversations] = useState(readConversations);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const saved = readConversations();
    try { const id = localStorage.getItem('paperbox-knowledge-selected'); return saved.some((item) => item.id === id) ? id : saved[0]?.id ?? null; }
    catch { return saved[0]?.id ?? null; }
  });
  const [input, setInput] = useState('');
  const [historyQuery, setHistoryQuery] = useState('');
  const [models, setModels] = useState<AnswerModel[]>([]);
  const [modelKey, setModelKey] = useState(readSelectedKnowledgeModelKey);
  const [loadingModels, setLoadingModels] = useState(true);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ conversationId: string; turnId: string; stage: string } | null>(null);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [conversationWidth, setConversationWidth] = useState(savedSidebarWidth);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const messageScroll = useRef<HTMLDivElement>(null);
  const followLatestMessage = useRef(true);
  const previousSelectedId = useRef(selectedId);
  const running = useRef<AbortController | null>(null);
  const conversationStoreReady = useRef(false);
  const selected = conversations.find((item) => item.id === selectedId);
  const turns = selected?.turns ?? [];
  const selectedModel = models.find((item) => item.key === modelKey);

  useEffect(() => {
    try {
      // Context can always be rebuilt; retain the actual source excerpts for each turn.
      localStorage.setItem(conversationStorageKey, JSON.stringify(conversations.map((item) => ({ ...item,
        turns: item.turns.map((turn) => ({ ...turn, retrieval: turn.retrieval ? { ...turn.retrieval, context: '' } : null })) }))));
      setStorageError('');
    } catch { setStorageError('浏览器存储空间不足，会话暂时仅保留在本页。可删除旧会话后重试。'); }
    if (!conversationStoreReady.current) return;
    const durable = conversations.map((item) => ({ ...item, turns: item.turns.map((turn) => ({ ...turn, retrieval: turn.retrieval ? { ...turn.retrieval, context: '' } : null })) }));
    void request('/api/conversations/knowledge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversations: durable }) })
      .catch(() => setStorageError('服务器会话保存失败；当前副本仍保留在浏览器中。'));
  }, [conversations]);
  useEffect(() => {
    let cancelled = false;
    void request<{ conversations?: Conversation[] }>('/api/conversations/knowledge').then((payload) => {
      if (cancelled) return;
      const remote = Array.isArray(payload.conversations) ? payload.conversations : [];
      if (remote.length) {
        setConversations(remote);
        setSelectedId((current) => remote.some((item) => item.id === current) ? current : remote[0]?.id ?? null);
      } else if (conversations.length) {
        const durable = conversations.map((item) => ({ ...item, turns: item.turns.map((turn) => ({ ...turn, retrieval: turn.retrieval ? { ...turn.retrieval, context: '' } : null })) }));
        void request('/api/conversations/knowledge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversations: durable }) })
          .catch(() => setStorageError('旧会话迁移到服务器失败；当前副本仍保留在浏览器中。'));
      }
      conversationStoreReady.current = true;
    }).catch(() => {
      conversationStoreReady.current = true;
      setStorageError('无法连接服务器会话库；当前使用浏览器本地副本。');
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { try { localStorage.setItem('paperbox-knowledge-selected', selectedId ?? ''); } catch { /* The persistence notice above covers unavailable storage. */ } }, [selectedId]);
  useEffect(() => {
    if (modelKey && !saveSelectedKnowledgeModelKey(modelKey)) setNotice('浏览器无法保存所选模型，本次选择仅在当前页面有效。');
  }, [modelKey]);
  useEffect(() => {
    const element = messageScroll.current;
    if (previousSelectedId.current !== selectedId) {
      previousSelectedId.current = selectedId;
      followLatestMessage.current = true;
    }
    if (element && followLatestMessage.current) element.scrollTop = element.scrollHeight;
  }, [selectedId, turns.length, turns.at(-1)?.answer, pending?.stage, streamingAnswer]);
  useEffect(() => { if (!pending) textarea.current?.focus(); }, [selectedId, pending]);
  useEffect(() => () => running.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const loadModels = async () => {
      try {
        const available = await request<{ platforms?: Platform[] }>('/model-api/platforms', { signal: controller.signal });
        const choices = await Promise.all((available.platforms ?? []).map(async (platform) => {
          const cache = await request<{ models?: Model[]; selection?: { persisted?: boolean; enabledModelIds?: string[] } }>(`/model-api/cache?platformId=${encodeURIComponent(platform.id)}`, { signal: controller.signal });
          const allModels = filterChatModels(cache.models ?? []).map((model) => ({ ...model, platformId: platform.id, key: knowledgeModelKey(platform.id, model.id) }));
          const selectedIds = cache.selection?.persisted ? new Set(cache.selection.enabledModelIds ?? []) : new Set(readEnabledChatModelKeys().filter((key) => key.startsWith(`${platform.id}:`)).map((key) => key.slice(platform.id.length + 1)));
          return allModels.filter((model) => selectedIds.has(model.id));
        }));
        const next = choices.flat();
        setModels(next);
        const preferredKey = readSelectedKnowledgeModelKey();
        setModelKey((current) => next.find((item) => item.key === preferredKey)?.key
          ?? next.find((item) => item.key === current)?.key
          ?? next[0]?.key
          ?? '');
      } catch (error) { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : '无法读取模型配置。'); }
      finally { if (!controller.signal.aborted) setLoadingModels(false); }
    };
    void loadModels();
    return () => controller.abort();
  }, []);

  const updateTurn = (conversationId: string, turnId: string, update: Partial<Turn>) => {
    setConversations((items) => items.map((item) => item.id !== conversationId ? item : { ...item, updatedAt: new Date().toISOString(), turns: item.turns.map((turn) => turn.id === turnId ? { ...turn, ...update } : turn) }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  };
  const startNew = () => { setSelectedId(null); setInput(''); setNotice(''); setDeleteId(null); setMobileHistoryOpen(false); textarea.current?.focus(); };
  const remove = (id: string) => {
    setConversations((items) => items.filter((item) => item.id !== id));
    if (selectedId === id) { setSelectedId(conversations.find((item) => item.id !== id)?.id ?? null); setInput(''); }
    setDeleteId(null);
  };

  const send = async (preset?: string, retryId?: string) => {
    const question = (preset ?? input).trim();
    if (!question || running.current) return;
    if (!selectedModel) { setNotice('请先到“模型选择”勾选一个可用于文本生成的模型。'); return; }
    const conversationId = selectedId ?? createLocalId();
    const turnId = retryId ?? createLocalId();
    const history = conversationHistory(retryId ? turns.slice(0, turns.findIndex((item) => item.id === retryId)) : turns);
    const turn: Turn = { id: turnId, question, answer: '', model: selectedModel.name, retrieval: null };
    const controller = new AbortController();
    running.current = controller;
    followLatestMessage.current = true;
    const setStage = (stage: string) => setPending({ conversationId, turnId, stage });
    setStage('解析问题并检索论文…'); setNotice(''); setInput('');
    if (textarea.current) textarea.current.style.height = 'auto';
    if (!selectedId) {
      setConversations((items) => [{ id: conversationId, title: question.slice(0, 40), updatedAt: new Date().toISOString(), turns: [turn] }, ...items]);
      setSelectedId(conversationId);
    } else if (retryId) updateTurn(conversationId, turnId, { ...turn, error: undefined });
    else setConversations((items) => items.map((item) => item.id !== conversationId ? item : { ...item, turns: [...item.turns, turn] }));
    try {
      const retrieval = await request<Retrieval>('/api/knowledge/retrieve', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, limit: 12, previous_questions: history.filter((item) => item.role === 'user').map((item) => item.content) }) });
      updateTurn(conversationId, turnId, { retrieval });
      if (!retrieval.context.trim()) throw new Error('没有检索到可用于回答的论文片段，请补充论文主题、方法或数据集名称。');
      setStage('正在依据检索论文生成回答…');
      const generated = await streamAnswer('/model-api/chat/stream', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platformId: selectedModel.platformId, model: selectedModel.id, question, context: retrieval.context, history }) }, (content) => setStreamingAnswer((current) => current + content));
      if (!generated.answer?.trim()) throw new Error('模型未返回文本回答。');
      updateTurn(conversationId, turnId, { answer: generated.answer });
    } catch (error) {
      if (!controller.signal.aborted) updateTurn(conversationId, turnId, { error: error instanceof Error ? error.message : '知识问答失败。' });
    } finally { if (running.current === controller) { running.current = null; setPending(null); setStreamingAnswer(''); } }
  };

  const sendSafely = (preset?: string, retryId?: string) => {
    void send(preset, retryId).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : '无法开始问答，请重试。');
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendSafely(); }
  };
  const resize = (event: PointerEvent<HTMLDivElement>, finish = false) => {
    if (!resizeStart.current) return;
    const width = Math.min(480, Math.max(190, resizeStart.current.width + event.clientX - resizeStart.current.x));
    setConversationWidth(width);
    if (finish) {
      resizeStart.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      try { localStorage.setItem('paperbox-knowledge-sidebar-width', String(width)); } catch { /* Optional preference. */ }
    }
  };
  const visibleConversations = conversations.filter((item) => `${item.title} ${item.turns.map((turn) => turn.question).join(' ')}`.toLowerCase().includes(historyQuery.toLowerCase()));
  const conversationPendingDeletion = deleteId ? conversations.find((item) => item.id === deleteId) : null;
  const handleMessageScroll = () => {
    const element = messageScroll.current;
    if (element) followLatestMessage.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;
  };

  return <><div className={`insights-page${mobileHistoryOpen ? ' mobile-history-open' : ''}`} style={{ '--insight-conversation-width': `${conversationWidth}px` } as CSSProperties}>
    <aside className="insight-conversations" aria-label="历史会话">
      <div className="insight-sidebar-head"><button className="insight-new" onClick={startNew}><Plus size={16} />新会话</button><label className="insight-history-search"><Search size={14} /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} aria-label="搜索历史会话" placeholder="搜索历史会话" /></label></div>
      <div className="insight-conversation-list">{visibleConversations.length ? visibleConversations.map((item) => <div key={item.id} className={`insight-conversation-item${selectedId === item.id ? ' active' : ''}`}>
        <button onClick={() => { setSelectedId(item.id); setInput(''); setNotice(''); setDeleteId(null); setMobileHistoryOpen(false); }}><MessageSquareText size={16} /><span><strong>{item.title}</strong><small>{item.turns.at(-1)?.answer || item.turns.at(-1)?.question || '新对话'}</small></span></button>
        <button className="insight-delete" aria-label={`删除会话：${item.title}`} disabled={pending?.conversationId === item.id} onClick={() => setDeleteId(item.id)}><Trash2 size={14} /></button>
      </div>) : <div className="insight-list-empty"><MessageSquareText size={25} /><span>{historyQuery ? '没有匹配的会话' : '暂无对话'}</span></div>}</div>
      <div className="insight-sidebar-foot">会话保存在当前浏览器</div>
    </aside>
    {mobileHistoryOpen && <button className="insight-sidebar-backdrop" aria-label="关闭历史会话" onClick={() => setMobileHistoryOpen(false)} />}
    <div className="insight-conversation-resizer" role="separator" aria-label="调整对话列表宽度" aria-orientation="vertical" onPointerDown={(event) => { resizeStart.current = { x: event.clientX, width: conversationWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => resize(event)} onPointerUp={(event) => resize(event, true)} onPointerCancel={(event) => resize(event, true)} />
    <main className="insight-chat">
      <header className="insight-chat-toolbar"><div className="insight-toolbar-title"><button className="insight-mobile-history-toggle" aria-label="历史会话" title="历史会话" onClick={() => setMobileHistoryOpen(true)}><PanelLeft size={17} /></button><MessageSquareText size={18} /><strong>知识问答</strong></div><label>模型<select value={modelKey} disabled={!models.length || Boolean(pending)} onChange={(event) => setModelKey(event.target.value)} aria-label="回答模型">{models.length ? models.map((model) => <option key={model.key} value={model.key}>{model.name}</option>) : <option value="">{loadingModels ? '正在读取…' : '请先勾选模型'}</option>}</select></label></header>
      <div className="insight-message-scroll" ref={messageScroll} onScroll={handleMessageScroll}>
        {!turns.length ? <div className="insight-welcome"><span><Sparkles size={25} /></span><h2>想了解哪些论文知识？</h2><p>从论文内容中查找依据，围绕主题、方法与实验结果持续追问。</p><div className="insight-suggestion-groups">{suggestionGroups.map((group) => <section key={group.label}><small>{group.label}</small><div className="insight-suggestions">{group.items.map((suggestion) => <button key={suggestion} onClick={() => { setInput(suggestion); textarea.current?.focus(); }}>{suggestion}<ChevronRight size={14} /></button>)}</div></section>)}</div></div>
        : <div className="insight-message-list">{turns.map((turn, index) => <ChatTurn key={turn.id} turn={turn} stage={pending?.turnId === turn.id ? pending.stage : ''} streamingAnswer={pending?.turnId === turn.id ? streamingAnswer : ''} canRetry={!pending && index === turns.length - 1} onRetry={() => sendSafely(turn.question, turn.id)} onSource={setSource} />)}</div>}
      </div>
      <div className="insight-composer-shell">
        {(notice || storageError) && <div className="insight-notice" role="alert"><CircleAlert size={15} /><span>{notice || storageError}</span><button aria-label="关闭提示" onClick={() => { setNotice(''); setStorageError(''); }}>×</button></div>}
        {!loadingModels && !models.length && <div className="insight-model-hint">开始问答前，请先到<Link to="/models">模型选择</Link>中勾选至少一个文本生成模型。</div>}
        {pending && pending.conversationId !== selectedId && <div className="insight-model-hint">另一个会话正在生成回答。<button onClick={() => setSelectedId(pending.conversationId)}>查看会话</button></div>}
        <div className="insight-composer"><textarea ref={textarea} value={input} disabled={Boolean(pending)} rows={1} maxLength={4000} aria-label="输入论文问题" placeholder={turns.length ? '继续追问，或提出新的论文问题…' : '输入论文主题、方法或实验相关的问题…'} onChange={(event) => setInput(event.target.value)} onInput={(event) => { event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 150)}px`; }} onKeyDown={onInputKeyDown} /><button className="insight-send" aria-label="发送" title="发送" disabled={!input.trim() || Boolean(pending) || loadingModels || !selectedModel} onClick={() => sendSafely()}>{pending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div>
        <div className="insight-composer-foot"><span>Enter 发送 · Shift + Enter 换行</span><span>回答附论文引用，请核对原文</span></div>
      </div>
    </main>
    {source && <SourceDrawer source={source} onClose={() => setSource(null)} />}
  </div>
    {conversationPendingDeletion && <div className="insight-delete-modal-backdrop" role="presentation" onMouseDown={() => setDeleteId(null)}><section className="insight-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-conversation-title" onMouseDown={(event) => event.stopPropagation()}><h2 id="delete-conversation-title">删除这段会话？</h2><p>“{conversationPendingDeletion.title}”及其中的问答记录将从当前浏览器移除，此操作无法撤销。</p><div><button className="insight-delete-cancel" onClick={() => setDeleteId(null)}>取消</button><button className="insight-delete-confirm-action" onClick={() => remove(conversationPendingDeletion.id)}>删除会话</button></div></section></div>}
  </>;
}

function ChatTurn({ turn, stage, streamingAnswer, canRetry, onRetry, onSource }: { turn: Turn; stage: string; streamingAnswer: string; canRetry: boolean; onRetry(): void; onSource(source: Source): void }) {
  const retrieval = turn.retrieval;
  return <>
    <div className="insight-message user"><div className="insight-user-bubble">{turn.question}</div></div>
    <div className="insight-message assistant"><div className="insight-message-avatar"><Sparkles size={17} /></div><div className="insight-assistant-content">
      {turn.answer ? <div className="insight-answer"><MarkdownReader content={turn.answer} chapterPath="" renderCitation={(id) => {
        const source = retrieval?.sources.find((item) => item.id === id);
        return source ? <button className="insight-citation" title={`查看 ${sourceTitle(source).file} 原文`} onClick={() => onSource(source)}>[{id}]</button> : <span className="insight-invalid-citation" title="本轮资料中没有此编号">[{id}]</span>;
      }} /></div> : stage ? <>{streamingAnswer ? <div className="insight-answer insight-answer-streaming">{streamingAnswer}<span className="insight-stream-cursor" /></div> : <div className="insight-assistant-loading" role="status"><LoaderCircle className="spin" size={16} /><span>{stage}</span></div>}</> : <div className="insight-turn-error" role="alert"><CircleAlert size={16} /><span>{turn.error || '上次回答未完成，可重新生成。'}</span>{canRetry && <button onClick={onRetry}><RotateCcw size={13} />重试</button>}</div>}
      {retrieval && <div className="insight-execution"><div className="insight-execution-summary"><span><Database size={12} />{retrieval.sources.length} 个论文片段</span><span>{turn.model}</span></div>
        <details><summary><Tags size={15} />论文分类解析<ChevronDown size={14} /></summary><div className="insight-parsed"><div><small>分类</small>{retrieval.parsed.concepts.length ? retrieval.parsed.concepts.map((item) => <span key={item}>{item}</span>) : <em>未匹配到论文分类</em>}</div><div><small>实体</small>{retrieval.parsed.entities.length ? retrieval.parsed.entities.map((item) => <span key={item}>{item}</span>) : <em>未识别到命名实体</em>}</div></div></details>
        <details><summary><FileText size={15} />检索论文<ChevronDown size={14} /></summary><div className="insight-source-list">{retrieval.sources.map((source) => { const title = sourceTitle(source); return <button key={source.id} onClick={() => onSource(source)}><b>{source.id}</b><span><strong>{source.book || title.file}</strong><small>{title.chapter || title.file} · {source.line_start > 0 ? `第 ${source.line_start}–${source.line_end} 行` : '暂无行号'}</small></span><em title="向量余弦相似度">相似度 {source.score.toFixed(3)}</em><ChevronRight size={14} /></button>; })}{!retrieval.sources.length && <p>未找到匹配论文。</p>}</div></details>
      </div>}
    </div></div>
  </>;
}
