import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface AgentConfig {
  uuid: string;
  nickname: string;
}

function defaultConfigDir(): string {
  return process.env.LOCAL_SHARE_CONFIG_DIR || path.join(os.homedir(), '.local-share-agent');
}

export function loadConfig(nicknameOverride?: string): { config: AgentConfig; file: string } {
  const dir = defaultConfigDir();
  const file = path.join(dir, 'config.json');
  let config: AgentConfig;

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentConfig>;
    config = {
      uuid: typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : randomUUID(),
      nickname: typeof raw.nickname === 'string' && raw.nickname ? raw.nickname : os.hostname(),
    };
  } catch {
    config = { uuid: randomUUID(), nickname: os.hostname() };
  }

  if (nicknameOverride && nicknameOverride !== config.nickname) {
    config.nickname = nicknameOverride;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
  return { config, file };
}

export function saveConfig(config: AgentConfig): void {
  const dir = defaultConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}
