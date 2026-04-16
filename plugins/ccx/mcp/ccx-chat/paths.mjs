import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

const ROOT = process.env.CCX_CHAT_HOME ?? join(homedir(), '.claude', 'ccx-chat');

export const HOME = ROOT;
export const SOCK = join(ROOT, 'broker.sock');
export const PID_FILE = join(ROOT, 'broker.pid');
export const LOCK_FILE = join(ROOT, 'broker.lock');
export const SESSIONS_FILE = join(ROOT, 'sessions.json');
export const CONFIG_FILE = join(ROOT, 'config.json');
export const LOG_FILE = join(ROOT, 'broker.log');

export async function ensureHome() {
  await mkdir(ROOT, { recursive: true });
}
