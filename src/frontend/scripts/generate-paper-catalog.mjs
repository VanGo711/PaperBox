import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const papersRoot = resolve(projectRoot, 'data/papers');
const outputFile = resolve(projectRoot, 'src/frontend/src/data/paperCatalog.ts');
const naturalOrder = new Intl.Collator('zh-CN', { numeric: true });

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  }));
  return files.flat();
}

async function preview(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    return text.replace(/^#{1,6}\s+.*$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch { return ''; }
}

async function paperMetadata(documentPath) {
  try {
    const value = JSON.parse(await readFile(resolve(documentPath, '.paperbox.json'), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

async function generateCatalog() {
  await mkdir(papersRoot, { recursive: true });
  const categories = (await readdir(papersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => naturalOrder.compare(a.name, b.name));
  const catalog = [];
  for (const category of categories) {
    const categoryPath = resolve(papersRoot, category.name);
    const documents = (await readdir(categoryPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => naturalOrder.compare(a.name, b.name));
    for (const document of documents) {
      const documentPath = resolve(categoryPath, document.name);
      const displayName = document.name.replace(/^\d+_/, '');
      const files = await walk(documentPath);
      const metadata = await paperMetadata(documentPath);
      const markdownFiles = files.filter((file) => file.endsWith('.md')).sort((a, b) => naturalOrder.compare(a, b));
      const indexFile = markdownFiles.find((file) => /(?:索引|目录)\.md$/u.test(file)) ?? markdownFiles[0];
      catalog.push({
        id: relative(papersRoot, documentPath).split(sep).join('/'),
        category: metadata.hierarchy?.secondaryResearchField || metadata.researchArea || (category.name.includes('导入论文') ? '待分类' : category.name.replace(/^\d+_/, '')),
        title: typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : displayName,
        sourcePath: relative(projectRoot, documentPath).split(sep).join('/'),
        pdfPath: files.find((file) => /\.pdf$/i.test(file)) ? relative(projectRoot, files.find((file) => /\.pdf$/i.test(file))).split(sep).join('/') : undefined,
        markdownCount: markdownFiles.length,
        imageCount: files.filter((file) => /\.(jpg|jpeg|png|webp)$/i.test(file)).length,
        modifiedAt: (await stat(documentPath)).mtime.toISOString(),
        preview: indexFile ? await preview(indexFile) : '',
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
        chapters: markdownFiles.map((file) => ({
          title: relative(documentPath, file).replace(/\.md$/i, '').split(sep).join('/'),
          sourcePath: relative(projectRoot, file).split(sep).join('/')
        }))
      });
    }
  }
  await mkdir(dirname(outputFile), { recursive: true });
  const contents = `/* Generated from data/papers. Run npm run papers:catalog to refresh. */\n\nexport interface PaperChapter { title: string; sourcePath: string; }\n\nexport interface PaperDocument {\n  id: string;\n  category: string;\n  title: string;\n  sourcePath: string;\n  markdownCount: number;\n  imageCount: number;\n  modifiedAt: string;\n  preview: string;\n  chapters: PaperChapter[];\n}\n\nexport const paperCatalog: PaperDocument[] = ${JSON.stringify(catalog, null, 2)};\n`;
  const typedContents = contents.replace('  sourcePath: string;' + String.fromCharCode(10), '  sourcePath: string;' + String.fromCharCode(10) + '  pdfPath?: string;' + String.fromCharCode(10) + '  author?: string;' + String.fromCharCode(10) + '  researchArea?: string;' + String.fromCharCode(10) + '  tags?: string[];' + String.fromCharCode(10) + '  abstract?: string;' + String.fromCharCode(10) + '  summary?: string;' + String.fromCharCode(10) + '  classification?: Record<string, string[]>;' + String.fromCharCode(10) + '  hierarchy?: { primaryResearchField?: string; secondaryResearchField?: string; coreTechnologies?: string[]; coreTechnology?: string; };' + String.fromCharCode(10) + '  methodName?: string;' + String.fromCharCode(10) + '  methodAbbreviation?: string;' + String.fromCharCode(10) + '  paperNodeName?: string;' + String.fromCharCode(10) + '  venue?: string;' + String.fromCharCode(10) + '  year?: string;' + String.fromCharCode(10));
  await writeFile(outputFile, typedContents, 'utf8');
  console.log(`Generated ${catalog.length} paper records.`);
}

generateCatalog();
