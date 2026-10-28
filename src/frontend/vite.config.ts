// @ts-nocheck -- Vite's runtime carries Node typings, while this UI package does not install them.
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { knowledgeChatMessages } from './server/knowledge-chat';
import { parseQwenFrames, qwenGenerationParameters, qwenGenerationRoutes, qwenInputMessages, qwenTextDelta } from './server/qwen-stream';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = resolve(webRoot, '../..');
const papersRoot = resolve(webRoot, '../../data/papers');
const patternsRoot = resolve(webRoot, '../../data/prompts');
const modelDataRoot = resolve(webRoot, '../../data/model');
let modelEnvironment: Record<string, string> = {};
const execFileAsync = promisify(execFile);
const pdfMetadataCache = new Map<string, { version: string; metadata: PdfMetadata }>();
const pdfTextCache = new Map<string, { modifiedAt: number; text: string }>();

interface PdfMetadata {
  title: string;
  author: string;
  researchArea: string;
  tags: string[];
  abstract: string;
  summary: string;
  classification?: Record<string, string[]>;
  hierarchy?: { primaryResearchField?: string; secondaryResearchField?: string; coreTechnologies?: string[]; coreTechnology?: string };
  methodName?: string;
  methodAbbreviation?: string;
  paperNodeName?: string;
  venue?: string;
  year?: string;
}

function modelCacheFile(platformId: unknown) {
  const safeId = String(platformId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safeId ? resolve(modelDataRoot, `${safeId}.models.json`) : null;
}

function modelUsageFile(platformId: unknown) {
  const safeId = String(platformId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safeId ? resolve(modelDataRoot, `${safeId}.usage.json`) : null;
}

function modelSelectionFile(platformId: unknown) {
  const safeId = String(platformId ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return safeId ? resolve(modelDataRoot, `${safeId}.selection.json`) : null;
}

function paperPath(value: string) {
  const normalized = String(value).replace(/\\/g, '/').replace(/^(?:\.\.\/)+/, '');
  const target = resolve(workspaceRoot, normalized);
  const remainder = relative(papersRoot, target);
  if (remainder === '..' || remainder.startsWith('../') || isAbsolute(remainder)) return null;
  return target;
}

function patternPath(value: string) {
  const target = resolve(webRoot, value);
  const remainder = relative(patternsRoot, target);
  if (!remainder || remainder === '..' || remainder.startsWith('../') || isAbsolute(remainder) || extname(target).toLowerCase() !== '.md' || /(?:^|[\\/])README\.md$/i.test(target)) return null;
  return target;
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(filePath);
    return extname(entry.name).toLowerCase() === '.md' ? [filePath] : [];
  }));
  return files.flat();
}

function sendJson(response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function sendAsset(response: { statusCode: number; setHeader(name: string, value: string): void; end(body: Uint8Array): void }, filePath: string, content: Uint8Array) {
  const mimeTypes = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
  response.statusCode = 200;
  response.setHeader('Content-Type', mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.end(content);
}

async function paperCatalogRecords() {
  const categories = (await readdir(papersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const records = [];
  for (const category of categories) {
    const categoryPath = resolve(papersRoot, category.name);
    const documents = (await readdir(categoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    for (const document of documents) {
      const documentPath = resolve(categoryPath, document.name);
      const displayName = document.name.replace(/^\d+_/, '');
      const files = await walkFiles(documentPath);
      const markdown = files.filter((file) => extname(file).toLowerCase() === '.md').sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
      const pdf = files.find((file) => extname(file).toLowerCase() === '.pdf');
      const metadata = pdf
        ? await readPdfMetadata(pdf, displayName, category.name)
        : {
            title: displayName,
            author: '未标注',
            researchArea: category.name.replace(/^\d+_/, ''),
            tags: [category.name.replace(/^\d+_/, '')],
            abstract: '暂无 PDF 摘要。',
            summary: '请导入该论文的 PDF 文件后查看内容摘要。',
          };
      records.push({
        id: relative(papersRoot, documentPath).split('\\').join('/'),
        category: metadata.hierarchy?.secondaryResearchField || metadata.researchArea || (category.name.includes('导入论文') ? '待分类' : category.name.replace(/^\d+_/, '')),
        title: metadata.title,
        author: metadata.author,
        researchArea: metadata.researchArea,
        tags: metadata.tags,
        abstract: metadata.abstract,
        summary: metadata.summary,
        classification: metadata.classification,
        hierarchy: metadata.hierarchy,
        methodName: metadata.methodName,
        methodAbbreviation: metadata.methodAbbreviation,
        paperNodeName: metadata.paperNodeName,
        venue: metadata.venue,
        year: metadata.year,
        sourcePath: relative(workspaceRoot, documentPath).split('\\').join('/'),
        pdfPath: pdf ? relative(workspaceRoot, pdf).split('\\').join('/') : undefined,
        markdownCount: markdown.length,
        imageCount: files.filter((file) => /\.(jpg|jpeg|png|webp)$/i.test(file)).length,
        modifiedAt: (await stat(documentPath)).mtime.toISOString(),
        preview: pdf ? '已导入 PDF 论文，可在右侧阅读器中查看。' : '暂无 PDF 文件，请重新导入论文。',
        chapters: pdf ? [{ title: '论文 PDF', sourcePath: relative(workspaceRoot, pdf).split('\\').join('/') }] : []
      });
    }
  }
  return records;
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const filePath = resolve(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  }));
  return files.flat();
}

function compactText(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, ' ').trim();
}

function metadataValue(output: string, key: string) {
  return output.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'mi'))?.[1]?.trim() ?? '';
}

function inferTags(text: string, category: string) {
  const candidates = [
    ['大语言模型', /large language model|llm|语言模型/i],
    ['智能体', /agent|acting|reasoning/i],
    ['知识问答', /question answering|qa|问答/i],
    ['检索增强生成', /retrieval augmented|retrieval-augmented|rag/i],
    ['知识图谱', /knowledge graph/i],
    ['深度学习', /deep learning|neural network/i],
    ['数据集', /dataset|benchmark/i],
  ];
  const tags = candidates.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return Array.from(new Set([category.replace(/^\d+_/, ''), ...tags])).filter(Boolean).slice(0, 6);
}

async function readPdfMetadata(filePath: string, fallbackTitle: string, category: string): Promise<PdfMetadata> {
  const pdfModifiedAt = (await stat(filePath)).mtimeMs;
  const metadataFile = resolve(dirname(filePath), '.paperbox.json');
  let savedMetadata: Partial<PdfMetadata> | null = null;
  let metadataModifiedAt = 0;
  try {
    metadataModifiedAt = (await stat(metadataFile)).mtimeMs;
    const parsed = JSON.parse(await readFile(metadataFile, 'utf8'));
    if (parsed && typeof parsed === 'object') savedMetadata = parsed as Partial<PdfMetadata>;
  } catch { /* Imported papers do not have metadata until background processing completes. */ }
  const version = `${pdfModifiedAt}:${metadataModifiedAt}`;
  const cached = pdfMetadataCache.get(filePath);
  if (cached?.version === version) return cached.metadata;
  let info = '';
  let text = '';
  try { info = (await execFileAsync('pdfinfo', [filePath], { maxBuffer: 2 * 1024 * 1024 })).stdout; } catch { /* Optional system utility. */ }
  try { text = (await execFileAsync('pdftotext', ['-f', '1', '-l', '2', '-raw', filePath, '-'], { maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { /* Scanned PDFs may have no text layer. */ }
  const lines = text.split(/\r?\n/).map(compactText).filter(Boolean);
  const titleLines = lines.slice(0, 8).filter((line) => !/@/.test(line) && !/department|university|research|arXiv:/i.test(line) && !/,/.test(line) && !/^\d+$/.test(line) && !/^abstract$/i.test(line));
  const title = metadataValue(info, 'Title') || titleLines.slice(0, 2).join(' ') || fallbackTitle;
  const inferredAuthor = lines.slice(2, 12)
    .map((line) => {
      if (/^\d+$/.test(line) || /department|university|research|@/i.test(line)) return '';
      return /[A-Za-z\u4e00-\u9fff]/.test(line) ? line : '';
    })
    .filter(Boolean)
    .join(' ')
    .replace(/[∗*]/g, '')
    .replace(/\d+/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^,\s*|,\s*$/g, '');
  const author = metadataValue(info, 'Author') || inferredAuthor || 'PDF 中未标注';
  const abstractStart = lines.findIndex((line) => /^(abstract|a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|摘要)$/i.test(line));
  const abstractLines = abstractStart >= 0 ? lines.slice(abstractStart + 1).filter((line) => !/^\d+(?:\.\d+)*\s+/.test(line)).slice(0, 8) : [];
  const abstract = compactText(abstractLines.join(' ')).slice(0, 1200) || 'PDF 中未提取到摘要。';
  const fullText = compactText(`${title} ${abstract} ${text}`);
  const metadata: PdfMetadata = {
    title: compactText(title).slice(0, 220),
    author: compactText(author).slice(0, 300),
    researchArea: category.replace(/^\d+_/, '') || '未分类',
    tags: inferTags(fullText, category),
    abstract,
    summary: abstract === 'PDF 中未提取到摘要。' ? '已导入 PDF，可在右侧阅读器中查看全文。' : abstract.slice(0, 500),
  };
  const savedTags = Array.isArray(savedMetadata?.tags) ? savedMetadata.tags.filter((tag): tag is string => typeof tag === 'string' && Boolean(tag.trim())).slice(0, 8) : null;
  const merged: PdfMetadata = {
    title: typeof savedMetadata?.title === 'string' && savedMetadata.title.trim() ? savedMetadata.title.trim().slice(0, 220) : metadata.title,
    author: typeof savedMetadata?.author === 'string' && savedMetadata.author.trim() ? savedMetadata.author.trim().slice(0, 300) : metadata.author,
    researchArea: typeof savedMetadata?.researchArea === 'string' && savedMetadata.researchArea.trim() ? savedMetadata.researchArea.trim().slice(0, 100) : metadata.researchArea,
    tags: savedTags?.length ? savedTags : metadata.tags,
    abstract: typeof savedMetadata?.abstract === 'string' && savedMetadata.abstract.trim() ? savedMetadata.abstract.trim().slice(0, 3000) : metadata.abstract,
    summary: typeof savedMetadata?.summary === 'string' && savedMetadata.summary.trim() ? savedMetadata.summary.trim().slice(0, 12000) : metadata.summary,
    classification: savedMetadata?.classification && typeof savedMetadata.classification === 'object' ? savedMetadata.classification : undefined,
    hierarchy: savedMetadata?.hierarchy && typeof savedMetadata.hierarchy === 'object' ? {
      primaryResearchField: typeof savedMetadata.hierarchy.primaryResearchField === 'string' ? savedMetadata.hierarchy.primaryResearchField.trim().slice(0, 80) : '',
      secondaryResearchField: typeof savedMetadata.hierarchy.secondaryResearchField === 'string' ? savedMetadata.hierarchy.secondaryResearchField.trim().slice(0, 80) : '',
      coreTechnologies: Array.isArray(savedMetadata.hierarchy.coreTechnologies)
        ? savedMetadata.hierarchy.coreTechnologies.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim().slice(0, 40)).slice(0, 3)
        : typeof savedMetadata.hierarchy.coreTechnology === 'string' && savedMetadata.hierarchy.coreTechnology.trim()
          ? [savedMetadata.hierarchy.coreTechnology.trim().slice(0, 40)]
          : [],
    } : undefined,
    methodName: typeof savedMetadata?.methodName === 'string' ? savedMetadata.methodName.trim().slice(0, 240) : '',
    methodAbbreviation: typeof savedMetadata?.methodAbbreviation === 'string' ? savedMetadata.methodAbbreviation.trim().slice(0, 80) : '',
    paperNodeName: typeof savedMetadata?.paperNodeName === 'string' ? savedMetadata.paperNodeName.trim().slice(0, 48) : '',
    venue: typeof savedMetadata?.venue === 'string' ? savedMetadata.venue.trim().slice(0, 160) : '',
    year: typeof savedMetadata?.year === 'string' && /^\d{4}$/.test(savedMetadata.year.trim()) ? savedMetadata.year.trim() : '',
  };
  pdfMetadataCache.set(filePath, { version, metadata: merged });
  return merged;
}

async function readPdfText(filePath: string) {
  const modifiedAt = (await stat(filePath)).mtimeMs;
  const cached = pdfTextCache.get(filePath);
  if (cached?.modifiedAt === modifiedAt) return cached.text;
  try {
    const text = (await execFileAsync('pdftotext', ['-layout', filePath, '-'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
    pdfTextCache.set(filePath, { modifiedAt, text });
    return text;
  } catch {
    return '';
  }
}

/** A local Vite-only reader for the paper catalog. */
function paperLibraryPlugin() {
  const middleware = async (request: { url?: string; method?: string; headers?: Record<string, string | string[] | undefined>; on(event: string, listener: (chunk?: Uint8Array) => void): void }, response: Parameters<typeof sendJson>[0], next: () => void) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/paper-api/')) return next();

    if (url.pathname === '/paper-api/catalog' && request.method === 'GET') {
      try { return sendJson(response, 200, { papers: await paperCatalogRecords() }); }
      catch { return sendJson(response, 200, { papers: [] }); }
    }

    const requestedPath = url.pathname === '/paper-api/asset'
      ? url.searchParams.get('chapter') ?? ''
      : url.searchParams.get('path') ?? url.searchParams.get('scope') ?? '';
    const resolvedPath = paperPath(requestedPath);
    if (!resolvedPath) return sendJson(response, 400, { error: '论文路径无效。' });

    try {
      if (url.pathname === '/paper-api/asset') {
        const chapterPath = paperPath(url.searchParams.get('chapter') ?? '');
        const source = url.searchParams.get('src') ?? '';
        if (!chapterPath || !source || /^(?:https?:|data:)/i.test(source)) return sendJson(response, 400, { error: '论文图片路径无效。' });
        const assetPath = resolve(dirname(chapterPath), source);
        const assetRelative = relative(papersRoot, assetPath);
        if (assetRelative === '..' || assetRelative.startsWith('../') || isAbsolute(assetRelative) || (await stat(assetPath)).isDirectory()) return sendJson(response, 400, { error: '论文图片路径无效。' });
        return sendAsset(response, assetPath, await readFile(assetPath));
      }
      if (url.pathname === '/paper-api/pdf') {
        if (extname(resolvedPath).toLowerCase() !== '.pdf' || !(await stat(resolvedPath)).isFile()) return sendJson(response, 400, { error: 'PDF 路径无效。' });
        return sendAsset(response, resolvedPath, await readFile(resolvedPath));
      }
      if (url.pathname === '/paper-api/chapter') {
        if (extname(resolvedPath).toLowerCase() !== '.md') return sendJson(response, 400, { error: '只能读取 Markdown 论文章节。' });
        return sendJson(response, 200, { content: await readFile(resolvedPath, 'utf8') });
      }
      if (url.pathname === '/paper-api/search') {
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase();
        if (!query) return sendJson(response, 200, { results: [] });
        if (!(await stat(resolvedPath)).isDirectory()) return sendJson(response, 400, { error: '论文检索范围无效。' });
        const results: Array<{ sourcePath: string; title: string; before: string; match: string; after: string; page?: number }> = [];
        const addMatches = (content: string, normalizedContent: string, sourcePath: string, title: string, page?: number) => {
          let offset = 0;
          while (offset <= normalizedContent.length - query.length) {
            const index = normalizedContent.indexOf(query, offset);
            if (index < 0) break;
            const before = compactText(content.slice(Math.max(0, index - 100), index));
            const match = content.slice(index, index + query.length);
            const after = compactText(content.slice(index + query.length, Math.min(content.length, index + query.length + 180)));
            results.push({ sourcePath, title, page, before, match, after });
            offset = index + Math.max(1, query.length);
          }
        };
        const scopedFiles = await walkFiles(resolvedPath);
        const pdfFiles = scopedFiles.filter((filePath) => extname(filePath).toLowerCase() === '.pdf');
        const searchFiles = pdfFiles.length ? pdfFiles : scopedFiles;
        for (const filePath of searchFiles) {
          const extension = extname(filePath).toLowerCase();
          if (extension !== '.md' && extension !== '.pdf') continue;
          const content = extension === '.pdf'
            ? await readPdfText(filePath)
            : await readFile(filePath, 'utf8');
          if (extension === '.pdf') {
            const pages = content.split('\f');
            pages.forEach((pageContent, pageIndex) => {
              addMatches(pageContent, pageContent.toLowerCase(), relative(workspaceRoot, filePath).split('\\').join('/'), filePath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? '未命名论文', pageIndex + 1);
            });
          } else {
            const normalizedContent = content.toLowerCase();
            addMatches(content, normalizedContent, relative(workspaceRoot, filePath).split('\\').join('/'), filePath.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '未命名章节');
          }
        }
        return sendJson(response, 200, { results, totalMatches: results.length });
      }
      return sendJson(response, 404, { error: '论文接口不存在。' });
    } catch {
      return sendJson(response, 404, { error: '未能读取论文文件。' });
    }
  };

  return {
    name: 'local-paper-library',
    configureServer(server: { middlewares: { use(handler: typeof middleware): void } }) { server.middlewares.use(middleware); },
    configurePreviewServer(server: { middlewares: { use(handler: typeof middleware): void } }) { server.middlewares.use(middleware); }
  };
}

/** Serves local paper-processing prompt templates without exposing them to the browser bundle. */
function patternLibraryPlugin() {
  const middleware = async (request: { url?: string; method?: string }, response: Parameters<typeof sendJson>[0], next: () => void) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/pattern-api/')) return next();

    try {
      if (url.pathname === '/pattern-api/catalog' && request.method === 'GET') {
        const files = (await markdownFiles(patternsRoot)).filter((file) => !/(?:^|[\\/])README\.md$/i.test(file));
        const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
        const patterns = await Promise.all(files.map(async (file) => {
          const content = await readFile(file, 'utf8');
          const relativeFile = relative(patternsRoot, file).split('\\').join('/');
          const field = (name: string) => content.match(new RegExp(`^(?:[-*]\\s*)?${name}[:：]\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
          const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? '未命名提示模板';
          return {
            id: relativeFile,
            path: relative(webRoot, file).split('\\').join('/'),
            title,
            category: field('分类') || '论文处理',
            summary: field('说明'),
            source: field('适用位置'),
            searchText: content.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLocaleLowerCase()
          };
        }));
        patterns.sort((a, b) => collator.compare(a.category, b.category) || collator.compare(a.title, b.title));
        return sendJson(response, 200, { patterns });
      }

      if (url.pathname === '/pattern-api/document' && request.method === 'GET') {
        const document = patternPath(url.searchParams.get('path') ?? '');
        if (!document) return sendJson(response, 400, { error: '提示模板路径无效。' });
        return sendJson(response, 200, { content: await readFile(document, 'utf8') });
      }

      if (url.pathname === '/pattern-api/asset' && request.method === 'GET') {
        const document = patternPath(url.searchParams.get('path') ?? '');
        const source = url.searchParams.get('src') ?? '';
        if (!document || !source || /^(?:https?:|data:)/i.test(source)) return sendJson(response, 400, { error: '提示模板插图路径无效。' });
        const assetPath = resolve(dirname(document), source);
        const assetRelative = relative(patternsRoot, assetPath);
        if (assetRelative === '..' || assetRelative.startsWith('../') || isAbsolute(assetRelative) || (await stat(assetPath)).isDirectory()) return sendJson(response, 400, { error: '提示模板插图路径无效。' });
        return sendAsset(response, assetPath, await readFile(assetPath));
      }

      return sendJson(response, 404, { error: '提示模板接口不存在。' });
    } catch {
      return sendJson(response, 404, { error: '未能读取提示模板文件。' });
    }
  };

  return {
    name: 'local-paper-prompt-library',
    configureServer(server: { middlewares: { use(handler: typeof middleware): void } }) { server.middlewares.use(middleware); },
    configurePreviewServer(server: { middlewares: { use(handler: typeof middleware): void } }) { server.middlewares.use(middleware); }
  };
}

function readRequestJson(request: { on(event: string, listener: (chunk?: Uint8Array) => void): void }) {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('请求内容不是有效 JSON。')); }
    });
    request.on('error', reject);
  });
}

function qwenApiBase(value: unknown) {
  try {
    const url = new URL(String(value));
    const trustedHost = url.hostname === 'dashscope.aliyuncs.com' || url.hostname.endsWith('.maas.aliyuncs.com');
    if (url.protocol !== 'https:' || !trustedHost || !url.pathname.replace(/\/$/, '').endsWith('/api/v1')) return null;
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function qwenEnvironmentPlatform() {
  const baseUrl = qwenApiBase(modelEnvironment.LLM_URL);
  if (!baseUrl) return null;
  return {
    id: 'qwen-env',
    name: 'Qwen 环境变量平台',
    baseUrl,
    apiKey: String(modelEnvironment.LLM_API_KEY ?? '').trim(),
  };
}

async function readModelPlatforms() {
  const environmentPlatform = qwenEnvironmentPlatform();
  return environmentPlatform ? [environmentPlatform] : [];
}

async function readQwenModelModalities(platformId: unknown, modelId: string): Promise<string[]> {
  const cacheFile = modelCacheFile(platformId);
  if (!cacheFile) throw new Error('平台标识无效，无法读取模型类型。');
  let cached: any;
  try { cached = JSON.parse(await readFile(cacheFile, 'utf8')); }
  catch { throw new Error('模型列表缓存不可用，请先在“模型选择”刷新模型。'); }
  const model = cached.models?.find((item: any) => item.id === modelId);
  if (!model) throw new Error('所选模型不在当前缓存中，请先在“模型选择”刷新模型。');
  if (!Array.isArray(model.modalities) || model.modalities.length === 0) throw new Error('所选模型缺少模态信息，请先在“模型选择”刷新模型。');
  return model.modalities;
}

function emptyModelUsage() {
  return { startedAt: null, updatedAt: null, models: {} as Record<string, any> };
}

function emptyModelSelection() {
  return { persisted: false, updatedAt: null, enabledModelIds: [] as string[] };
}

function normalizeModelIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

async function readModelSelection(platformId: unknown) {
  const selectionFile = modelSelectionFile(platformId);
  if (!selectionFile) return emptyModelSelection();
  try {
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    return { persisted: true, updatedAt: typeof selection?.updatedAt === 'string' ? selection.updatedAt : null, enabledModelIds: normalizeModelIds(selection?.enabledModelIds) };
  } catch { return emptyModelSelection(); }
}

const modelSelectionWrites = new Map<string, Promise<any>>();

async function writeModelSelection(platformId: unknown, enabledModelIds: unknown) {
  const selectionFile = modelSelectionFile(platformId);
  if (!selectionFile) throw new Error('平台标识无效，无法保存模型选择。');
  const selection = { updatedAt: new Date().toISOString(), enabledModelIds: normalizeModelIds(enabledModelIds) };
  const queued = modelSelectionWrites.get(selectionFile) ?? Promise.resolve();
  const write = queued.catch(() => undefined).then(async () => {
    await mkdir(modelDataRoot, { recursive: true });
    await writeFile(selectionFile, `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
    return { persisted: true, ...selection };
  });
  modelSelectionWrites.set(selectionFile, write);
  try { return await write; }
  finally { if (modelSelectionWrites.get(selectionFile) === write) modelSelectionWrites.delete(selectionFile); }
}

async function readModelUsage(platformId: unknown) {
  const usageFile = modelUsageFile(platformId);
  if (!usageFile) return emptyModelUsage();
  try {
    const usage = JSON.parse(await readFile(usageFile, 'utf8'));
    return usage && typeof usage.models === 'object' ? { ...emptyModelUsage(), ...usage } : emptyModelUsage();
  } catch { return emptyModelUsage(); }
}

const modelUsageWrites = new Map<string, Promise<any>>();

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function responseTokenUsage(payload: any) {
  const usage = payload?.usage ?? payload?.output?.usage ?? {};
  const inputTokens = numberOrZero(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
  const outputTokens = numberOrZero(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
  const totalValue = usage.total_tokens ?? usage.totalTokens;
  const totalTokens = totalValue === undefined || totalValue === null ? inputTokens + outputTokens : numberOrZero(totalValue);
  return { inputTokens, outputTokens, totalTokens };
}

/** Records only successful inference calls made through this local application. */
async function recordModelUsage(platformId: unknown, model: unknown, usage: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  const usageFile = modelUsageFile(platformId);
  const modelId = String(model ?? '').trim();
  if (!usageFile || !modelId) return null;
  const queued = modelUsageWrites.get(usageFile) ?? Promise.resolve();
  const write = queued.catch(() => undefined).then(async () => {
    await mkdir(modelDataRoot, { recursive: true });
    const data = await readModelUsage(platformId);
    const now = new Date().toISOString();
    const current = data.models[modelId] ?? { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const next = {
      requests: numberOrZero(current.requests) + 1,
      inputTokens: numberOrZero(current.inputTokens) + usage.inputTokens,
      outputTokens: numberOrZero(current.outputTokens) + usage.outputTokens,
      totalTokens: numberOrZero(current.totalTokens) + usage.totalTokens,
      lastUsedAt: now
    };
    const nextData = { ...data, startedAt: data.startedAt ?? now, updatedAt: now, models: { ...data.models, [modelId]: next } };
    await writeFile(usageFile, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
    return next;
  });
  modelUsageWrites.set(usageFile, write);
  try { return await write; }
  finally { if (modelUsageWrites.get(usageFile) === write) modelUsageWrites.delete(usageFile); }
}

function publicPlatforms(platforms: any[]) {
  return platforms.map(({ id, name, baseUrl }) => ({ id, name, baseUrl }));
}

async function qwenPlatformData(platform: any) {
  const baseUrl = qwenApiBase(platform.baseUrl);
  if (!baseUrl || !platform.apiKey?.trim()) throw new Error('请检查 .env 中的 LLM_URL 与 LLM_API_KEY。');
  const headers = { Authorization: `Bearer ${platform.apiKey.trim()}`, 'Content-Type': 'application/json' };
  const modelUrl = new URL(`${baseUrl}/models`);
  modelUrl.searchParams.set('page_no', '1');
  modelUrl.searchParams.set('page_size', '100');
  const [modelsResponse, quotaResponse] = await Promise.all([
    fetch(modelUrl, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(`${baseUrl}/models/limits`, { headers, signal: AbortSignal.timeout(15_000) })
  ]);
  const modelPayload = await modelsResponse.json().catch(() => ({}));
  const quotaPayload = await quotaResponse.json().catch(() => ({}));
  if (!modelsResponse.ok) throw new Error(modelPayload.message ?? modelPayload.code ?? `百炼返回 HTTP ${modelsResponse.status}。`);
  if (!quotaResponse.ok) throw new Error(quotaPayload.message ?? quotaPayload.code ?? `百炼返回 HTTP ${quotaResponse.status}。`);
  const rawModels = modelPayload.output?.models ?? modelPayload.output?.data ?? modelPayload.data ?? [];
  const rawQuotas = quotaPayload.output?.quotas ?? quotaPayload.output?.limits ?? quotaPayload.output?.data ?? quotaPayload.data ?? [];
  const models = (Array.isArray(rawModels) ? rawModels : []).map((item: any) => ({ id: item.model ?? item.model_id ?? item.id ?? item.name, name: item.name ?? item.model_name ?? item.model ?? item.model_id ?? item.id, context: item.model_info?.context_window ?? item.context_length ?? item.context_window ?? item.context_length_limit, capabilities: item.capabilities ?? item.features ?? [], modalities: item.inference_metadata?.request_modality ?? [] })).filter((item: any) => item.id);
  const quotas = (Array.isArray(rawQuotas) ? rawQuotas : []).map((item: any) => {
    const limit = item.model_limit ?? {};
    return { model: item.model_id ?? item.model ?? item.name, requestLimit: limit.request_limit ?? item.request_rate_limit ?? item.rpm, requestUsed: limit.request_used ?? item.request_used ?? item.request_usage, requestPeriod: limit.request_limit_period, usageLimit: limit.usage_limit ?? item.usage_limit ?? item.quota, usageUsed: limit.usage_used ?? item.usage_used ?? item.usage, usageField: limit.usage_limit_field, usagePeriod: limit.usage_limit_period };
  }).filter((item: any) => item.model);
  return { models, quotas };
}

async function testQwenModel(platform: any, model: unknown, modalities: unknown) {
  const baseUrl = qwenApiBase(platform.baseUrl);
  const modelId = String(model ?? '').trim();
  if (!baseUrl || !platform.apiKey?.trim() || !modelId) throw new Error('缺少平台、密钥或模型标识。');
  const routes = qwenGenerationRoutes(modalities);
  let lastError = '模型测试失败。';
  for (const route of routes) {
    const response = await fetch(`${baseUrl}/services/aigc/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platform.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, input: { messages: qwenInputMessages([{ role: 'user', content: '请直接回复：pong' }], route.startsWith('multimodal-')) }, parameters: qwenGenerationParameters(modelId, { result_format: 'message', max_tokens: 16 }, route.startsWith('multimodal-')) }),
      signal: AbortSignal.timeout(30_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const localUsage = await recordModelUsage(platform.id, modelId, responseTokenUsage(payload));
      const reply = qwenTextDelta(payload);
      if (!reply) throw new Error('模型未返回文本回复。');
      return { reply, available: /pong/i.test(reply), localUsage };
    }
    lastError = payload.message ?? payload.code ?? `百炼返回 HTTP ${response.status}。`;
    if (!/url error/i.test(lastError)) break;
  }
  throw new Error(lastError);
}

async function askQwenModel(platform: any, model: unknown, question: unknown, context: unknown, history: unknown = []) {
  const baseUrl = qwenApiBase(platform.baseUrl);
  const modelId = String(model ?? '').trim();
  const userQuestion = String(question ?? '').trim();
  const ragContext = String(context ?? '').trim();
  if (!baseUrl || !platform.apiKey?.trim() || !modelId) throw new Error('缺少平台、密钥或模型标识。');
  if (!userQuestion || !ragContext) throw new Error('问题或检索上下文为空，无法生成回答。');
  if (userQuestion.length > 4_000 || ragContext.length > 120_000) throw new Error('问题或检索上下文超出模型桥接允许长度。');
  const messages = knowledgeChatMessages(userQuestion, ragContext, history);
  const modalities = await readQwenModelModalities(platform.id, modelId);
  let response: Response | undefined;
  let payload: any = {};
  let lastError = '无法连接百炼服务。';
  for (const route of qwenGenerationRoutes(modalities)) {
    const multimodal = route.startsWith('multimodal-');
    response = await fetch(`${baseUrl}/services/aigc/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platform.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        input: { messages: qwenInputMessages(messages, multimodal) },
        parameters: qwenGenerationParameters(modelId, { result_format: 'message', temperature: 0.2 }, multimodal)
      }),
      signal: AbortSignal.timeout(300_000)
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok) break;
    lastError = payload.message ?? payload.code ?? `百炼返回 HTTP ${response.status}。`;
    if (!/url error/i.test(String(lastError))) break;
  }
  if (!response?.ok) throw new Error(lastError);
  const answer = qwenTextDelta(payload);
  if (!answer.trim()) throw new Error('模型未返回文本回答。');
  return { answer: answer.trim(), localUsage: await recordModelUsage(platform.id, modelId, responseTokenUsage(payload)) };
}

function sendEvent(response: any, event: string, payload: unknown) {
  if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function completeQwenMessages(platform: any, modelId: string, messages: any[], maxTokens: number, signal: AbortSignal, onDelta?: (content: string) => void) {
  const baseUrl = qwenApiBase(platform.baseUrl);
  if (!baseUrl || !platform.apiKey?.trim() || !modelId) throw new Error('缺少平台、密钥或模型标识。');
  const modalities = await readQwenModelModalities(platform.id, modelId);
  let response: Response | undefined;
  let payload: any = {};
  let lastError = '无法连接百炼服务。';
  for (const route of qwenGenerationRoutes(modalities)) {
    const multimodal = route.startsWith('multimodal-');
    response = await fetch(`${baseUrl}/services/aigc/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platform.apiKey.trim()}`, 'Content-Type': 'application/json', ...(onDelta ? { 'X-DashScope-SSE': 'enable' } : {}) },
      body: JSON.stringify({
        model: modelId,
        input: { messages: qwenInputMessages(messages, multimodal) },
        parameters: qwenGenerationParameters(modelId, { result_format: 'message', max_tokens: maxTokens, temperature: 0, ...(onDelta ? { incremental_output: true } : {}) }, multimodal)
      }),
      signal
    });
    if (!onDelta || !response.ok) payload = await response.json().catch(() => ({}));
    if (response.ok) break;
    lastError = payload.message ?? payload.code ?? `百炼返回 HTTP ${response.status}。`;
    if (!/url error/i.test(String(lastError))) break;
  }
  if (!response?.ok) throw new Error(lastError);
  if (onDelta) {
    if (!response.body) throw new Error('Agent 未返回流式响应。');
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let content = '';
    let usage: any = null;
    const handleFrame = (frame: string) => {
      for (const item of parseQwenFrames(frame)) {
        const delta = qwenTextDelta(item);
        if (delta) { content += delta; onDelta(delta); }
        usage = item.usage ?? item.output?.usage ?? item.data?.usage ?? usage;
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        frames.forEach(handleFrame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
    } finally { reader.releaseLock(); }
    if (!content.trim()) throw new Error('需求提取模型未返回文本。');
    await recordModelUsage(platform.id, modelId, responseTokenUsage({ usage }));
    return content.trim();
  }
  const content = qwenTextDelta(payload).trim();
  if (!content) throw new Error('需求提取模型未返回文本。');
  await recordModelUsage(platform.id, modelId, responseTokenUsage(payload));
  return content;
}

/** Streams incremental DashScope deltas without exposing credentials to the browser. */
async function streamQwenModel(platform: any, model: unknown, question: unknown, context: unknown, history: unknown, response: any) {
  const baseUrl = qwenApiBase(platform.baseUrl);
  const modelId = String(model ?? '').trim();
  const userQuestion = String(question ?? '').trim();
  const ragContext = String(context ?? '').trim();
  const maxContextLength = 120_000;
  if (!baseUrl || !platform.apiKey?.trim() || !modelId) throw new Error('缺少平台、密钥或模型标识。');
  if (!userQuestion || !ragContext) throw new Error('问题或检索上下文为空，无法生成回答。');
  if (userQuestion.length > 4_000 || ragContext.length > maxContextLength) throw new Error('问题或检索上下文超出允许长度。');
  const controller = new AbortController();
  const onClose = () => { if (!response.writableEnded) controller.abort(); };
  const timeout = setTimeout(() => controller.abort(), 300_000);
  response.on('close', onClose);
  let messages: any[] = [];
  try {
    messages = knowledgeChatMessages(userQuestion, ragContext, history);
    const modalities = await readQwenModelModalities(platform.id, modelId);
    let upstream: Response | undefined;
    let lastError = '无法连接百炼服务。';
    for (const route of qwenGenerationRoutes(modalities)) {
      const multimodal = route.startsWith('multimodal-');
      upstream = await fetch(`${baseUrl}/services/aigc/${route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${platform.apiKey.trim()}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'enable' },
        body: JSON.stringify({
          model: modelId,
          input: { messages: qwenInputMessages(messages, multimodal) },
          parameters: qwenGenerationParameters(modelId, { result_format: 'message', incremental_output: true, temperature: 0.2 }, multimodal)
        }),
        signal: controller.signal
      });
      if (upstream.ok) break;
      const payload = await upstream.json().catch(() => ({}));
      lastError = payload.message ?? payload.code ?? `百炼返回 HTTP ${upstream.status}。`;
      if (!/url error/i.test(String(lastError))) break;
    }
    if (!upstream?.ok) throw new Error(lastError);
    if (!upstream.body) throw new Error('百炼没有返回流式响应。');

    if (!response.headersSent) {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();
    }

    let answer = '';
    let usage: any = null;
    let buffer = '';
    let payloadCount = 0;
    let lastPayloadShape = '';
    let sawReasoningOnly = false;
    let finishReason = '';
    const decoder = new TextDecoder();
    const handleFrame = (frame: string) => {
      for (const rawPayload of parseQwenFrames(frame)) {
        const payload = rawPayload as any;
        payloadCount += 1;
        const envelope = payload?.data ?? payload;
        const output = envelope?.output ?? payload?.output;
        const choice = output?.choices?.[0] ?? envelope?.choices?.[0] ?? payload?.choices?.[0];
        const fields = (value: any) => value && typeof value === 'object' ? Object.keys(value).slice(0, 8).join(',') : '';
        lastPayloadShape = [
          fields(payload) && `root:${fields(payload)}`,
          fields(output) && `output:${fields(output)}`,
          fields(choice) && `choice:${fields(choice)}`,
          fields(choice?.delta) && `delta:${fields(choice.delta)}`,
          fields(choice?.message) && `message:${fields(choice.message)}`
        ].filter(Boolean).join(' / ');
        sawReasoningOnly ||= Boolean(choice?.delta?.reasoning_content || choice?.message?.reasoning_content);
        finishReason = choice?.finish_reason ?? finishReason;
        const delta = qwenTextDelta(payload);
        if (delta) {
          answer += delta;
          sendEvent(response, 'delta', { content: delta });
        }
        const currentUsage = payload.usage ?? output?.usage ?? envelope?.usage;
        if (currentUsage) usage = currentUsage;
        const upstreamError = payload.error?.message ?? payload.error ?? payload.message;
        if (!delta && upstreamError && (payload.code || payload.error)) throw new Error(String(upstreamError));
      }
    };

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        frames.forEach(handleFrame);
        if (done) break;
      }
      if (buffer.trim()) handleFrame(buffer);
    } finally { reader.releaseLock(); }

    if (controller.signal.aborted) return;
    if (!answer.trim()) {
      const diagnostics = [
        `响应类型 ${upstream.headers.get('content-type') ?? '未知'}`,
        `收到 ${payloadCount} 个数据帧`,
        lastPayloadShape && `字段 ${lastPayloadShape}`,
        finishReason && `结束原因 ${finishReason}`,
        sawReasoningOnly && '仅检测到思考内容'
      ].filter(Boolean).join('；');
      throw new Error(`模型未返回文本回答${diagnostics ? `（${diagnostics}）` : ''}。`);
    }
    const localUsage = await recordModelUsage(platform.id, modelId, responseTokenUsage({ usage }));
    sendEvent(response, 'done', { answer: answer.trim(), localUsage });
    response.end();
  } catch (error) {
    if (response.destroyed || controller.signal.aborted) return;
    const message = error instanceof Error ? error.message : '无法连接百炼服务。';
    if (response.headersSent) {
      sendEvent(response, 'error', { error: message });
      response.end();
    } else {
      sendJson(response, 502, { error: message });
    }
  } finally {
    clearTimeout(timeout);
    response.off('close', onClose);
  }
}

/** Local-only bridge: credentials stay in .env and synchronized data stays under data/model. */
function modelStudioPlugin() {
  return {
    name: 'model-studio-bridge',
    configureServer(server: any) { server.middlewares.use(modelMiddleware); },
    configurePreviewServer(server: any) { server.middlewares.use(modelMiddleware); }
  };
}

async function modelMiddleware(request: any, response: Parameters<typeof sendJson>[0], next: () => void) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/model-api/')) return next();
  try {
    if (url.pathname === '/model-api/platforms' && request.method === 'GET') return sendJson(response, 200, { platforms: publicPlatforms(await readModelPlatforms()) });
    if (url.pathname === '/model-api/cache' && request.method === 'GET') {
      const platformId = url.searchParams.get('platformId');
      const cacheFile = modelCacheFile(platformId);
      if (!cacheFile) return sendJson(response, 400, { error: '平台标识无效。' });
      const [usage, selection] = await Promise.all([readModelUsage(platformId), readModelSelection(platformId)]);
      try {
        const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
        return sendJson(response, 200, { ...cached, usage, selection });
      } catch { return sendJson(response, 200, { models: [], quotas: [], updatedAt: null, usage, selection }); }
    }
    if (request.method !== 'POST') return sendJson(response, 405, { error: '仅支持 POST 请求。' });
    const body = await readRequestJson(request) as { id?: string; name?: string; apiKey?: string; baseUrl?: string; platformId?: string; model?: string; modalities?: string[]; enabledModelIds?: string[]; question?: string; context?: string; history?: unknown; design?: { patternId?: string; previousState?: unknown } };
    if (url.pathname === '/model-api/platforms') {
      return sendJson(response, 405, { error: '模型平台由 .env 环境变量配置，不能在前端修改。' });
    }
    if (url.pathname === '/model-api/sync') {
      const platforms = await readModelPlatforms();
      const platform = platforms.find((item: any) => item.id === body.platformId);
      if (!platform) return sendJson(response, 404, { error: '未找到平台配置。' });
      const data = await qwenPlatformData(platform);
      const updatedAt = new Date().toISOString();
      const cacheFile = modelCacheFile(platform.id);
      if (!cacheFile) return sendJson(response, 400, { error: '平台标识无效。' });
      await mkdir(modelDataRoot, { recursive: true });
      await writeFile(cacheFile, `${JSON.stringify({ updatedAt, ...data }, null, 2)}\n`, 'utf8');
      let selection = await readModelSelection(platform.id);
      if (!selection.persisted) selection = await writeModelSelection(platform.id, data.models.map((model: any) => model.id));
      return sendJson(response, 200, { updatedAt, ...data, usage: await readModelUsage(platform.id), selection });
    }
    if (url.pathname === '/model-api/selection') {
      const platforms = await readModelPlatforms();
      if (!platforms.some((item: any) => item.id === body.platformId)) return sendJson(response, 404, { error: '未找到平台配置。' });
      return sendJson(response, 200, { selection: await writeModelSelection(body.platformId, body.enabledModelIds) });
    }
    if (url.pathname === '/model-api/test') {
      const platforms = await readModelPlatforms();
      const platform = platforms.find((item: any) => item.id === body.platformId);
      if (!platform) return sendJson(response, 404, { error: '未找到平台配置。' });
      return sendJson(response, 200, await testQwenModel(platform, body.model, body.modalities));
    }
    if (url.pathname === '/model-api/chat') {
      const platforms = await readModelPlatforms();
      const platform = platforms.find((item: any) => item.id === body.platformId);
      if (!platform) return sendJson(response, 404, { error: '未找到平台配置。' });
      return sendJson(response, 200, await askQwenModel(platform, body.model, body.question, body.context, body.history));
    }
    if (url.pathname === '/model-api/chat/stream') {
      const platforms = await readModelPlatforms();
      const platform = platforms.find((item: any) => item.id === body.platformId);
      if (!platform) return sendJson(response, 404, { error: '未找到平台配置。' });
      return await streamQwenModel(platform, body.model, body.question, body.context, body.history, response);
    }
    return sendJson(response, 404, { error: '接口不存在。' });
  } catch (error) {
    return sendJson(response, 502, { error: error instanceof Error ? error.message : '无法连接百炼服务。' });
  }
}

export default defineConfig(({ mode }) => {
  modelEnvironment = loadEnv(mode, workspaceRoot, '');
  return {
    plugins: [react(), paperLibraryPlugin(), patternLibraryPlugin(), modelStudioPlugin()],
    server: { host: '0.0.0.0', port: 9100, proxy: { '/api': { target: 'http://127.0.0.1:9200', changeOrigin: true } } },
    build: { sourcemap: true }
  };
});
