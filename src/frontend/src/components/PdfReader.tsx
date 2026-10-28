import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfReaderProps {
  src: string;
  activePage?: number;
  onPageCount?(count: number): void;
  onCurrentPageChange?(page: number): void;
  highlightQuery?: string;
  highlightText?: string;
}

interface HighlightRect { left: number; top: number; width: number; height: number; }

interface CitationRange { start: number; end: number; }

function normalizeForMatch(value: string) {
  return value.replace(/^\s*论文[：:][^\n]*(?:\n\s*)+页码[：:][^\n]*(?:\n\s*)*/i, '')
    .replace(/^\s*第\s*\d+\s*页\s*/i, '')
    .replace(/\u00ad/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function citationRanges(items: string[], citation: string): CitationRange[] {
  const documentText = items.map(normalizeForMatch).filter(Boolean).join(' ');
  const sourceText = normalizeForMatch(citation);
  if (!documentText || sourceText.length < 32) return [];
  const sentences = sourceText.split(/(?<=[.!?。！？])\s+/).filter((sentence) => sentence.length >= 32);
  const ranges: CitationRange[] = [];
  for (const sentence of sentences.slice(0, 5)) {
    let found: CitationRange | null = null;
    for (const size of [180, 120, 80, 48]) {
      if (sentence.length < size) continue;
      for (let offset = 0; offset <= sentence.length - size; offset += Math.max(20, Math.floor(size / 2))) {
        const phrase = sentence.slice(offset, offset + size).trim();
        const start = documentText.indexOf(phrase);
        if (start >= 0) { found = { start, end: start + phrase.length }; break; }
      }
      if (found) break;
    }
    if (found && !ranges.some((range) => found!.start < range.end && found!.end > range.start)) ranges.push(found);
    if (ranges.length >= 3) break;
  }
  return ranges;
}

export function PdfReader({ src, activePage = 1, onPageCount, onCurrentPageChange, highlightQuery = '', highlightText = '' }: PdfReaderProps) {
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);
  const [highlights, setHighlights] = useState<Map<number, HighlightRect[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pdfDocument, setPdfDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [zoom, setZoom] = useState(1);
  const pageRefs = useRef(new Map<number, HTMLElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const readerRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef(activePage);
  const pageCountCallbackRef = useRef(onPageCount);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);

  useEffect(() => { pageCountCallbackRef.current = onPageCount; }, [onPageCount]);

  useEffect(() => {
    let cancelled = false;
    const loadingTask = pdfjs.getDocument({ url: src });
    setLoading(true);
    setError('');
    setPageNumbers([]);
    setHighlights(new Map());
    setPdfDocument(null);
    setZoom(1);
    pageCountCallbackRef.current?.(0);
    loadingTask.promise.then((document) => {
      if (cancelled) {
        document.cleanup();
        return;
      }
      const numbers = Array.from({ length: document.numPages }, (_, index) => index + 1);
      setPageNumbers(numbers);
      setPdfDocument(document);
      pageCountCallbackRef.current?.(document.numPages);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'PDF 读取失败。');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [src]);

  useEffect(() => {
    if (!pdfDocument || !pageNumbers.length) return;
    let cancelled = false;
    const renderPages = async () => {
      const pendingTask = renderTaskRef.current;
      if (pendingTask) {
        pendingTask.cancel();
        try { await pendingTask.promise; } catch { /* A replacement render intentionally cancels the prior task. */ }
      }
      if (cancelled) return;
      const width = Math.max(320, (readerRef.current?.clientWidth ?? 800) - 32);
      const devicePixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const nextHighlights = new Map<number, HighlightRect[]>();
      const normalizedQuery = highlightQuery.trim().toLocaleLowerCase();
      for (const pageNumber of pageNumbers) {
        if (cancelled) return;
        const page = await pdfDocument.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.55, width / baseViewport.width) * zoom;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRefs.current.get(pageNumber);
        if (!canvas) continue;
        canvas.width = Math.floor(viewport.width * devicePixelRatio);
        canvas.height = Math.floor(viewport.height * devicePixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) continue;
        const renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport: page.getViewport({ scale: scale * devicePixelRatio }),
        });
        renderTaskRef.current = renderTask;
        try {
          await renderTask.promise;
        } catch (reason: unknown) {
          if (cancelled || /rendering cancelled/i.test(String(reason))) return;
          throw reason;
        } finally {
          if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
        }
        if (normalizedQuery || highlightText.trim()) {
          const textContent = await page.getTextContent();
          const items = textContent.items.flatMap((item) => 'str' in item && item.str ? [item] : []);
          const normalizedItems = items.map((item) => normalizeForMatch(item.str));
          const exactRanges = citationRanges(normalizedItems, highlightText);
          let offset = 0;
          const rectangles: HighlightRect[] = [];
          for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            const text = item.str;
            const normalizedText = text.toLocaleLowerCase();
            const normalizedItem = normalizedItems[index];
            const itemStart = offset;
            const itemEnd = itemStart + normalizedItem.length;
            offset = itemEnd + 1;
            const matches = exactRanges.length
              ? exactRanges.filter((range) => range.start < itemEnd && range.end > itemStart).map(() => ({ start: 0, end: text.length }))
              : normalizedQuery && normalizedText.includes(normalizedQuery)
              ? [{ start: normalizedText.indexOf(normalizedQuery), end: normalizedText.indexOf(normalizedQuery) + normalizedQuery.length }]
              : [];
            if (!matches.length) continue;
            const transform = pdfjs.Util.transform(viewport.transform, item.transform);
            const height = Math.max(8, Math.hypot(transform[2], transform[3]));
            for (const { start, end } of matches) {
              const left = transform[4] + item.width * scale * (start / Math.max(1, text.length));
              const highlightWidth = Math.max(5, item.width * scale * ((end - start) / Math.max(1, text.length)));
              rectangles.push({ left, top: transform[5] - height, width: highlightWidth, height });
            }
          }
          if (rectangles.length) nextHighlights.set(pageNumber, rectangles);
        }
      }
      if (!cancelled) setHighlights(nextHighlights);
    };
    renderPages().catch((reason: unknown) => {
      if (!cancelled && !/rendering cancelled/i.test(String(reason))) setError(reason instanceof Error ? reason.message : 'PDF 页面渲染失败。');
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [highlightQuery, highlightText, pageNumbers, pdfDocument, zoom]);

  useEffect(() => {
    currentPageRef.current = activePage;
    const frame = requestAnimationFrame(() => pageRefs.current.get(activePage)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [activePage, pageNumbers]);

  useEffect(() => {
    const root = readerRef.current;
    if (!root || !pageNumbers.length || !onCurrentPageChange) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const page = Number((visible?.target as HTMLElement | undefined)?.dataset.pageNumber);
      if (page) {
        currentPageRef.current = page;
        onCurrentPageChange(page);
      }
    }, { root, threshold: [0.25, 0.5, 0.75] });
    for (const element of pageRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [onCurrentPageChange, pageNumbers]);

  if (loading) return <div className="library-pdf-status">正在读取 PDF…</div>;
  if (error) return <div className="library-pdf-status error">{error}</div>;
  return <div className="library-pdf-stage">
    <div className="library-pdf-zoom" aria-label="PDF 缩放控制">
      <button type="button" title="缩小 PDF" aria-label="缩小 PDF" disabled={zoom <= 0.6} onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.2).toFixed(2))))}><ZoomOut size={15} /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" title="放大 PDF" aria-label="放大 PDF" disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, Number((value + 0.2).toFixed(2))))}><ZoomIn size={15} /></button>
      <button type="button" title="适配页面宽度" aria-label="适配页面宽度" disabled={zoom === 1} onClick={() => setZoom(1)}><Maximize2 size={14} /></button>
    </div>
    <div ref={readerRef} className="library-pdf-reader">
      {pageNumbers.map((pageNumber) => <section key={pageNumber} data-page-number={pageNumber} ref={(element: HTMLElement | null) => { if (element) pageRefs.current.set(pageNumber, element); else pageRefs.current.delete(pageNumber); }} className={`library-pdf-page${pageNumber === activePage ? ' active' : ''}`}>
        <canvas ref={(element) => { if (element) canvasRefs.current.set(pageNumber, element); else canvasRefs.current.delete(pageNumber); }} aria-label={`第 ${pageNumber} 页`} />
        {(highlights.get(pageNumber) ?? []).map((highlight, index) => <i key={index} className="library-pdf-highlight" style={highlight} />)}
        <small>第 {pageNumber} / {pageNumbers.length} 页</small>
      </section>)}
    </div>
  </div>;
}
