import { FileText, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MarkdownReader } from '../components/MarkdownReader';
import { sourceChapterPath, sourceTitle, type Source } from './conversations';

export function SourceDrawer({ source, onClose }: { source: Source; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [located, setLocated] = useState(false);
  const path = sourceChapterPath(source.source_path);
  const title = sourceTitle(source);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setContent(''); setError(''); setLoading(true); setLocated(false);
    fetch(`/paper-api/chapter?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法读取原文章节。');
        setContent(data.content ?? '');
      })
      .catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path]);
  useEffect(() => {
    if (loading || !content) return;
    const blocks = Array.from(body.current?.querySelectorAll<HTMLElement>('[data-line-start]') ?? []);
    let first: HTMLElement | undefined;
    for (const block of blocks) {
      const matches = source.line_start > 0 && Number(block.dataset.lineStart) <= source.line_end && Number(block.dataset.lineEnd) >= source.line_start;
      block.classList.toggle('is-cited', matches);
      if (matches && !first) first = block;
    }
    setLocated(Boolean(first));
    const timer = requestAnimationFrame(() => first?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(timer);
  }, [content, loading, source.line_start, source.line_end]);
  return <dialog ref={dialog} className="insight-source-drawer" aria-labelledby="source-drawer-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section><header><span><FileText size={18} /><strong id="source-drawer-title">论文原文 · {source.id}</strong></span><button autoFocus aria-label="关闭论文原文" onClick={onClose}><X size={19} /></button></header>
      <div className="insight-source-location"><h2>{source.book || title.file}</h2><p>{title.file} · {title.chapter}</p><small>{source.line_start > 0 ? `第 ${source.line_start}–${source.line_end} 行` : '暂无行号'}{!loading && !error && (located ? ' · 已高亮引用段落' : ' · 未能定位段落，请核对检索片段')}</small></div>
      <details className="insight-source-excerpt" open={Boolean(error)}><summary>检索片段</summary><p>{source.content}</p></details>
      <div className="insight-source-body" ref={body}>{loading ? <div className="insight-assistant-loading"><LoaderCircle className="spin" size={17} />正在读取原文…</div> : error ? <div className="insight-notice" role="alert">{error} 可查看上方保存的检索片段。</div> : <MarkdownReader content={content} chapterPath={path} />}</div>
    </section>
  </dialog>;
}
