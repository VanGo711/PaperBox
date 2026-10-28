import {
  Braces,
  CircleAlert,
  Database,
  FileSearch,
  Filter,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useState } from 'react';

interface VectorStatus {
  collection: string;
  created: boolean;
  rows?: number;
  embedding_model: string;
  paper_root: string;
}

interface SchemaField {
  name: string;
  type: string;
  role: string;
  index: string;
}

interface VectorSchema {
  schema_version?: number;
  engine: string;
  storage: string;
  collection: string;
  created: boolean;
  embedding_model: string;
  dimension: number | null;
  fields: SchemaField[];
}

const VECTOR_SCHEMA_CACHE_KEY = 'paperbox-vector-schema-v1';

function readCachedSchema(): VectorSchema | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VECTOR_SCHEMA_CACHE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const schema = value as Partial<VectorSchema>;
    if (typeof schema.collection !== 'string' || typeof schema.created !== 'boolean' || !Array.isArray(schema.fields)) return null;
    if (!schema.fields.every((field) => Boolean(field) && typeof field.name === 'string' && typeof field.type === 'string' && typeof field.role === 'string' && typeof field.index === 'string')) return null;
    return schema as VectorSchema;
  } catch {
    return null;
  }
}

function cacheSchema(schema: VectorSchema) {
  try { localStorage.setItem(VECTOR_SCHEMA_CACHE_KEY, JSON.stringify(schema)); } catch { /* Optional performance cache. */ }
}

interface VectorFilters {
  collection: string;
  categories: string[];
  books: string[];
  chapters: string[];
}

interface SearchResult {
  id: string;
  score: number;
  content: string;
  source_path: string;
  category: string;
  book: string;
  chapter: string;
  heading_path: string;
  line_start: number;
  line_end: number;
  char_start: number;
  char_end: number;
  chunk_index: number;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const payload = (await response.json().catch(() => ({}))) as T & {
    detail?: string;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(payload.detail ?? payload.error ?? '后端请求失败。');
  }

  return payload;
}

function resultPreview(content: string) {
  return content.replace(/^\s*章节[：:][^\n]*(?:\n\s*)+/, '').trim();
}

function resultSection(sourcePath: string, headingPath: string, chapter: string) {
  const heading = headingPath || chapter;
  const fileStem = sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? '';
  const chapterStem = fileStem.replace(/^ch\d+[-_]*/i, '');
  const parts = heading.split(/\s*>\s*/).filter(Boolean);
  if (parts[0] === fileStem || parts[0] === chapterStem) parts.shift();
  return parts.join(' > ');
}

export function VectorPage() {
  const [status, setStatus] = useState<VectorStatus | null>(null);
  const [schema, setSchema] = useState<VectorSchema | null>(readCachedSchema);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [book, setBook] = useState('');
  const [chapter, setChapter] = useState('');
  const [filters, setFilters] = useState<VectorFilters>({
    collection: '',
    categories: [],
    books: [],
    chapters: [],
  });
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtersLoading, setFiltersLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [indexNoticeOpen, setIndexNoticeOpen] = useState(false);
  const [error, setError] = useState('');
  const [structureWidth, setStructureWidth] = useState(285);

  const loadFilters = async (nextCategory = '', nextBook = '') => {
    setFiltersLoading(true);
    try {
      const parameters = new URLSearchParams();
      if (nextCategory) parameters.append('categories', nextCategory);
      if (nextBook) parameters.append('books', nextBook);
      const suffix = parameters.size ? '?' + parameters.toString() : '';
      setFilters(await request<VectorFilters>('/api/vector/filters' + suffix));
    } catch (filterError) {
      setError(
        filterError instanceof Error ? filterError.message : '无法读取向量筛选项。',
      );
    } finally {
      setFiltersLoading(false);
    }
  };

  const refresh = async (forceSchema = false) => {
    setLoading(true);

    try {
      // SeekDB starts lazily and holds an exclusive local file lock.
      // Load these two initial pieces of information in order, rather than
      // racing two first-use requests against the same embedded database.
      const nextStatus = await request<VectorStatus>('/api/vector/status');
      const cachedSchema = readCachedSchema();
      const canUseCache = !forceSchema && cachedSchema
        && cachedSchema.collection === nextStatus.collection
        && cachedSchema.created === nextStatus.created
        && cachedSchema.embedding_model === nextStatus.embedding_model;
      const nextSchema = canUseCache
        ? cachedSchema
        : await request<VectorSchema>('/api/vector/schema');
      if (!canUseCache) cacheSchema(nextSchema);
      if (nextStatus.created) {
        await loadFilters(category, book);
      } else {
        setFilters({ collection: nextStatus.collection, categories: [], books: [], chapters: [] });
      }
      setStatus(nextStatus);
      setSchema(nextSchema);
      setError('');
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : '无法读取向量数据库状态。',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = structureWidth;
    const move = (moveEvent: globalThis.PointerEvent) => {
      setStructureWidth(Math.min(460, Math.max(210, startWidth + moveEvent.clientX - startX)));
    };
    const finish = () => {
      document.body.classList.remove('vector-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    document.body.classList.add('vector-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }

    setSearching(true);
    setError('');

    try {
      const payload = await request<{ results: SearchResult[] }>(
        '/api/vector/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: query.trim(),
            limit: 100,
            categories: category ? [category] : undefined,
            books: book ? [book] : undefined,
            chapters: chapter ? [chapter] : undefined,
          }),
        },
      );
      setResults(payload.results);
    } catch (searchError) {
      setError(
        searchError instanceof Error ? searchError.message : '检索失败。',
      );
    } finally {
      setSearching(false);
    }
  };

  const ready = status?.created ?? false;

  return (
    <main className="vector-page">
      <header className="vector-toolbar">
        <div className="vector-toolbar-title">
          <Database size={18} />
          <strong>内容检索</strong>
          <span>SeekDB</span>
        </div>
        <div className="vector-toolbar-actions">
          <button
            type="button"
            title="刷新状态"
            aria-label="刷新状态"
            onClick={() => void refresh(true)}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
          </button>
          <button
            type="button"
            className="vector-index-button"
            onClick={() => setIndexNoticeOpen(true)}
          >
            <Sparkles size={15} />
            构建索引
          </button>
        </div>
      </header>

      {error && (
        <div className="vector-error">
          <CircleAlert size={15} />
          <span>{error}</span>
        </div>
      )}

      <div
        className="vector-workspace"
        style={{ gridTemplateColumns: String(structureWidth) + 'px 10px minmax(0, 1fr)' }}
      >
        <aside className="vector-structure">
          <section className="vector-db-card">
            <div>
              <span>当前集合</span>
              <Database size={17} />
            </div>
              <strong>{schema?.collection ?? 'paper_chunks'}</strong>
            <small>
              {ready ? (status?.rows ?? 0) + ' 个向量块' : '集合尚未创建'}
            </small>
          </section>

          <dl className="vector-meta">
            <div>
              <dt>嵌入模型</dt>
              <dd>{schema?.embedding_model ?? 'qwen3-embedding:4b'}</dd>
            </div>
            <div>
              <dt>向量维度</dt>
              <dd>{schema?.dimension ?? '首次构建后确定'}</dd>
            </div>
          </dl>

          <section className="vector-schema">
            <div className="vector-section-heading">
              <Braces size={15} />
              <strong>数据结构</strong>
              <span>{schema?.fields.length ?? 14} 字段</span>
            </div>
            <div className="vector-field-list">
              {(schema?.fields ?? []).map((field) => (
                <div key={field.name} className="vector-field">
                  <div>
                    <code>{field.name}</code>
                    <small>{field.type}</small>
                  </div>
                  <em>{field.role}</em>
                </div>
              ))}
            </div>
          </section>
        </aside>
        <div
          className="vector-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整数据结构区域宽度"
          onPointerDown={beginResize}
        />

        <section className="vector-search-panel">
          <form className="vector-search-form" onSubmit={(event) => void search(event)}>
            <div className="vector-query">
              <Search size={18} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入问题，检索论文相关内容"
                aria-label="检索问题"
              />
              <button type="submit" disabled={searching || !query.trim()}>
                {searching ? <LoaderCircle className="spin" size={16} /> : '检索'}
              </button>
            </div>
            <div className="vector-filter-row">
              <Filter size={15} />
              <select
                value={category}
                disabled={!ready || filtersLoading}
                onChange={(event) => {
                  const nextCategory = event.target.value;
                  setCategory(nextCategory);
                  setBook('');
                  setChapter('');
                  void loadFilters(nextCategory);
                }}
                aria-label="按分类筛选"
              >
                <option value="">全部分类</option>
                {filters.categories.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <select
                value={book}
                disabled={!ready || filtersLoading}
                onChange={(event) => {
                  const nextBook = event.target.value;
                  setBook(nextBook);
                  setChapter('');
                  void loadFilters(category, nextBook);
                }}
                aria-label="按论文筛选"
              >
                <option value="">全部论文</option>
                {filters.books.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <select
                value={chapter}
                disabled={!ready || filtersLoading || !book}
                onChange={(event) => setChapter(event.target.value)}
                aria-label="按章节筛选"
              >
                <option value="">全部章节</option>
                {filters.chapters.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </div>
          </form>

          {!ready && !loading && (
            <div className="vector-empty">
              <Database size={26} />
              <strong>论文尚未向量化</strong>
              <span>
                点击右上角“构建索引”后，系统才会将论文内容写入本地 SeekDB 数据库。
              </span>
            </div>
          )}

          {ready && !results.length && !searching && (
            <div className="vector-empty">
              <FileSearch size={26} />
              <strong>等待检索</strong>
              <span>输入问题，可结合分类、论文和章节字段进行筛选。</span>
            </div>
          )}

          {searching && (
            <div className="vector-empty">
              <LoaderCircle className="spin" size={26} />
              <strong>正在检索</strong>
            </div>
          )}

          {ready && !searching && results.length > 0 && (
            <div className="vector-results">
              <div className="vector-result-summary">
                匹配到 {results.length} 个相关文本块
              </div>
              {results.map((result) => (
                <article className="vector-result" key={result.id}>
                  <header>
                    <div className="vector-result-origin">
                      <strong title={result.source_path}>{result.source_path}</strong>
                      {resultSection(result.source_path, result.heading_path, result.chapter) && (
                        <small>{resultSection(result.source_path, result.heading_path, result.chapter)}</small>
                      )}
                      <span>第 {result.line_start}–{result.line_end} 行 · 块 #{result.chunk_index + 1}</span>
                    </div>
                    <b>{result.score.toFixed(3)}</b>
                  </header>
                  <p>{resultPreview(result.content)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
      {indexNoticeOpen && (
        <div
          className="vector-demo-modal-backdrop"
          role="presentation"
          onMouseDown={() => setIndexNoticeOpen(false)}
        >
          <section
            className="vector-demo-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vector-demo-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Database size={20} />
            <h2 id="vector-demo-modal-title">Demo 模式</h2>
            <p>当前演示环境不允许从前端构建索引，以保护既有向量数据。</p>
            <button type="button" onClick={() => setIndexNoticeOpen(false)}>知道了</button>
          </section>
        </div>
      )}
    </main>
  );
}
