import { describe, it, expect, vi, afterEach } from 'vitest';

describe('telemetry 开关', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('默认开启上报', async () => {
    vi.stubEnv('NEXT_PUBLIC_TELEMETRY_ENABLED', '');
    vi.resetModules();
    const mod = await import('./telemetry');
    expect(mod.telemetryEnabled()).toBe(true);
  });

  it('线上构建可用 NEXT_PUBLIC_TELEMETRY_ENABLED=0 关闭', async () => {
    vi.stubEnv('NEXT_PUBLIC_TELEMETRY_ENABLED', '0');
    vi.resetModules();
    const mod = await import('./telemetry');
    expect(mod.telemetryEnabled()).toBe(false);
  });
});
