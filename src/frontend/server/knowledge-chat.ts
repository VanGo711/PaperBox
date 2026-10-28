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
    { role: 'system', content: '你是论文研究助手。请直接、完整地回答问题，充分展开关键概念、方法机制、证据比较、适用条件与局限；不要为了简短而省略必要的推理与说明，也不要使用无意义的保守套话。仅可依据本轮给定的“检索论文片段”及其所属论文摘要作答；摘要仅用于补充整体背景，涉及具体方法、实验结果、数据集或结论时必须以检索片段为准。证据不足时，直接说明缺少哪类证据。历史对话仅用于理解追问，不是事实依据。资料编号每轮重新编号；有依据的具体结论应以 [S1]、[S2] 形式标注对应片段。不得编造实验结果、方法细节、数据集信息或来源。' },
    ...validatedHistory(history),
    { role: 'user', content: `问题：${question}\n\n检索论文片段：\n${context}` }
  ];
}
