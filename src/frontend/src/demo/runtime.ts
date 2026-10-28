import { paperCatalog, type PaperDocument } from '../data/paperCatalog';

export interface DemoContentResult {
  sourcePath: string;
  title: string;
  before: string;
  match: string;
  after: string;
  page?: number;
}

export interface DemoSource {
  id: string;
  score: number;
  source_path: string;
  category: string;
  book: string;
  chapter: string;
  heading_path: string;
  line_start: number;
  line_end: number;
  content: string;
}

const demoPapers = paperCatalog.slice(0, 10);
const demoModels = [
  { id: 'qwen-plus-demo', name: 'Qwen Plus（演示）', capabilities: ['TG'], modalities: ['text'] },
  { id: 'qwen-max-demo', name: 'Qwen Max（演示）', capabilities: ['TG'], modalities: ['text'] },
  { id: 'qwen-long-demo', name: 'Qwen Long（演示）', capabilities: ['TG'], modalities: ['text'] },
];
const modelSelectionKey = 'paperbox-demo-enabled-models';
let taskRecords = [
  { id: 'demo-index-01', type: '论文索引', title: 'SchemaRAG 论文片段构建', state: 'completed', stage: '已生成本地演示索引', createdAt: 1_761_650_400 },
  { id: 'demo-summary-01', type: '论文总结', title: 'Text-to-SQL Survey 内容总结', state: 'completed', stage: '已写入论文摘要与标签', createdAt: 1_761_649_800 },
];

function compact(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function words(value: string) {
  return compact(value).toLocaleLowerCase().split(/[\s,.;:!?，。；：！？、()（）]+/).filter((word) => word.length > 1);
}

function excerptFor(paper: PaperDocument, index: number) {
  const text = compact(`${paper.abstract || ''}\n${paper.summary || ''}`);
  return text || `${paper.title}：该论文已加入演示论文库。`;
}

export function demoPaperCatalog(): PaperDocument[] {
  return demoPapers.map((paper) => ({ ...paper, pdfPath: undefined }));
}

export function searchDemoPaper(paper: PaperDocument, query: string): DemoContentResult[] {
  const normalizedQuery = compact(query);
  if (!normalizedQuery) return [];
  const source = excerptFor(paper, 0);
  const lower = source.toLocaleLowerCase();
  const needle = normalizedQuery.toLocaleLowerCase();
  const results: DemoContentResult[] = [];
  let start = 0;
  while (results.length < 80) {
    const position = lower.indexOf(needle, start);
    if (position < 0) break;
    results.push({
      sourcePath: paper.sourcePath,
      title: paper.title,
      before: source.slice(Math.max(0, position - 46), position),
      match: source.slice(position, position + normalizedQuery.length),
      after: source.slice(position + normalizedQuery.length, position + normalizedQuery.length + 88),
      page: Math.max(1, Math.floor(position / 900) + 1),
    });
    start = position + Math.max(1, normalizedQuery.length);
  }
  if (results.length) return results;

  const terms = words(normalizedQuery);
  const sentences = source.split(/(?<=[。！？.!?])\s+/).filter(Boolean);
  return sentences
    .map((sentence, index) => ({ sentence, index, hits: terms.filter((term) => sentence.toLocaleLowerCase().includes(term)).length }))
    .filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits)
    .slice(0, 12)
    .map(({ sentence, index }) => {
      const matched = terms.find((term) => sentence.toLocaleLowerCase().includes(term)) ?? normalizedQuery;
      const matchIndex = sentence.toLocaleLowerCase().indexOf(matched.toLocaleLowerCase());
      return {
        sourcePath: paper.sourcePath,
        title: paper.title,
        before: sentence.slice(0, Math.max(0, matchIndex)),
        match: sentence.slice(Math.max(0, matchIndex), Math.max(0, matchIndex) + matched.length),
        after: sentence.slice(Math.max(0, matchIndex) + matched.length),
        page: index + 1,
      };
    });
}

export function retrieveDemoSources(question: string, limit = 20): DemoSource[] {
  const queryTerms = words(question);
  const sources = demoPapers.flatMap((paper) => {
    const parts = [paper.abstract, paper.summary]
      .flatMap((value) => (value || '').split(/\n+|(?<=[。！？.!?])\s+/))
      .map(compact)
      .filter((value) => value.length > 36);
    return (parts.length ? parts : [excerptFor(paper, 0)]).map((content, index) => {
      const corpus = `${paper.title} ${(paper.tags ?? []).join(' ')} ${content}`.toLocaleLowerCase();
      const hits = queryTerms.filter((term) => corpus.includes(term)).length;
      const score = Math.min(0.98, 0.34 + (hits / Math.max(1, queryTerms.length)) * 0.58 + Math.max(0, 0.05 - index * 0.01));
      return {
        id: `${paper.id}-${index}`,
        score,
        source_path: paper.sourcePath,
        category: paper.category,
        book: paper.title,
        chapter: index === 0 ? '摘要' : '内容总结',
        heading_path: index === 0 ? '摘要' : '内容总结',
        line_start: index + 1,
        line_end: index + 1,
        content,
        hits,
      };
    });
  });
  return sources
    .sort((left, right) => right.hits - left.hits || right.score - left.score)
    .slice(0, Math.max(1, limit))
    .map(({ hits: _hits, ...source }) => source);
}

export function demoAnswer(question: string, sources: DemoSource[]) {
  const papers = Array.from(new Set(sources.slice(0, 6).map((source) => source.book)));
  const evidence = sources.slice(0, 4).map((source, index) => `- ${source.content} [S${index + 1}]`).join('\n');
  const focus = /检索|rag|召回/i.test(question) ? '检索增强与模式感知召回'
    : /评估|指标|实验/i.test(question) ? '实验评估与误差分析'
      : /agent|智能体/i.test(question) ? '智能体协作与推理规划'
        : 'Text-to-SQL 的问题建模、模式理解与生成过程';
  return `## 基于预置论文库的回答\n\n围绕“${focus}”，当前本地演示库中的证据表明，研究通常将复杂任务拆为**问题理解、候选信息筛选、生成或决策、执行反馈**几个相互约束的环节。相比直接让模型输出最终结果，论文更强调通过结构化上下文、候选验证和反馈信号降低语义偏移。\n\n### 归纳\n\n- **共同目标**：减少自然语言意图与数据库模式、任务状态或外部知识之间的不一致。\n- **主要路径**：使用检索或模式链接缩小候选空间，再以约束、执行结果或多轮推理校正输出。\n- **工程取舍**：更强的召回和多候选验证通常提高可靠性，但会增加上下文长度、延迟和计算成本。\n\n### 命中文献的直接依据\n\n${evidence}\n\n本次回答由浏览器中的预置论文摘要和内容总结生成，未调用外部模型或服务。涉及的主要论文：${papers.join('、')}。`;
}

function json(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers ?? {}) } });
}

async function requestBody(request: Request) {
  try { return await request.clone().json() as Record<string, unknown>; } catch { return {}; }
}

function selectedModels() {
  try {
    const saved = JSON.parse(localStorage.getItem(modelSelectionKey) ?? 'null');
    return Array.isArray(saved) && saved.length ? saved.filter((id) => typeof id === 'string') : demoModels.map((model) => model.id);
  } catch { return demoModels.map((model) => model.id); }
}

function saveSelectedModels(ids: unknown) {
  const valid = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && demoModels.some((model) => model.id === id)) : [];
  try { localStorage.setItem(modelSelectionKey, JSON.stringify(valid)); } catch { /* Optional demo preference. */ }
  return valid;
}

function demoSchema() {
  return {
    schema_version: 1, engine: 'browser-local-demo', storage: '预置静态数据', collection: 'paper_chunks', created: true,
    embedding_model: '本地关键词排序（演示）', dimension: null,
    fields: [
      { name: 'id', type: 'string', role: '主键', index: 'PRIMARY' },
      { name: 'content', type: 'text', role: '内容', index: 'FULLTEXT' },
      { name: 'paper_title', type: 'string', role: '论文', index: 'FILTER' },
      { name: 'page', type: 'integer', role: '位置', index: 'FILTER' },
      { name: 'score', type: 'float', role: '相似度', index: 'RANK' },
    ],
  };
}

/** Provide deterministic browser-only responses for the static demonstration build. */
export function installDemoRuntime() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request
      ? input
      : new Request(new URL(String(input), window.location.href), init);
    const url = new URL(request.url, window.location.origin);
    const path = url.pathname;

    if (path === '/paper-api/catalog') return json({ papers: demoPaperCatalog() });
    if (path === '/paper-api/search') {
      const paper = demoPapers.find((item) => item.sourcePath === url.searchParams.get('scope'));
      const query = url.searchParams.get('query') ?? '';
      const results = paper ? searchDemoPaper(paper, query) : [];
      return json({ results, totalMatches: results.length });
    }
    if (path === '/api/knowledge/retrieve') {
      const body = await requestBody(request);
      const sources = retrieveDemoSources(String(body.question ?? ''), Number(body.limit) || 20);
      return json({ parsed: { concepts: words(String(body.question ?? '')).slice(0, 8), entities: [] }, sources, context: sources.map((source) => source.content).join('\n\n') });
    }
    if (path === '/model-api/chat/stream') {
      const body = await requestBody(request);
      const sources = retrieveDemoSources(String(body.question ?? ''), 6);
      const answer = demoAnswer(String(body.question ?? ''), sources);
      return new Response(`event: delta\ndata: ${JSON.stringify({ content: answer })}\n\nevent: done\ndata: ${JSON.stringify({ answer })}\n\n`, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    }
    if (path === '/model-api/platforms') return json({ platforms: [{ id: 'browser-demo', name: '本地演示模型', baseUrl: '浏览器本地预设结果' }] });
    if (path === '/model-api/cache' || path === '/model-api/sync') {
      const ids = selectedModels();
      return json({ models: demoModels, quotas: [], usage: { models: {}, updatedAt: null }, selection: { persisted: true, enabledModelIds: ids } });
    }
    if (path === '/model-api/selection') {
      const body = await requestBody(request);
      saveSelectedModels(body.enabledModelIds);
      return json({ ok: true });
    }
    if (path === '/model-api/test') return json({ available: true, reply: 'pong（本地演示）', localUsage: { requests: 1, inputTokens: 12, outputTokens: 4, totalTokens: 16, lastUsedAt: new Date().toISOString() } });
    if (path === '/api/vector/status') return json({ collection: 'paper_chunks', created: true, rows: retrieveDemoSources('', 200).length, embedding_model: '本地关键词排序（演示）', paper_root: '预置论文库' });
    if (path === '/api/vector/schema') return json(demoSchema());
    if (path === '/api/vector/filters') return json({ collection: 'paper_chunks', categories: Array.from(new Set(demoPapers.map((paper) => paper.category))), books: demoPapers.map((paper) => paper.title), chapters: ['摘要', '内容总结'] });
    if (path === '/api/vector/search') {
      const body = await requestBody(request);
      const categories = Array.isArray(body.categories) ? new Set(body.categories) : null;
      const books = Array.isArray(body.books) ? new Set(body.books) : null;
      const results = retrieveDemoSources(String(body.query ?? ''), Number(body.limit) || 100)
        .filter((source) => !categories || categories.size === 0 || categories.has(source.category))
        .filter((source) => !books || books.size === 0 || books.has(source.book))
        .map((source, index) => ({ ...source, chunk_index: index, char_start: 0, char_end: source.content.length }));
      return json({ results });
    }
    if (path === '/api/tasks') return json({ tasks: taskRecords });
    if (/^\/api\/tasks\/[^/]+\/cancel$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3] ?? '');
      taskRecords = taskRecords.map((task) => task.id === id ? { ...task, state: 'cancelled', stage: '已在演示模式中停止', finishedAt: Math.floor(Date.now() / 1000) } : task);
      return json({ ok: true });
    }
    if (path === '/api/conversations/knowledge') return json({ conversations: [] });

    return nativeFetch(input, init);
  };
}
