import { FileText, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { sourceTitle, type Source } from './conversations';

function pageLabel(source: Source) {
  const match = `${source.chapter} ${source.heading_path} ${source.content}`.match(/第\s*(\d+)\s*页/);
  return match ? `第 ${match[1]} 页` : source.line_start > 0 ? `第 ${source.line_start}–${source.line_end} 行` : '位置未知';
}

function excerpt(content: string) {
  return content
    .replace(/^\s*论文[：:][^\n]*(?:\n\s*)+页码[：:][^\n]*(?:\n\s*)*/i, '')
    .replace(/^\s*第\s*\d+\s*页\s*(?:\n\s*)*/i, '')
    .replace(/^\s*章节[：:][^\n]*(?:\n\s*)+/, '')
    .replace(/\n[ \t]*\n+/g, '\n')
    .trim();
}

export function SourceDrawer({ source, onClose }: { source: Source; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = sourceTitle(source);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="insight-source-drawer" aria-labelledby="source-drawer-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section><header><span><FileText size={18} /><strong id="source-drawer-title">引用片段 · {source.id}</strong></span><button autoFocus aria-label="关闭引用片段" onClick={onClose}><X size={19} /></button></header>
      <div className="insight-source-location"><h2>{source.book || title.file}</h2><p>{pageLabel(source)}</p><small>相似度 {source.score.toFixed(3)}</small></div>
      <article className="insight-source-snippet">{excerpt(source.content)}</article>
    </section>
  </dialog>;
}
