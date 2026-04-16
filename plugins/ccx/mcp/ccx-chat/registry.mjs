import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { SESSIONS_FILE, ensureHome } from './paths.mjs';

function shortId() {
  return randomBytes(2).toString('hex');
}

export class Registry {
  constructor() {
    this.sessions = new Map();
    this.focusByChannel = new Map();
    this.cancelled = new Map();
    this.saveChain = Promise.resolve();
  }

  async load() {
    await ensureHome();
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const s of parsed.sessions ?? []) {
        s.recovered = true;
        s.pendingAsks = [];
        s.messageToSession = [];
        this.sessions.set(s.id, s);
      }
      for (const [ch, id] of Object.entries(parsed.focus ?? {})) {
        this.focusByChannel.set(ch, id);
      }
      const CANCEL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const c of parsed.cancelled ?? []) {
        const age = now - Date.parse(c.at);
        if (age < CANCEL_MAX_AGE_MS) {
          this.cancelled.set(c.id, { reason: c.reason, at: Date.parse(c.at) });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  save() {
    const snapshot = {
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        label: s.label,
        cwd: s.cwd,
        branch: s.branch,
        channelId: s.channelId,
        createdAt: s.createdAt,
        phase: s.phase,
        color: s.color ?? null,
      })),
      focus: Object.fromEntries(this.focusByChannel),
      cancelled: [...this.cancelled.entries()].map(([id, v]) => ({
        id,
        reason: v.reason,
        at: new Date(v.at).toISOString(),
      })),
    };
    const step = this.saveChain.then(async () => {
      await ensureHome();
      const tmp = `${SESSIONS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(snapshot, null, 2));
        await rename(tmp, SESSIONS_FILE);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    });
    this.saveChain = step.catch(() => {});
    return step;
  }

  createId({ exclude } = {}) {
    for (let i = 0; i < 16; i += 1) {
      const id = shortId();
      if (this.sessions.has(id)) continue;
      if (exclude?.has(id)) continue;
      return id;
    }
    throw new Error('exhausted session id space');
  }

  register({ label, cwd, branch, channelId, color }, { exclude } = {}) {
    const id = this.createId({ exclude });
    const session = {
      id,
      label: (label ?? 'ccx session').slice(0, 80),
      cwd: cwd ?? null,
      branch: branch ?? null,
      channelId: channelId ?? null,
      color: color ?? null,
      createdAt: new Date().toISOString(),
      phase: 'implement',
      pendingAsks: [],
      recovered: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()];
  }

  listForChannel(channelId) {
    return this.list().filter((s) => s.channelId === channelId);
  }

  close(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    this.sessions.delete(id);
    for (const [ch, fid] of this.focusByChannel) {
      if (fid === id) this.focusByChannel.delete(ch);
    }
    return s;
  }

  setFocus(channelId, sessionId) {
    if (sessionId) this.focusByChannel.set(channelId, sessionId);
    else this.focusByChannel.delete(channelId);
  }

  getFocus(channelId) {
    return this.focusByChannel.get(channelId);
  }
}
