import { BookOpenCheck, FileText, FolderUp, LoaderCircle, PanelLeftClose, PanelLeftOpen, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { paperCatalog, type PaperDocument as MaterialDocument } from '../data/paperCatalog';
import { PdfReader } from '../components/PdfReader';

interface ContentResult { sourcePath: string; title: string; excerpt: string; page?: number; }
type PaperListItem = MaterialDocument & { processing?: boolean; jobId?: string; processingError?: string; };

export function TutorialPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部类型');
  const [papers, setPapers] = useState<PaperListItem[]>(paperCatalog);
  const [selectedId, setSelectedId] = useState<string | null>(paperCatalog[0]?.id ?? null);
  const [activePdfPage, setActivePdfPage] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [contentQuery, setContentQuery] = useState('');
  const [contentResults, setContentResults] = useState<ContentResult[]>([]);
  const [highlightQuery, setHighlightQuery] = useState('');
  const [searchingContent, setSearchingContent] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem('material-list-width')) || 360);
  const listWidthRef = useRef(listWidth);
  const libraryPageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const allCategories = useMemo(() => Array.from(new Set(papers.map((item) => item.category))), [papers]);

  useEffect(() => {
    let cancelled = false;
    fetch('/paper-api/catalog')
      .then(async (response) => {
        const payload = await response.json() as { papers?: typeof paperCatalog; error?: string };
        if (!response.ok) throw new Error(payload.error ?? '论文目录读取失败。');
        const catalog = payload.papers;
        if (!cancelled && catalog?.length) setPapers((current) => {
          const pending = new Map(current.filter((paper) => paper.processing).map((paper) => [paper.id, paper]));
          return catalog.map((paper) => pending.get(paper.id) ?? paper);
        });
      })
      .catch(() => { /* Keep the generated catalog available when the local file API is unavailable. */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const pending = papers.filter((paper) => paper.processing && paper.jobId);
    if (!pending.length) return;
    let cancelled = false;
    const check = async () => {
      const updates = await Promise.all(pending.map(async (paper) => {
        try {
          const response = await fetch(`/api/papers/imports/${encodeURIComponent(paper.jobId!)}`);
          const job = await response.json() as { state?: string; pages?: number; index?: { chunks_indexed?: number }; error?: string; paper?: PaperListItem };
          if (!response.ok || !job.state || job.state === 'queued' || job.state === 'processing') return null;
          return { id: paper.id, state: job.state, pages: job.pages, chunks: job.index?.chunks_indexed, error: job.error, paper: job.paper };
        } catch { return null; }
      }));
      if (cancelled) return;
      const completed = new Map(updates.filter((update): update is NonNullable<typeof update> => Boolean(update)).map((update) => [update.id, update]));
      if (!completed.size) return;
      setPapers((current) => current.map((paper) => {
        const update = completed.get(paper.id);
        if (!update) return paper;
        if (update.state === 'completed') return { ...paper, ...update.paper, processing: false, jobId: undefined, preview: update.paper?.preview ?? `已解析 ${update.pages ?? 0} 页，已建立 ${update.chunks ?? 0} 个向量块。` };
        if (update.state === 'cancelled') return { ...paper, processing: false, jobId: undefined, processingError: '论文处理已停止。', preview: '论文处理已停止。' };
        return { ...paper, processing: false, processingError: update.error ?? '论文处理失败。', preview: '论文处理失败。' };
      }));
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [papers]);

  const visibleMaterials = useMemo(() => papers.filter((item) => {
    const matchedCategory = category === '全部类型' || item.category === category;
    const text = `${item.title} ${item.category} ${item.preview} ${item.chapters.map((chapter) => chapter.title).join(' ')}`.toLowerCase();
    return matchedCategory && text.includes(query.trim().toLowerCase());
  }), [category, papers, query]);
  const selected = papers.find((item) => item.id === selectedId) ?? visibleMaterials[0] ?? null;

  useEffect(() => {
    if (selected && !visibleMaterials.some((item) => item.id === selected.id)) setSelectedId(visibleMaterials[0]?.id ?? null);
  }, [selected, visibleMaterials]);

  useEffect(() => {
    const document = papers.find((item) => item.id === selectedId);
    setActivePdfPage(1);
    setPdfPageCount(0);
    setContentResults([]);
    setContentQuery('');
    setHighlightQuery('');
  }, [papers, selectedId]);

  const importPaper = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setImportError('只能导入 PDF 文件。');
      return;
    }
    setImporting(true);
    setImportError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/papers/import', { method: 'POST', body: formData });
      const payload = await response.json() as { paper?: typeof paperCatalog[number]; error?: string; detail?: string };
      if (!response.ok || !payload.paper) throw new Error(payload.detail ?? payload.error ?? '论文导入失败。');
      setPapers((current) => [payload.paper!, ...current.filter((item) => item.id !== payload.paper!.id)]);
      setSelectedId(payload.paper.id);
      setCategory('全部类型');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '论文导入失败。');
    } finally {
      setImporting(false);
    }
  };

  const searchContent = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !contentQuery.trim()) return;
    setSearchingContent(true);
    setSearchError('');
    try {
      const response = await fetch(`/paper-api/search?scope=${encodeURIComponent(selected.sourcePath)}&query=${encodeURIComponent(contentQuery.trim())}`);
      const payload = await response.json() as { results?: ContentResult[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? '内容检索失败。');
      setContentResults(payload.results ?? []);
      setHighlightQuery(payload.results?.length ? contentQuery.trim() : '');
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : '内容检索失败。');
    } finally {
      setSearchingContent(false);
    }
  };

  const closeContentSearch = () => {
    setContentResults([]);
    setHighlightQuery('');
  };

  const deletePaper = async (paper: PaperListItem) => {
    if (paper.processing || deletingId) return;
    setDeletingId(paper.id);
    setImportError('');
    try {
      const response = await fetch(`/api/papers/${encodeURIComponent(paper.id)}`, { method: 'DELETE' });
      const payload = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? '删除论文失败。');
      setPapers((current) => current.filter((item) => item.id !== paper.id));
      if (selectedId === paper.id) setSelectedId(null);
      closeContentSearch();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '删除论文失败。');
    } finally {
      setDeletingId(null);
    }
  };

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = listWidthRef.current;
    let animationFrame = 0;
    let pendingWidth = startWidth;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-resizing-library');
    const resize = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pendingWidth = Math.max(190, Math.min(560, startWidth + moveEvent.clientX - startX));
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        listWidthRef.current = pendingWidth;
        libraryPageRef.current?.style.setProperty('--library-list-width', `${pendingWidth}px`);
      });
    };
    const stopResize = (stopEvent: globalThis.PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      listWidthRef.current = pendingWidth;
      libraryPageRef.current?.style.setProperty('--library-list-width', `${pendingWidth}px`);
      document.body.classList.remove('is-resizing-library');
      localStorage.setItem('material-list-width', String(listWidthRef.current));
      setListWidth(listWidthRef.current);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };

  return <div ref={libraryPageRef} className="library-page" style={{ '--library-list-width': `${listWidth}px` } as CSSProperties}>
    <aside className="library-list-panel">
      <div className="library-filter-bar">
        <label className="library-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索论文、章节" />{query && <button type="button" title="清除论文搜索" aria-label="清除论文搜索" onClick={() => { setQuery(''); closeContentSearch(); }}><X size={14} /></button>}</label>
        <label className="library-type"><SlidersHorizontal size={15} /><select value={category} onChange={(event) => setCategory(event.target.value)}><option>全部类型</option>{allCategories.map((item) => <option key={item}>{item}</option>)}</select></label>
      </div>
      <div className="library-list-summary">{category} · {visibleMaterials.length} 篇论文</div>
      <div className="library-document-list">{visibleMaterials.map((item) => <MaterialRow key={item.id} item={item} selected={item.id === selected?.id} deleting={deletingId === item.id} onSelect={() => setSelectedId(item.id)} onDelete={() => void deletePaper(item)} />)}{visibleMaterials.length === 0 && <div className="library-list-empty">没有匹配的论文</div>}</div>
    </aside>
    <div className="library-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整论文列表宽度" onPointerDown={startResize} />
    <section className="library-reader-panel">{selected ? <MaterialDetail item={selected} activePdfPage={activePdfPage} pdfPageCount={pdfPageCount} onSelectPdfPage={setActivePdfPage} onPageCountChange={setPdfPageCount} contentQuery={contentQuery} onContentQueryChange={setContentQuery} onClearContentSearch={() => { setContentQuery(''); closeContentSearch(); }} onSearch={searchContent} contentResults={contentResults} highlightQuery={highlightQuery} onCloseSearch={closeContentSearch} searchingContent={searchingContent} searchError={searchError} importing={importing} importError={importError} onImport={() => importInputRef.current?.click()} /> : <div className="materials-empty">未找到匹配论文</div>}</section>
    <input ref={importInputRef} className="library-import-input" type="file" accept="application/pdf,.pdf" onChange={importPaper} />
  </div>;
}

function MaterialRow({ item, selected, deleting, onSelect, onDelete }: { item: PaperListItem; selected: boolean; deleting: boolean; onSelect(): void; onDelete(): void }) {
  const publication = [item.venue || '未标注平台', item.year || '年份未标注'].join(' · ');
  return <div className={`material-row${selected ? ' active' : ''}`}><button className="material-row-select" onClick={onSelect}><span className="material-row-icon">{item.processing ? <LoaderCircle className="spin" size={18} /> : <BookOpenCheck size={18} />}</span><span className="material-row-content"><strong>{item.title}</strong><small>{item.processing ? '正在处理论文' : item.processingError ?? publication}</small></span></button><button type="button" className="material-row-delete" title="删除论文" aria-label={`删除论文：${item.title}`} disabled={item.processing || deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div>;
}

interface MaterialDetailProps {
  item: MaterialDocument; activePdfPage: number; pdfPageCount: number; onSelectPdfPage(page: number): void; onPageCountChange(count: number): void; contentQuery: string; onContentQueryChange(value: string): void; onClearContentSearch(): void; onSearch(event: FormEvent): void; contentResults: ContentResult[]; highlightQuery: string; onCloseSearch(): void; searchingContent: boolean; searchError: string; importing: boolean; importError: string; onImport(): void;
}

function MaterialDetail({ item, activePdfPage, pdfPageCount, onSelectPdfPage, onPageCountChange, contentQuery, onContentQueryChange, onClearContentSearch, onSearch, contentResults, highlightQuery, onCloseSearch, searchingContent, searchError, importing, importError, onImport }: MaterialDetailProps) {
  const [chapterPanelVisible, setChapterPanelVisible] = useState(() => localStorage.getItem('material-chapter-panel-visible') !== 'false');
  const [chapterPanelWidth, setChapterPanelWidth] = useState(() => Math.min(560, Math.max(220, Number(localStorage.getItem('material-chapter-panel-width')) || 320)));
  const chapterPanelWidthRef = useRef(chapterPanelWidth);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const startChapterResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = chapterPanelWidthRef.current;
    let animationFrame = 0;
    let pendingWidth = startWidth;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('is-resizing-chapters');
    const resize = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pendingWidth = Math.max(220, Math.min(560, startWidth + moveEvent.clientX - startX));
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        chapterPanelWidthRef.current = pendingWidth;
        workspaceRef.current?.style.setProperty('--chapter-panel-width', `${pendingWidth}px`);
      });
    };
    const stopResize = (stopEvent: globalThis.PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      chapterPanelWidthRef.current = pendingWidth;
      workspaceRef.current?.style.setProperty('--chapter-panel-width', `${pendingWidth}px`);
      document.body.classList.remove('is-resizing-chapters');
      localStorage.setItem('material-chapter-panel-width', String(chapterPanelWidthRef.current));
      setChapterPanelWidth(chapterPanelWidthRef.current);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };
  const toggleChapterPanel = () => {
    setChapterPanelVisible((visible) => {
      localStorage.setItem('material-chapter-panel-visible', String(!visible));
      return !visible;
    });
  };
  return <div className="library-detail">
    <div ref={workspaceRef} className={`library-workspace${chapterPanelVisible ? '' : ' is-chapter-panel-hidden'}`} style={{ '--chapter-panel-width': `${chapterPanelWidth}px` } as CSSProperties}>
      {chapterPanelVisible && <><aside className="library-summary-panel"><div className="library-chapter-heading"><button type="button" className="chapter-panel-close" title="收起内容摘要" aria-label="收起内容摘要" onClick={toggleChapterPanel}><PanelLeftClose size={15} /></button><span>内容摘要</span></div><div className="library-summary-scroll"><section className="library-summary-title"><strong>{item.title}</strong><small>{item.researchArea || item.category}</small></section><dl className="library-summary-meta"><div><dt>作者</dt><dd>{item.author || '未标注'}</dd></div><div><dt>研究领域</dt><dd>{item.researchArea || item.category || '未分类'}</dd></div></dl><section><h3>论文标签</h3><div className="library-summary-tags">{(item.tags?.length ? item.tags : [item.category]).map((tag) => <span key={tag}>{tag}</span>)}</div></section><section><h3>摘要</h3><p>{item.abstract || '暂无摘要信息。'}</p></section><section><h3>内容总结</h3><p>{item.summary || item.preview || '暂无内容总结。'}</p></section></div></aside><div className="chapter-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整内容摘要宽度" onPointerDown={startChapterResize} /></>}
      <article className="library-reading-panel" onClick={onCloseSearch}><div className="library-reader-toolbar">{!chapterPanelVisible && <button type="button" className="chapter-panel-toggle" title="打开内容摘要" aria-label="打开内容摘要" onClick={toggleChapterPanel}><PanelLeftOpen size={16} /></button>}<div title={item.title}><span>论文 PDF</span><small>{pdfPageCount ? `${activePdfPage} / ${pdfPageCount} 页` : '正在读取页数...'}</small></div><form onClick={(event) => event.stopPropagation()} onSubmit={onSearch}><label><Search size={15} /><input value={contentQuery} onChange={(event) => onContentQueryChange(event.target.value)} placeholder="检索 PDF 内容" />{contentQuery && <button type="button" className="library-clear-search" title="清除 PDF 检索" aria-label="清除 PDF 检索" onClick={onClearContentSearch}><X size={14} /></button>}</label><button type="submit" disabled={searchingContent || !contentQuery.trim() || !item.pdfPath}>{searchingContent ? <LoaderCircle className="spin" size={15} /> : '检索'}</button><button type="button" className="library-import-button" onClick={onImport} disabled={importing} title="导入新的论文 PDF"><FolderUp size={15} />{importing ? '导入中' : '导入'}</button></form></div>
        {searchError && <div className="library-message error">{searchError}</div>}
        {importError && <div className="library-message error">{importError}</div>}
        {contentResults.length > 0 && <div className="library-search-results" onClick={(event) => event.stopPropagation()}><header><strong>检索到 {contentResults.length} 处匹配</strong><button type="button" title="关闭检索结果" aria-label="关闭检索结果" onClick={onCloseSearch}><X size={15} /></button></header>{contentResults.map((result, index) => <button key={`${result.sourcePath}-${result.page ?? 0}-${index}`} onClick={() => onSelectPdfPage(result.page ?? 1)}><span>{result.page ? `第 ${result.page} 页 · ${result.title}` : result.title}</span><small>{result.excerpt}</small></button>)}</div>}
        {item.pdfPath ? <div className="library-pdf"><PdfReader src={`/paper-api/pdf?path=${encodeURIComponent(item.pdfPath)}`} activePage={activePdfPage} onPageCount={onPageCountChange} onCurrentPageChange={onSelectPdfPage} highlightQuery={highlightQuery} /></div> : <div className="library-pdf-empty"><FileText size={26} /><strong>暂无论文 PDF</strong><span>请点击右上角“导入”，选择要管理的论文 PDF 文件。</span><button type="button" onClick={onImport}><FolderUp size={15} />导入 PDF</button></div>}
      </article>
    </div>
  </div>;
}
