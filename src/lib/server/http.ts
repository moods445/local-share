export type LimitedBody = { ok: true; text: string } | { ok: false };

/**
 * 读取请求体并强制大小上限：先看 content-length，再流式边读边计数，
 * 超限立即中断，避免超大 body 被完整读入内存。
 */
export async function readLimitedBody(request: Request, limit: number): Promise<LimitedBody> {
  const header = request.headers.get('content-length');
  if (header && /^\d+$/.test(header.trim()) && Number(header) > limit) {
    return { ok: false };
  }
  if (!request.body) return { ok: true, text: '' };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return { ok: true, text: chunks.join('') };
}
