import { BookOpen, ChevronRight, FileText, LoaderCircle, Search, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { MarkdownReader } from '../components/MarkdownReader';

interface DesignPattern {
  id: string;
  path: string;
  title: string;
  category: string;
  summary: string;
  source: string;
  searchText: string;
}

const selectedPatternKey = 'design-pattern-selected-id';
const patternListWidthKey = 'design-pattern-list-width';

function savedPatternListWidth() {
  try {
    const stored = Number(localStorage.getItem(patternListWidthKey));
    return Number.isFinite(stored) && stored > 0 ? Math.min(560, Math.max(240, stored)) : 290;
  } catch { return 290; }
}

function compactPatternTitle(title: string) { return title.trim(); }

export function PatternsPage() {
  const [listWidth, setListWidth] = useState(savedPatternListWidth);
  const listWidthRef = useRef(listWidth);
  const pageRef = useRef<HTMLDivElement>(null);
  const [patterns, setPatterns] = useState<DesignPattern[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(selectedPatternKey) ?? '');
  const [content, setContent] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState('');

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = listWidthRef.current;
    let animationFrame = 0;
    let pendingWidth = startWidth;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-resizing-pattern');
    const resize = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pendingWidth = Math.max(240, Math.min(560, startWidth + moveEvent.clientX - startX));
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        listWidthRef.current = pendingWidth;
        pageRef.current?.style.setProperty('--pattern-list-width', `${pendingWidth}px`);
      });
    };
    const stopResize = (stopEvent: globalThis.PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      listWidthRef.current = pendingWidth;
      pageRef.current?.style.setProperty('--pattern-list-width', `${pendingWidth}px`);
      document.body.classList.remove('is-resizing-pattern');
      try { localStorage.setItem(patternListWidthKey, String(pendingWidth)); } catch { /* Optional layout preference. */ }
      setListWidth(pendingWidth);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const nextWidth = Math.max(240, Math.min(560, listWidthRef.current + (event.key === 'ArrowRight' ? 16 : -16)));
    listWidthRef.current = nextWidth;
    pageRef.current?.style.setProperty('--pattern-list-width', `${nextWidth}px`);
    setListWidth(nextWidth);
    try { localStorage.setItem(patternListWidthKey, String(nextWidth)); } catch { /* Optional layout preference. */ }
  };

  useEffect(() => {
    let cancelled = false;
    fetch('/pattern-api/catalog')
      .then(async (response) => {
        const payload = await response.json() as { patterns?: DesignPattern[]; error?: string };
        if (!response.ok) throw new Error(payload.error ?? '提示管理目录读取失败。');
        if (!cancelled) {
          const records = payload.patterns ?? [];
          setPatterns(records);
          setSelectedId((current) => records.some((item) => item.id === current) ? current : records[0]?.id ?? '');
        }
      })
      .catch((error: Error) => { if (!cancelled) setCatalogError(error.message); })
      .finally(() => { if (!cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const visiblePatterns = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return patterns.filter((item) => !normalizedQuery || `${item.title} ${item.category} ${item.summary} ${item.source} ${item.searchText}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [patterns, query]);

  useEffect(() => {
    if (visiblePatterns.length && !visiblePatterns.some((item) => item.id === selectedId)) setSelectedId(visiblePatterns[0].id);
  }, [selectedId, visiblePatterns]);

  useEffect(() => {
    if (selectedId) localStorage.setItem(selectedPatternKey, selectedId);
  }, [selectedId]);

  const selected = visiblePatterns.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) {
      setContent('');
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContentError('');
    fetch(`/pattern-api/document?path=${encodeURIComponent(selected.path)}`)
      .then(async (response) => {
        const payload = await response.json() as { content?: string; error?: string };
        if (!response.ok) throw new Error(payload.error ?? '提示管理正文读取失败。');
        if (!cancelled) setContent(payload.content ?? '');
      })
      .catch((error: Error) => { if (!cancelled) setContentError(error.message); })
      .finally(() => { if (!cancelled) setContentLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.path]);

  return <div ref={pageRef} className="pattern-page" style={{ '--pattern-list-width': `${listWidth}px` } as CSSProperties}>
    <aside className="pattern-index">
      <label className="pattern-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提示方案" aria-label="搜索提示方案" />{query && <button type="button" title="清除搜索" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button>}<small aria-label={`显示 ${visiblePatterns.length} / ${patterns.length} 条`}>{catalogLoading ? '…' : `${visiblePatterns.length} / ${patterns.length}`}</small></label>
      <div className="pattern-list" aria-label="提示管理列表">
        {visiblePatterns.map((item) => <button type="button" key={item.id} className={`pattern-row${selected?.id === item.id ? ' active' : ''}`} onClick={() => setSelectedId(item.id)} aria-current={selected?.id === item.id ? 'true' : undefined}>
          <span className="pattern-row-icon"><FileText size={16} /></span>
          <span className="pattern-row-copy"><strong>{compactPatternTitle(item.title)}</strong><small>{item.category}</small></span>
          <ChevronRight className="pattern-row-chevron" size={15} />
        </button>)}
        {!catalogLoading && !catalogError && visiblePatterns.length === 0 && <div className="pattern-empty-list"><Search size={20} /><span>没有匹配的提示方案</span></div>}
        {catalogLoading && <div className="pattern-status"><LoaderCircle className="spin" size={17} /> 正在读取提示管理…</div>}
        {catalogError && <div className="pattern-status error">{catalogError}</div>}
      </div>
    </aside>

    <div className="pattern-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整提示管理列表宽度" aria-valuemin={240} aria-valuemax={560} aria-valuenow={listWidth} tabIndex={0} onPointerDown={startResize} onKeyDown={resizeWithKeyboard} />

    <main className="pattern-reader">
      {selected ? <>
        <header className="pattern-reader-toolbar">
          <div className="pattern-reader-title"><h2 title={compactPatternTitle(selected.title)}>{compactPatternTitle(selected.title)}</h2></div>
          {selected.source && <div className="pattern-reader-source" title={selected.source}><BookOpen size={15} /><span>{selected.source}</span></div>}
        </header>
        {contentLoading ? <div className="pattern-status reader-status"><LoaderCircle className="spin" size={18} /> 正在读取管理方案正文…</div>
          : contentError ? <div className="pattern-status error reader-status">{contentError}</div>
            : <article className="pattern-markdown"><MarkdownReader content={content.replace(/^\s*#\s+[^\n]+\n+/, '').replace(/^(?:分类|说明|适用位置)[:：].*\n/gm, '')} chapterPath={selected.path} /></article>}
      </> : <div className="pattern-reader-empty"><Workflow size={25} /><strong>{catalogError ? '提示管理库暂不可用' : '选择一个提示方案'}</strong><span>{catalogError ? '请检查本地提示管理文件接口是否可用。' : '提示方案的步骤、参数分支和校核要求会显示在这里。'}</span></div>}
    </main>
  </div>;
}
