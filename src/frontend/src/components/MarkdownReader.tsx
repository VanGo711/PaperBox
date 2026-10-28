import katex from 'katex';
import 'katex/dist/katex.min.css';
import { cloneElement, Fragment, isValidElement, type ReactNode } from 'react';

function assetUrl(chapterPath: string, source: string) {
  if (/^(?:https?:|data:)/i.test(source)) return source;
  if (chapterPath.includes('/data/papers/')) return `/paper-api/asset?chapter=${encodeURIComponent(chapterPath)}&src=${encodeURIComponent(source)}`;
  return source;
}

function MathExpression({ expression, display = false }: { expression: string; display?: boolean }) {
  try {
    return <span className={display ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: katex.renderToString(expression, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore' }) }} />;
  } catch {
    return <code>{expression}</code>;
  }
}

type CitationRenderer = (id: string) => ReactNode;

function inline(value: string, chapterPath: string, renderCitation?: CitationRenderer): ReactNode[] {
  const token = /(\!\[[^\]]*\]\([^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^\s)]+\)|\$[^$\n]+\$|\[S\d+\])/g;
  return value.split(token).filter(Boolean).map((part, index) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
    if (image) return <img className="markdown-inline-image" key={index} src={assetUrl(chapterPath, image[2])} alt={image[1] || '资料插图'} loading="lazy" />;
    if (renderCitation && /^\[S\d+\]$/.test(part)) return <Fragment key={index}>{renderCitation(part.slice(1, -1))}</Fragment>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{inline(part.slice(2, -2), chapterPath, renderCitation)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{inline(part.slice(1, -1), chapterPath, renderCitation)}</em>;
    if (part.startsWith('$') && part.endsWith('$')) return <MathExpression key={index} expression={part.slice(1, -1)} />;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function headingLevel(sourceLevel: number, title: string, preserveSourceLevels = false) {
  if (preserveSourceLevels) return sourceLevel;
  if (/^第.+章/.test(title)) return 1;
  if (/^第.+节/.test(title)) return 2;
  const numeric = title.match(/^(\d+(?:\.\d+)+)/);
  if (numeric) return Math.min(6, numeric[1].split('.').length);
  if (/^(?:[（(]?\d+[）).]|[①②③④⑤⑥⑦⑧⑨])/.test(title)) return Math.min(5, Math.max(3, sourceLevel + 1));
  return Math.max(preserveSourceLevels ? 1 : 2, sourceLevel);
}

function isBlockStart(line: string) {
  return /^(#{1,6}\s|```|\$\$|>\s?|[-*+]\s+|\d+\.\s+|!\[|<table\b|\|.*\||---+$)/i.test(line);
}

function splitMarkdownRow(line: string) {
  const source = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const character of source) {
    if (character === '|' && !escaped) { cells.push(cell.trim().replace(/\\\|/g, '|')); cell = ''; }
    else cell += character;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  cells.push(cell.trim().replace(/\\\|/g, '|'));
  return cells;
}

function isMarkdownTableSeparator(line: string) {
  const cells = splitMarkdownRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownTable({ rows, chapterPath, renderCitation }: { rows: string[][]; chapterPath: string; renderCitation?: CitationRenderer }) {
  return <div className="markdown-table-wrap"><table className="markdown-table"><thead><tr>{rows[0].map((cell, index) => <th key={index}>{inline(cell, chapterPath, renderCitation)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{rows[0].map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] ?? '', chapterPath, renderCitation)}</td>)}</tr>)}</tbody></table></div>;
}

interface TableCell { content: string; colSpan: number; rowSpan: number; }

function parseHtmlTable(markup: string): TableCell[][] {
  const document = new DOMParser().parseFromString(markup, 'text/html');
  return Array.from(document.querySelectorAll('tr')).map((row) => Array.from(row.children)
    .filter((cell) => /^(TD|TH)$/.test(cell.tagName))
    .map((cell) => ({
      content: (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
      colSpan: Math.max(1, Number(cell.getAttribute('colspan')) || 1),
      rowSpan: Math.max(1, Number(cell.getAttribute('rowspan')) || 1)
    })));
}

function HtmlTable({ markup, chapterPath }: { markup: string; chapterPath: string }) {
  const rows = parseHtmlTable(markup);
  const isMaterialToc = /\bclass\s*=\s*["'][^"']*\bmaterial-toc\b/i.test(markup);
  return <div className={`markdown-table-wrap${isMaterialToc ? ' material-toc-wrap' : ''}`}><table className={`markdown-table${isMaterialToc ? ' material-toc' : ''}`}><tbody>{rows.map((row, rowIndex) => {
    const isSection = isMaterialToc && row.length === 1 && row[0].colSpan > 1;
    return <tr className={isSection ? 'material-toc-section' : undefined} key={rowIndex}>{row.map((cell, cellIndex) => <td className={isMaterialToc ? (cellIndex === 0 ? 'material-toc-title' : 'material-toc-page') : undefined} key={cellIndex} colSpan={cell.colSpan} rowSpan={cell.rowSpan}>{inline(cell.content, chapterPath)}</td>)}</tr>;
  })}</tbody></table></div>;
}

/** Safe renderer for Markdown, local images, and TeX math in the knowledge library. */
export function MarkdownReader({ content, chapterPath, renderCitation, preserveHeadingLevels = false }: { content: string; chapterPath: string; renderCitation?: CitationRenderer; preserveHeadingLevels?: boolean }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;
  const pushBlock = (node: ReactNode, start: number, end: number) => {
    if (isValidElement<Record<string, unknown>>(node) && typeof node.type === 'string') {
      nodes.push(cloneElement(node, { key: start, 'data-line-start': start + 1, 'data-line-end': end }));
    } else {
      nodes.push(<div className="markdown-block" key={start} data-line-start={start + 1} data-line-end={end}>{node}</div>);
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (index + 1 < lines.length && line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const start = index;
      const rows = [splitMarkdownRow(line)];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(splitMarkdownRow(lines[index++]));
      pushBlock(<MarkdownTable rows={rows} chapterPath={chapterPath} renderCitation={renderCitation} />, start, index);
      continue;
    }
    if (/^\s*<table\b/i.test(line)) {
      const start = index;
      const tableLines: string[] = [];
      while (index < lines.length) {
        tableLines.push(lines[index]);
        if (/<\/table>/i.test(lines[index++])) break;
      }
      pushBlock(<HtmlTable markup={tableLines.join('\n')} chapterPath={chapterPath} />, start, index);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = headingLevel(heading[1].length, heading[2], preserveHeadingLevels);
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      pushBlock(<Tag className={`markdown-heading level-${level}`}>{inline(heading[2], chapterPath, renderCitation)}</Tag>, index, index + 1);
      index += 1;
      continue;
    }
    if (line.trim() === '$$') {
      const start = ++index;
      while (index < lines.length && lines[index].trim() !== '$$') index += 1;
      pushBlock(<MathExpression expression={lines.slice(start, index).join('\n')} display />, start - 1, index + 1);
      index += 1;
      continue;
    }
    const singleLineMath = line.trim().match(/^\$\$(.+)\$\$$/) ?? line.trim().match(/^\$(.+)\$$/);
    if (singleLineMath) {
      pushBlock(<MathExpression expression={singleLineMath[1]} display />, index, index + 1);
      index += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const start = ++index;
      while (index < lines.length && !lines[index].startsWith('```')) index += 1;
      pushBlock(<pre className="markdown-code"><code data-language={language}>{lines.slice(start, index).join('\n')}</code></pre>, start - 1, index + 1);
      index += 1;
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/);
    if (image) {
      pushBlock(<figure className="markdown-figure"><img src={assetUrl(chapterPath, image[2])} alt={image[1] || '资料插图'} loading="lazy" />{image[1] && <figcaption>{image[1]}</figcaption>}</figure>, index, index + 1);
      index += 1;
      continue;
    }
    if (/^---+$/.test(line.trim())) { pushBlock(<hr />, index, index + 1); index += 1; continue; }
    if (line.startsWith('>')) {
      const start = index;
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('>')) quote.push(lines[index++].replace(/^>\s?/, ''));
      pushBlock(<blockquote>{inline(quote.join(' '), chapterPath, renderCitation)}</blockquote>, start, index);
      continue;
    }
    const listMatch = line.match(/^([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const start = index;
      const ordered = /\d+\./.test(listMatch[1]);
      const entries: ReactNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/);
        if (!item) break;
        entries.push(<li key={index}>{inline(item[1], chapterPath, renderCitation)}</li>);
        index += 1;
      }
      pushBlock(ordered ? <ol>{entries}</ol> : <ul>{entries}</ul>, start, index);
      continue;
    }
    const start = index;
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
    pushBlock(<p>{inline(paragraph.join(' '), chapterPath, renderCitation)}</p>, start, index);
  }
  return <div className="markdown-content">{nodes}</div>;
}
