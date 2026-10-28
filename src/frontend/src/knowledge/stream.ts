export interface ServerEvent {
  event: string;
  data: unknown;
}

function parseFrame(frame: string): ServerEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const value = data.join('\n');
  return { event, data: value === '[DONE]' ? value : JSON.parse(value) as unknown };
}

/** Read SSE frames across arbitrary network chunk boundaries. */
export async function readServerEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerEvent) => void
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const dispatch = (frame: string) => {
    const event = parseFrame(frame);
    if (event) onEvent(event);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      frames.forEach(dispatch);
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}
