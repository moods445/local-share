import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeChunk, decodeChunk, uuid } from './mesh';

describe('chunk protocol', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';

  it('编解码往返保持内容', () => {
    const payload = new TextEncoder().encode('hello 世界').buffer;
    const encoded = encodeChunk(id, 7, payload);
    const decoded = decodeChunk(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(id);
    expect(decoded!.index).toBe(7);
    expect(new TextDecoder().decode(decoded!.payload)).toBe('hello 世界');
  });

  it('正确处理二进制负载与边界索引', () => {
    const payload = new Uint8Array([0, 255, 1, 128, 0]).buffer;
    const decoded = decodeChunk(encodeChunk(id, 0, payload))!;
    expect(Array.from(new Uint8Array(decoded.payload))).toEqual([0, 255, 1, 128, 0]);
    expect(decoded.index).toBe(0);
  });

  it('拒绝过短的帧', () => {
    expect(decodeChunk(new ArrayBuffer(10))).toBeNull();
  });

  it('负载为空时返回空 ArrayBuffer', () => {
    const decoded = decodeChunk(encodeChunk(id, 3, new ArrayBuffer(0)))!;
    expect(decoded.payload.byteLength).toBe(0);
  });
});

describe('uuid 生成', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('优先使用 crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'from-random-uuid' });
    expect(uuid()).toBe('from-random-uuid');
  });

  it('randomUUID 不可用时用 getRandomValues 生成合规 UUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => { arr.fill(7); return arr; },
    });
    const value = uuid();
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(value[14]).toBe('4');
  });

  it('crypto 完全不可用时回退到 Math.random', () => {
    vi.stubGlobal('crypto', undefined);
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
