export interface ChatMessage { role: 'user' | 'assistant' | 'system'; content: string; }

export function validatedHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history) || history.length > 12 || history.length % 2 !== 0) throw new Error('会话历史格式无效。');
  let size = 0;
  return history.map((item, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (!item || item.role !== role || typeof item.content !== 'string' || !item.content.trim() || item.content.length > 4000) throw new Error('会话历史格式无效。');
    const content = item.content.replace(/\[S\d+\]/g, '');
    size += content.length;
    if (size > 12_000) throw new Error('会话历史超出允许长度。');
    return { role, content };
  });
}

/** Validate history at the bridge boundary; only the current retrieval is evidence. */
export function knowledgeChatMessages(question: string, context: string, history: unknown = []): ChatMessage[] {
  return [
    { role: 'system', content: '你是论文研究助手。仅可依据本轮给定的“检索论文片段”回答；证据不足时必须明确说明。历史对话仅用于理解追问，不是事实依据。资料编号每轮重新编号，仅可引用本轮资料。回答应简洁、专业，并在有依据的结论后以 [S1]、[S2] 形式标注资料编号。不要编造实验结果、方法细节、数据集信息或来源。' },
    ...validatedHistory(history),
    { role: 'user', content: `问题：${question}\n\n检索论文片段：\n${context}` }
  ];
}
