export interface Model { id: string; name: string; capabilities?: string[]; }
export interface Platform { id: string; name: string; }
export interface Source { id: string; score: number; source_path: string; category: string; book: string; chapter: string; heading_path: string; line_start: number; line_end: number; content: string; }
export interface Retrieval { parsed: { concepts: string[]; entities: string[] }; sources: Source[]; context: string; }
export interface Turn { id: string; question: string; answer: string; model: string; retrieval: Retrieval | null; error?: string; }
export interface Conversation { id: string; title: string; updatedAt: string; turns: Turn[]; }
export interface HistoryMessage { role: 'user' | 'assistant'; content: string; }
export const conversationStorageKey = 'paperbox-knowledge-conversations-v1';

function browserRandomUUID() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '';
}

export function createLocalId(randomUUID: (() => string) | null = browserRandomUUID) {
  try {
    const id = randomUUID?.();
    if (id) return id;
  } catch { /* Fall back when the browser does not expose a UUID API. */ }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Keep complete recent pairs within a fixed prompt budget. */
export function conversationHistory(turns: Turn[]): HistoryMessage[] {
  const pairs: HistoryMessage[][] = [];
  let remaining = 12_000;
  for (const turn of turns.filter((item) => item.answer && !item.error).slice(-6).reverse()) {
    const question = turn.question.slice(0, 4000);
    const answer = turn.answer.replace(/\[S\d+\]/g, '').slice(0, 4000);
    if (!question.trim() || !answer.trim()) continue;
    if (question.length + answer.length > remaining) break;
    remaining -= question.length + answer.length;
    pairs.unshift([{ role: 'user', content: question }, { role: 'assistant', content: answer }]);
  }
  return pairs.flat();
}

export function readConversations(): Conversation[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(conversationStorageKey) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter((item): item is Conversation => Boolean(item && typeof item.id === 'string'
      && typeof item.title === 'string' && typeof item.updatedAt === 'string' && Array.isArray(item.turns)
      && item.turns.every((turn: Turn) => turn && typeof turn.id === 'string' && typeof turn.question === 'string'
        && typeof turn.answer === 'string' && (!turn.retrieval || (Array.isArray(turn.retrieval.sources)
          && Array.isArray(turn.retrieval.parsed?.concepts) && Array.isArray(turn.retrieval.parsed?.entities))))));
  } catch { return []; }
}

export function sourceChapterPath(sourcePath: string) {
  const path = sourcePath.replace(/\\/g, '/');
  if (path.startsWith('../data/papers/')) return path;
  if (path.startsWith('data/papers/')) return `../${path}`;
  return `../data/papers/${path}`;
}

export function sourceTitle(source: Source) {
  const file = source.source_path.split('/').pop()?.replace(/\.md$/i, '') ?? '未命名资料';
  const parts = source.heading_path.split(/\s*>\s*/).filter(Boolean);
  return { file, chapter: parts.at(-1) || source.chapter };
}
