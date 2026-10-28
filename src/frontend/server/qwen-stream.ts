function parseJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error('百炼流式响应格式无效。'); }
}

/** Extract JSON payloads from SSE, NDJSON, or a non-streaming JSON response. */
export function parseQwenFrames(frame: string): unknown[] {
  const lines = frame.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
  if (dataLines.length) {
    const data = dataLines.join('\n').trim();
    return !data || data === '[DONE]' ? [] : [parseJson(data)];
  }

  const content = frame.trim();
  if (!content || content.startsWith(':') || /^(?:event|id|retry):/m.test(content)) return [];
  try { return [JSON.parse(content) as unknown]; }
  catch {
    return content.split(/\r?\n/).filter(Boolean).map(parseJson);
  }
}

function contentText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : contentText(item?.text ?? item?.content ?? '')).join('');
  return content && typeof content.text === 'string' ? content.text : '';
}

export function qwenTextDelta(payload: any): string {
  const envelope = payload?.data ?? payload;
  const output = envelope?.output ?? payload?.output;
  const choice = output?.choices?.[0] ?? envelope?.choices?.[0] ?? payload?.choices?.[0];
  const content = choice?.delta?.content
    ?? choice?.message?.content
    ?? choice?.delta?.text
    ?? choice?.message?.text
    ?? choice?.text
    ?? output?.text
    ?? envelope?.text
    ?? payload?.text
    ?? '';
  return contentText(content);
}

export function qwenGenerationParameters(model: string, parameters: Record<string, unknown>, multimodal = false) {
  const normalized = { ...parameters };
  if (multimodal) delete normalized.result_format;
  return /^qwen3(?:[-._]|$)/i.test(model) ? { ...normalized, enable_thinking: false } : normalized;
}

export function qwenUsesMultimodalEndpoint(modalities: unknown): boolean {
  return Array.isArray(modalities) && modalities.some((item) => String(item).trim() && !/^text$/i.test(String(item).trim()));
}

export function qwenGenerationRoutes(modalities: unknown): string[] {
  const preferred = qwenUsesMultimodalEndpoint(modalities) ? 'multimodal-generation/generation' : 'text-generation/generation';
  const alternate = preferred.startsWith('multimodal-') ? 'text-generation/generation' : 'multimodal-generation/generation';
  return [preferred, alternate];
}

export function qwenInputMessages(messages: Array<{ role: string; content: string }>, multimodal: boolean) {
  // The multimodal endpoint still receives text only; no image/video payload is constructed.
  if (!multimodal) return messages;
  return messages.map((message) => message.role === 'user'
    ? { ...message, content: [{ text: message.content }] }
    : message);
}
