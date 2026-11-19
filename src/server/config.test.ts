import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from './config.js';

describe('config', () => {
  let dir: string;
  const original = process.env.LOCAL_SHARE_CONFIG_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-config-'));
    process.env.LOCAL_SHARE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.LOCAL_SHARE_CONFIG_DIR;
    else process.env.LOCAL_SHARE_CONFIG_DIR = original;
  });

  it('首次生成 UUID 与主机名昵称并写入文件', () => {
    const { config, file } = loadConfig();
    expect(config.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.nickname).toBe(os.hostname());
    expect(fs.existsSync(file)).toBe(true);
  });

  it('再次读取保持同一 UUID', () => {
    const first = loadConfig().config;
    const second = loadConfig().config;
    expect(second.uuid).toBe(first.uuid);
  });

  it('覆盖昵称后持久化', () => {
    const config = loadConfig('新昵称').config;
    expect(config.nickname).toBe('新昵称');
    expect(loadConfig().config.nickname).toBe('新昵称');
  });

  it('损坏的配置会重新生成', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ broken');
    const config = loadConfig().config;
    expect(config.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('saveConfig 可写回修改值', () => {
    const config = loadConfig().config;
    config.nickname = '改写昵称';
    saveConfig(config);
    expect(loadConfig().config.nickname).toBe('改写昵称');
  });
});
