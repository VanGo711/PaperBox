import { BookOpenCheck, FileText, FolderUp, LoaderCircle, PanelRightClose, PanelRightOpen, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { type PaperDocument as MaterialDocument } from '../data/paperCatalog';
import { PdfReader } from '../components/PdfReader';
import { demoPaperCatalog, searchDemoPaper } from '../demo/runtime';

interface ContentResult { sourcePath: string; title: string; before: string; match: string; after: string; page?: number; }
type PaperListItem = MaterialDocument & { processing?: boolean; jobId?: string; processingError?: string; };

export function TutorialPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部类型');
  const [papers, setPapers] = useState<PaperListItem[]>(demoPaperCatalog);
  const [selectedId, setSelectedId] = useState<string | null>(demoPaperCatalog()[0]?.id ?? null);
  const [activePdfPage, setActivePdfPage] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<PaperListItem | null>(null);
  const [contentQuery, setContentQuery] = useState('');
  const [contentResults, setContentResults] = useState<ContentResult[]>([]);
  const [contentMatchCount, setContentMatchCount] = useState(0);
  const [highlightQuery, setHighlightQuery] = useState('');
  const [searchingContent, setSearchingContent] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [listWidth, setListWidth] = useState(() => Number(localStorage.getItem('material-list-width')) || 360);
  const listWidthRef = useRef(listWidth);
  const libraryPageRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const allCategories = useMemo(() => Array.from(new Set(papers.map((item) => item.category))), [papers]);

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
    setContentMatchCount(0);
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
    const title = file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || '未命名论文';
    const paper: PaperListItem = {
      id: `local-${Date.now().toString(36)}`,
      category: '本地导入',
      title,
      sourcePath: `local/${file.name}`,
      pdfPath: URL.createObjectURL(file),
      markdownCount: 0,
      imageCount: 0,
      modifiedAt: new Date().toISOString(),
      preview: '仅在当前浏览器会话中预览；静态演示不会上传或保存文件。',
      author: '本地文件',
      researchArea: '待补充',
      tags: ['本地导入', '临时预览'],
      abstract: '这是本地选择的 PDF。静态演示不会调用模型、上传文件或建立持久化索引。',
      summary: '可在右侧预览 PDF；预置论文仍可用于本地检索与知识问答。',
      chapters: [],
    };
    setPapers((current) => [paper, ...current]);
    setSelectedId(paper.id);
    setCategory('全部类型');
    window.setTimeout(() => setImporting(false), 180);
  };

  const searchContent = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !contentQuery.trim()) return;
    setSearchingContent(true);
    setSearchError('');
    const results = searchDemoPaper(selected, contentQuery.trim());
    setContentResults(results);
    setContentMatchCount(results.length);
    setHighlightQuery(results.length ? contentQuery.trim() : '');
    window.setTimeout(() => setSearchingContent(false), 120);
  };

  const closeContentSearch = () => {
    setContentResults([]);
    setContentMatchCount(0);
    setHighlightQuery('');
  };

  const deletePaper = async (paper: PaperListItem) => {
    if (paper.processing || deletingId) return;
    setDeletingId(paper.id);
    if (paper.pdfPath?.startsWith('blob:')) URL.revokeObjectURL(paper.pdfPath);
    setPapers((current) => current.filter((item) => item.id !== paper.id));
    if (selectedId === paper.id) setSelectedId(null);
    closeContentSearch();
    setDeleteCandidate(null);
    window.setTimeout(() => setDeletingId(null), 120);
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
      <div className="library-document-list">{visibleMaterials.map((item) => <MaterialRow key={item.id} item={item} selected={item.id === selected?.id} deleting={deletingId === item.id} onSelect={() => setSelectedId(item.id)} onDelete={() => setDeleteCandidate(item)} />)}{visibleMaterials.length === 0 && <div className="library-list-empty">没有匹配的论文</div>}</div>
    </aside>
    <div className="library-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整论文列表宽度" onPointerDown={startResize} />
    <section className="library-reader-panel">{selected ? <MaterialDetail item={selected} activePdfPage={activePdfPage} pdfPageCount={pdfPageCount} onSelectPdfPage={setActivePdfPage} onPageCountChange={setPdfPageCount} contentQuery={contentQuery} onContentQueryChange={setContentQuery} onClearContentSearch={() => { setContentQuery(''); closeContentSearch(); }} onSearch={searchContent} contentResults={contentResults} contentMatchCount={contentMatchCount} highlightQuery={highlightQuery} onCloseSearch={closeContentSearch} searchingContent={searchingContent} searchError={searchError} importing={importing} importError={importError} onImport={() => importInputRef.current?.click()} /> : <div className="materials-empty">未找到匹配论文</div>}</section>
    <input ref={importInputRef} className="library-import-input" type="file" accept="application/pdf,.pdf" onChange={importPaper} />
    {deleteCandidate && <div className="library-delete-backdrop" role="presentation" onMouseDown={() => !deletingId && setDeleteCandidate(null)}><section className="library-delete-dialog" role="alertdialog" aria-modal="true" aria-label="确认删除论文" onMouseDown={(event) => event.stopPropagation()}><h2>删除论文？</h2><p>将删除“{deleteCandidate.title}”及其向量、分类和上下文数据。</p><footer><button type="button" onClick={() => setDeleteCandidate(null)} disabled={Boolean(deletingId)}>取消</button><button type="button" className="danger" onClick={() => void deletePaper(deleteCandidate)} disabled={Boolean(deletingId)}>{deletingId ? <LoaderCircle className="spin" size={15} /> : '删除'}</button></footer></section></div>}
  </div>;
}

function MaterialRow({ item, selected, deleting, onSelect, onDelete }: { item: PaperListItem; selected: boolean; deleting: boolean; onSelect(): void; onDelete(): void }) {
  const publication = [item.venue || '未标注平台', item.year || '年份未标注'].join(' · ');
  return <div className={`material-row${selected ? ' active' : ''}`}><button className="material-row-select" onClick={onSelect}><span className="material-row-icon">{item.processing ? <LoaderCircle className="spin" size={18} /> : <BookOpenCheck size={18} />}</span><span className="material-row-content"><strong>{item.title}</strong><small>{item.processing ? '正在处理论文' : item.processingError ?? publication}</small></span></button><button type="button" className="material-row-delete" title="删除论文" aria-label={`删除论文：${item.title}`} disabled={item.processing || deleting} onClick={onDelete}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button></div>;
}

interface MaterialDetailProps {
  item: MaterialDocument; activePdfPage: number; pdfPageCount: number; onSelectPdfPage(page: number): void; onPageCountChange(count: number): void; contentQuery: string; onContentQueryChange(value: string): void; onClearContentSearch(): void; onSearch(event: FormEvent): void; contentResults: ContentResult[]; contentMatchCount: number; highlightQuery: string; onCloseSearch(): void; searchingContent: boolean; searchError: string; importing: boolean; importError: string; onImport(): void;
}

function MaterialDetail({ item, activePdfPage, pdfPageCount, onSelectPdfPage, onPageCountChange, contentQuery, onContentQueryChange, onClearContentSearch, onSearch, contentResults, contentMatchCount, highlightQuery, onCloseSearch, searchingContent, searchError, importing, importError, onImport }: MaterialDetailProps) {
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
      pendingWidth = Math.max(220, Math.min(560, startWidth - moveEvent.clientX + startX));
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
      {chapterPanelVisible && <><aside className="library-summary-panel"><div className="library-chapter-heading"><span>内容摘要</span></div><div className="library-summary-scroll"><section className="library-summary-title"><strong>{item.title}</strong><small>{item.researchArea || item.category}</small></section><dl className="library-summary-meta"><div><dt>作者</dt><dd>{item.author || '未标注'}</dd></div><div><dt>研究领域</dt><dd>{item.researchArea || item.category || '未分类'}</dd></div></dl><section><h3>论文标签</h3><div className="library-summary-tags">{(item.tags?.length ? item.tags : [item.category]).map((tag) => <span key={tag}>{tag}</span>)}</div></section><section><h3>摘要</h3><p>{item.abstract || '暂无摘要信息。'}</p></section><section><h3>内容总结</h3><p>{item.summary || item.preview || '暂无内容总结。'}</p></section></div></aside><div className="chapter-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整内容摘要宽度" onPointerDown={startChapterResize} /></>}
      <article className="library-reading-panel" onClick={onCloseSearch}><div className="library-reader-toolbar"><button type="button" className="library-import-button" onClick={onImport} disabled={importing} title="导入新的论文 PDF"><FolderUp size={15} />{importing ? '导入中' : '导入'}</button><form onClick={(event) => event.stopPropagation()} onSubmit={onSearch}><label><Search size={15} /><input value={contentQuery} onChange={(event) => onContentQueryChange(event.target.value)} placeholder="检索论文内容" />{contentQuery && <button type="button" className="library-clear-search" title="清除论文检索" aria-label="清除论文检索" onClick={onClearContentSearch}><X size={14} /></button>}</label><button type="submit" className="library-search-submit" disabled={searchingContent || !contentQuery.trim()} title="检索论文内容" aria-label="检索论文内容">{searchingContent ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}</button></form><div className="library-reader-title" title={item.title}><small>{pdfPageCount ? `${activePdfPage} / ${pdfPageCount} 页` : '本地演示数据'}</small></div><button type="button" className="chapter-panel-toggle" title={chapterPanelVisible ? '收起内容摘要' : '展开内容摘要'} aria-label={chapterPanelVisible ? '收起内容摘要' : '展开内容摘要'} onClick={toggleChapterPanel}>{chapterPanelVisible ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button></div>
        {searchError && <div className="library-message error">{searchError}</div>}
        {importError && <div className="library-message error">{importError}</div>}
        {contentResults.length > 0 && <div className="library-search-results" onClick={(event) => event.stopPropagation()}><header><strong>检索到 {contentMatchCount} 处匹配</strong><button type="button" title="关闭检索结果" aria-label="关闭检索结果" onClick={onCloseSearch}><X size={15} /></button></header>{contentResults.map((result, index) => <button key={`${result.sourcePath}-${result.page ?? 0}-${index}`} onClick={() => onSelectPdfPage(result.page ?? 1)}><span>{result.page ? `第 ${result.page} 页` : result.title}</span><small>{result.before}<mark>{result.match}</mark>{result.after}</small></button>)}</div>}
        {item.pdfPath?.startsWith('blob:') ? <div className="library-pdf"><PdfReader src={item.pdfPath} activePage={activePdfPage} onPageCount={onPageCountChange} onCurrentPageChange={onSelectPdfPage} highlightQuery={highlightQuery} /></div> : <div className="library-pdf-empty"><FileText size={26} /><strong>预置论文演示数据</strong><span>静态站点仅内置论文元数据、摘要、总结和本地检索片段，不包含原始 PDF 文件。</span><button type="button" onClick={onImport}><FolderUp size={15} />本地预览 PDF</button></div>}
      </article>
    </div>
  </div>;
}
