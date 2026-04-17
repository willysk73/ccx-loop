#!/usr/bin/env node
import { createServer } from 'node:net';
import { readFile, writeFile, unlink, appendFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DiscordAdapter } from './adapters/discord.mjs';
import { SupervisorAdapter } from './adapters/supervisor.mjs';
import { Registry } from './registry.mjs';
import {
  SOCK,
  PID_FILE,
  LOCK_FILE,
  CONFIG_FILE,
  LOG_FILE,
  ensureHome,
} from './paths.mjs';
import { framer, writeJson, connect } from './ipc.mjs';

const DEFAULT_ASK_TIMEOUT_SEC = 900;
const MAX_ASK_TIMEOUT_SEC = 24 * 60 * 60;

async function log(kind, data) {
  const line = `${new Date().toISOString()} [${kind}] ${typeof data === 'string' ? data : JSON.stringify(data)}\n`;
  try {
    await appendFile(LOG_FILE, line);
  } catch {
    /* swallow */
  }
  if (process.env.CCX_CHAT_DEBUG) process.stderr.write(line);
}

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, 'utf8');
  const cfg = JSON.parse(raw);
  if (cfg.backend !== 'discord' && cfg.backend !== 'supervisor') {
    throw new Error(`unsupported backend: ${cfg.backend}`);
  }
  // Discord is always required — either as the sole backend or as the
  // supervisor backend's fallback for announcements + escalated asks.
  if (!cfg.discord?.token || !cfg.discord?.channelId) {
    throw new Error('config.discord.{token,channelId} are required');
  }
  if (!Array.isArray(cfg.discord.allowedUserIds) || cfg.discord.allowedUserIds.length === 0) {
    throw new Error(
      'config.discord.allowedUserIds must be a non-empty array — without it, anyone in the channel can drive ccx sessions (answer chat_ask, run !ccx cancel). Re-run /ccx:chat-setup and provide at least one Discord user ID.',
    );
  }
  const bad = cfg.discord.allowedUserIds.filter((id) => typeof id !== 'string' || !/^\d{5,32}$/.test(id));
  if (bad.length) {
    throw new Error(`config.discord.allowedUserIds contains invalid entries: ${JSON.stringify(bad)} (expected numeric Discord snowflakes as strings)`);
  }
  if (cfg.backend === 'supervisor') {
    const sup = cfg.supervisor ?? {};
    if (sup.fallback !== 'discord') {
      throw new Error('config.supervisor.fallback must be "discord" (only fallback supported in M2)');
    }
    if (sup.autoEscalateAfterSec !== undefined) {
      const v = sup.autoEscalateAfterSec;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 5 || v > 3600) {
        throw new Error('config.supervisor.autoEscalateAfterSec must be a number between 5 and 3600');
      }
    }
  }
  return cfg;
}

// Visual distinguisher when the channel hosts multiple concurrent sessions.
// Squares are used (not circles) so they never collide with the 🟢/🔴 verbs
// in open/close announcements. ⬜/⬛ are excluded — one of them blends into
// every Discord theme.
const SESSION_COLORS = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫'];

function hashColor(sessionId) {
  let h = 5381;
  for (let i = 0; i < sessionId.length; i += 1) {
    h = ((h << 5) + h + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_COLORS[Math.abs(h) % SESSION_COLORS.length];
}

function colorOf(session) {
  return session.color ?? hashColor(session.id);
}

// Sequential assignment per channel: the first colour not in use by another
// live session on the same channel. Compare against the *visible* colour
// (colorOf), not just the persisted field — sessions recovered from snapshots
// written before `color` existed have `s.color === null` but still render via
// hashColor, so a new session would otherwise be allowed to pick the same
// visible emoji. Hash fallback only kicks in when more than
// SESSION_COLORS.length sessions are concurrently open on one channel —
// unrealistic in practice but keeps the function total.
function pickColor(channelId, registry) {
  const taken = new Set(
    registry.listForChannel(channelId).map((s) => colorOf(s)),
  );
  const free = SESSION_COLORS.find((c) => !taken.has(c));
  return free ?? null;
}

function formatSessionLine(s) {
  const age = humanAge(Date.parse(s.createdAt));
  const branch = s.branch ? ` · ${s.branch}` : '';
  const tag = s.recovered ? ' (recovered)' : '';
  return `${colorOf(s)} \`#${s.id}\`${branch} · ${s.phase} · ${age}${tag} — ${s.label}`;
}

function humanAge(tsMs) {
  const diffSec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  return `${Math.floor(diffSec / 3600)}h${Math.floor((diffSec % 3600) / 60)}m`;
}

function parseIdFromToken(token) {
  if (!token) return null;
  const t = token.startsWith('#') ? token.slice(1) : token;
  return /^[a-f0-9]{2,8}$/i.test(t) ? t.toLowerCase() : null;
}

async function main() {
  await ensureHome();
  const config = await loadConfig();

  // Singleton startup: serialize concurrent brokers via an atomic O_EXCL lockfile,
  // and use socket liveness (not a bare PID match) to distinguish a live peer from
  // stale state — a PID alone can be recycled by the OS and false-positive.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(LOCK_FILE, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lock held by another process.
      if (existsSync(SOCK)) {
        try {
          const probe = await connect(SOCK, { timeoutMs: 500 });
          probe.destroy();
          await log('fatal', `another broker is already serving ${SOCK}`);
          process.exit(2);
        } catch {
          // Stale socket + stale lock — safe to take over.
          await unlink(LOCK_FILE).catch(() => {});
          await unlink(SOCK).catch(() => {});
          continue;
        }
      }
      // Lock exists but no socket: peer may still be starting (between lock
      // acquisition and listen()). Wait for it to either bind the socket or
      // release the lock; immediately stealing the lock would reintroduce the
      // duplicate-broker race.
      await log('info', `lock held but no socket yet; waiting for peer (attempt ${attempt})`);
      const { setTimeout: delay } = await import('node:timers/promises');
      await delay(2000);
      if (existsSync(SOCK)) {
        try {
          const probe = await connect(SOCK, { timeoutMs: 500 });
          probe.destroy();
          await log('fatal', `peer broker came up during wait`);
          process.exit(2);
        } catch {
          // Socket appeared but is already stale (peer crashed right after binding).
          await unlink(LOCK_FILE).catch(() => {});
          await unlink(SOCK).catch(() => {});
          continue;
        }
      }
      // After waiting, peer didn't produce a socket — it likely crashed.
      // Force-take the lock.
      await unlink(LOCK_FILE).catch(() => {});
      if (attempt === 4) {
        throw new Error(`could not acquire broker lock at ${LOCK_FILE}`);
      }
    }
  }
  await writeFile(PID_FILE, String(process.pid));

  // Post-lock: if a stale socket file exists (e.g. broker died without a lockfile —
  // crash during the brief window between lock release and socket cleanup), verify
  // it's not alive and remove it. Without this, listen() below gets EADDRINUSE.
  if (existsSync(SOCK)) {
    try {
      const probe = await connect(SOCK, { timeoutMs: 500 });
      probe.destroy();
      await log('fatal', `another broker is already serving ${SOCK} (post-lock check)`);
      await unlink(LOCK_FILE).catch(() => {});
      await unlink(PID_FILE).catch(() => {});
      process.exit(2);
    } catch {
      await unlink(SOCK).catch(() => {});
    }
  }

  const registry = new Registry();
  await registry.load();

  const clients = new Set();
  const broadcastPhase = () => registry.save().catch((e) => log('save-error', e.message));

  const messageToSession = new Map();
  const messageToAsk = new Map();

  const sessionMeta = new Map();
  function markCancelled(id, reason) {
    registry.cancelled.set(id, { reason, at: Date.now() });
    registry.save().catch((e) => log('save-error', e.message));
  }

  function clearCancelled(id) {
    if (registry.cancelled.has(id)) {
      registry.cancelled.delete(id);
      registry.save().catch((e) => log('save-error', e.message));
    }
  }

  function assertLive(id) {
    const c = registry.cancelled.get(id);
    if (c) {
      const err = new Error(`session ${id} was cancelled (${c.reason ?? 'user'})`);
      err.cancelled = true;
      throw err;
    }
  }

  function touch(session) {
    let meta = sessionMeta.get(session.id);
    if (!meta) {
      meta = { pendingAsks: [], postedMessageIds: new Set() };
      sessionMeta.set(session.id, meta);
    }
    return meta;
  }

  function resolveAsk(session, { reply, source }, targetAskId) {
    const meta = touch(session);
    let ask;
    if (targetAskId) {
      const idx = meta.pendingAsks.findIndex((a) => a.askId === targetAskId);
      if (idx < 0) return false;
      ask = meta.pendingAsks.splice(idx, 1)[0];
    } else {
      ask = meta.pendingAsks.shift();
    }
    if (!ask) return false;
    clearTimeout(ask.timer);
    for (const mid of ask.messageIds ?? []) messageToAsk.delete(mid);
    ask.respond({ ok: true, result: { reply, source } });
    return true;
  }

  async function announceSession(session, verb) {
    const color = colorOf(session);
    const text = verb === 'open'
      ? `${color} 🟢 ccx session opened\n${formatSessionLine(session)}`
      : `${color} 🔴 ccx session closed \`#${session.id}\` — ${verb}`;
    try {
      const ids = await adapter.sendTo(session.channelId, text);
      for (const id of ids) messageToSession.set(id, session.id);
    } catch (err) {
      log('announce-error', err.message);
    }
  }

  async function cancelSession(sessionId, reason) {
    const session = registry.get(sessionId);
    if (!session) return false;
    const meta = sessionMeta.get(sessionId);
    if (meta) {
      while (meta.pendingAsks.length) {
        const ask = meta.pendingAsks.shift();
        clearTimeout(ask.timer);
        ask.respond({ ok: false, error: `session ${sessionId} was cancelled (${reason ?? 'user'})` });
      }
      sessionMeta.delete(sessionId);
    }
    supervisor?.dropSession(sessionId);
    markCancelled(sessionId, reason);
    registry.close(sessionId);
    await registry.save();
    await announceSession(session, `cancelled (${reason})`);
    return true;
  }

  async function onChatMessage({ channelId, userId: _userId, text, replyToMessageId, reply }) {
    if (!text) return;
    let targetSessionId = null;
    let targetAskId = null;
    let source = 'auto';

    // 1. Reply-to-message routing (also matches the specific pending ask)
    if (replyToMessageId) {
      const askRef = messageToAsk.get(replyToMessageId);
      if (askRef) {
        targetSessionId = askRef.sessionId;
        targetAskId = askRef.askId;
        source = 'reply';
      } else if (messageToSession.has(replyToMessageId)) {
        targetSessionId = messageToSession.get(replyToMessageId);
        source = 'reply';
      }
    }

    // 2. Explicit #id prefix
    if (!targetSessionId) {
      const m = text.match(/^#([a-f0-9]{2,8})\s+([\s\S]+)$/i);
      if (m) {
        targetSessionId = m[1].toLowerCase();
        text = m[2];
        source = 'prefix';
      }
    }

    // 3. Focus
    if (!targetSessionId) {
      const focus = registry.getFocus(channelId);
      if (focus && registry.get(focus)) {
        targetSessionId = focus;
        source = 'focus';
      }
    }

    // 4. Single-active fallback
    if (!targetSessionId) {
      const active = registry.listForChannel(channelId);
      if (active.length === 1) {
        targetSessionId = active[0].id;
        source = 'only-active';
      } else if (active.length === 0) {
        await reply('No active ccx sessions. Start one with `/ccx:loop` to connect.');
        return;
      } else {
        const lines = active.map(formatSessionLine).join('\n');
        await reply(
          `Which session? ${active.length} active — reply to a session message, prefix with \`#<id>\`, or \`!ccx focus <id>\`.\n${lines}`,
        );
        return;
      }
    }

    const session = registry.get(targetSessionId);
    if (!session) {
      await reply(`Unknown session \`#${targetSessionId}\`. Use \`!ccx sessions\` to list.`);
      return;
    }

    // Channel ownership: reject cross-channel replies
    if (session.channelId !== channelId) {
      await reply(`Session \`#${targetSessionId}\` belongs to a different channel.`);
      return;
    }

    const delivered = resolveAsk(session, { reply: text, source }, targetAskId);
    if (!delivered) {
      await reply(`\`#${session.id}\` has no pending question right now; stored for context only.`);
    }
  }

  async function onChatCommand({ channelId, command, args, reply }) {
    switch (command) {
      case 'sessions':
      case 'ls': {
        const list = registry.listForChannel(channelId);
        if (!list.length) {
          await reply('No active ccx sessions for this channel.');
          return;
        }
        const focus = registry.getFocus(channelId);
        const header = focus ? `Focus: \`#${focus}\`\n` : '';
        await reply(`${header}${list.map(formatSessionLine).join('\n')}`);
        return;
      }
      case 'cancel': {
        const id = parseIdFromToken(args[0]);
        if (!id) {
          await reply('Usage: `!ccx cancel <id>`');
          return;
        }
        const target = registry.get(id);
        if (!target) {
          await reply(`Unknown session \`#${id}\`.`);
          return;
        }
        if (target.channelId !== channelId) {
          await reply(`Session \`#${id}\` belongs to a different channel.`);
          return;
        }
        const ok = await cancelSession(id, 'user');
        await reply(ok ? `Cancelled \`#${id}\`.` : `Failed to cancel \`#${id}\`.`);
        return;
      }
      case 'focus': {
        if (!args[0] || args[0] === 'off' || args[0] === 'clear') {
          registry.setFocus(channelId, null);
          await registry.save();
          await reply('Focus cleared.');
          return;
        }
        const id = parseIdFromToken(args[0]);
        const focusTarget = id ? registry.get(id) : null;
        if (!focusTarget) {
          await reply(`Unknown session \`#${args[0]}\`.`);
          return;
        }
        if (focusTarget.channelId !== channelId) {
          await reply(`Session \`#${id}\` belongs to a different channel.`);
          return;
        }
        registry.setFocus(channelId, id);
        await registry.save();
        await reply(`Focus set to \`#${id}\`.`);
        return;
      }
      case 'help':
      default: {
        await reply(
          [
            '`!ccx sessions` — list active sessions',
            '`!ccx focus <id>` / `!ccx focus off` — route plain messages to a session',
            '`!ccx cancel <id>` — cancel a session\'s pending question',
            'Reply to a session message to answer it directly, or prefix text with `#<id>`.',
          ].join('\n'),
        );
      }
    }
  }

  // `adapter` is the outward-facing sender used for register/close/send/smoketest
  // announcements (it may be the SupervisorAdapter, which delegates to the
  // fallback). `fallbackAdapter` is always the Discord adapter — the `ask` op
  // uses it directly for escalated / Discord-mode posts. `supervisor` is the
  // SupervisorAdapter instance when backend === "supervisor"; null otherwise.
  let adapter = null;
  let fallbackAdapter = null;
  let supervisor = null;

  const ops = {
    async ping() {
      return { ready: discordReady };
    },
    async waitReady() {
      await discordReadyPromise;
      return {};
    },
    async register({ label, cwd, branch, channelId }) {
      const targetChannel = channelId ?? config.discord.channelId;
      const color = pickColor(targetChannel, registry);
      const session = registry.register({
        label,
        cwd,
        branch,
        channelId: targetChannel,
        color,
      }, { exclude: registry.cancelled });
      await registry.save();
      try {
        const text = `${colorOf(session)} 🟢 ccx session opened\n${formatSessionLine(session)}`;
        const ids = await adapter.sendTo(session.channelId, text);
        for (const id of ids) messageToSession.set(id, session.id);
      } catch (err) {
        registry.close(session.id);
        await registry.save();
        throw err;
      }
      return { sessionId: session.id, label: session.label };
    },
    async send({ sessionId, text }, _client) {
      assertLive(sessionId);
      const session = registry.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const color = colorOf(session);
      const prefix = session.branch
        ? `${color} \`#${session.id}\` \`${session.branch}\``
        : `${color} \`#${session.id}\``;
      const ids = await adapter.sendTo(session.channelId, `${prefix} ${text}`);
      for (const id of ids) messageToSession.set(id, session.id);
      return { messageIds: ids };
    },
    async ask({ sessionId, prompt, timeoutSec }, client, reqId, respond) {
      assertLive(sessionId);
      const session = registry.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      const meta = touch(session);
      const timeout = Math.min(
        MAX_ASK_TIMEOUT_SEC,
        Math.max(10, timeoutSec ?? config.ask?.defaultTimeoutSec ?? DEFAULT_ASK_TIMEOUT_SEC),
      );
      const askId = `${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

      const startOuterTimer = (initialMessageIds) => {
        const pending = { askId, respond, timer: null, messageIds: initialMessageIds };
        pending.timer = setTimeout(() => {
          const idx = meta.pendingAsks.findIndex((a) => a.askId === askId);
          if (idx >= 0) {
            const removed = meta.pendingAsks.splice(idx, 1)[0];
            for (const mid of removed.messageIds ?? []) messageToAsk.delete(mid);
            supervisor?.dropAsk(askId);
            respond({ ok: true, result: { reply: null, source: 'timeout' } });
          }
        }, timeout * 1000);
        meta.pendingAsks.push(pending);
        return pending;
      };

      // `pendingRef` is provided in supervisor mode (the ask already lives in
      // meta.pendingAsks; attach messageIds + routing atomically after send).
      // In Discord-only mode it is omitted — the caller creates the pending
      // entry right after this returns, with the ids as its initial
      // messageIds, so there is no pre-existing entry to update.
      const postToFallback = async (tag, pendingRef) => {
        const header = tag
          ? `${colorOf(session)} ❓ \`#${session.id}\` ${tag} ${prompt}`
          : `${colorOf(session)} ❓ \`#${session.id}\` ${prompt}`;
        const ids = await fallbackAdapter.sendTo(
          session.channelId,
          `${header}\n_Reply to this message (timeout ${timeout}s)._`,
        );
        // Single synchronous block from here: set messageIds on the pending
        // entry (supervisor mode) and populate the global routing maps so a
        // concurrent resolve/timeout/cancel path sees a consistent view. If
        // the ask was already resolved while the send was in flight (outer
        // timer fired, session cancelled), skip routing-map population —
        // otherwise messageToAsk would hold entries that no cleanup path
        // removes, and later Discord replies to the escalated message would
        // land on a non-existent ask and surface the confusing "no pending
        // question right now" message.
        if (pendingRef) {
          const stillPending = meta.pendingAsks.some((a) => a.askId === askId);
          if (!stillPending) return ids;
          pendingRef.messageIds = ids;
        }
        for (const id of ids) {
          messageToSession.set(id, session.id);
          messageToAsk.set(id, { sessionId, askId });
        }
        return ids;
      };

      if (supervisor) {
        // Supervisor mode: register the pending ask immediately (outer timer
        // covers the whole wait, including any later escalation to Discord),
        // then hand the ask to the supervisor adapter. Supervisor must call
        // supervisorReply / supervisorEscalate / supervisorClose, or the
        // adapter's auto-timer fires and escalates to Discord anyway.
        const pending = startOuterTimer([]);
        const registerWithSupervisor = () => {
          supervisor.enqueue({
            askId,
            sessionId,
            channelId: session.channelId,
            prompt,
            timeoutSec: timeout,
            onReply: ({ reply, source }) => {
              resolveAsk(session, { reply, source }, askId);
            },
            onEscalate: ({ auto }) => {
              const tag = auto ? '⏲️ auto-escalated' : '↗️ escalated';
              postToFallback(tag, pending)
                .catch((err) => {
                  log('supervisor-escalate-error', err.message);
                  // Fallback send failed (e.g. Discord flaky). Don't silently
                  // drop the ask: re-enqueue so supervisor.poll still surfaces
                  // it and the supervisor can retry escalate / close / reply.
                  // Guard against re-enqueueing after the outer timer already
                  // fired — that would leave a ghost entry with no receiver.
                  const stillPending = meta.pendingAsks.some((a) => a.askId === askId);
                  if (!stillPending) return;
                  try {
                    registerWithSupervisor();
                  } catch (e) {
                    log('supervisor-reenqueue-error', e.message);
                  }
                });
            },
          });
        };
        registerWithSupervisor();
        // Pending registered; outer timer running. `pending` is referenced so
        // linters/compilers see it used.
        void pending;
      } else {
        // Discord-only mode: preserve the original semantics where the outer
        // timer starts AFTER a successful sendTo. If sendTo throws, nothing
        // is registered and the caller gets an `ok: false, error`.
        const ids = await postToFallback();
        startOuterTimer(ids);
      }
      return undefined;
    },
    async setPhase({ sessionId, phase }) {
      assertLive(sessionId);
      const session = registry.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      session.phase = phase;
      broadcastPhase();
      return {};
    },
    async close({ sessionId, status }) {
      const session = registry.get(sessionId);
      if (!session) {
        // Session may have been removed by cancelSession — clear the
        // cancelled marker so later createId can reuse the ID.
        if (registry.cancelled.has(sessionId)) {
          clearCancelled(sessionId);
          return { ok: true };
        }
        return { ok: false };
      }
      const meta = sessionMeta.get(sessionId);
      if (meta) {
        while (meta.pendingAsks.length) {
          const ask = meta.pendingAsks.shift();
          clearTimeout(ask.timer);
          ask.respond({ ok: true, result: { reply: null, source: 'closed' } });
        }
        sessionMeta.delete(sessionId);
      }
      supervisor?.dropSession(sessionId);
      registry.close(sessionId);
      clearCancelled(sessionId);
      await registry.save();
      await announceSession({ ...session, id: session.id }, status ?? 'closed');
      return { ok: true };
    },
    async supervisorPoll() {
      if (!supervisor) throw new Error('broker is not in supervisor mode');
      return { asks: supervisor.poll() };
    },
    async supervisorReply({ askId, reply }) {
      if (!supervisor) throw new Error('broker is not in supervisor mode');
      if (!askId) throw new Error('supervisorReply: askId is required');
      return { ok: supervisor.reply(askId, reply) };
    },
    async supervisorEscalate({ askId }) {
      if (!supervisor) throw new Error('broker is not in supervisor mode');
      if (!askId) throw new Error('supervisorEscalate: askId is required');
      return { ok: supervisor.escalate(askId) };
    },
    async supervisorClose({ askId }) {
      if (!supervisor) throw new Error('broker is not in supervisor mode');
      if (!askId) throw new Error('supervisorClose: askId is required');
      return { ok: supervisor.close(askId) };
    },
    async smoketest({ text } = {}) {
      const ids = await adapter.send(text ?? '✅ ccx-chat smoke test — Discord bridge is live.');
      return { messageIds: ids };
    },
    async list() {
      return { sessions: registry.list().map((s) => ({
        id: s.id,
        label: s.label,
        branch: s.branch,
        phase: s.phase,
        createdAt: s.createdAt,
      })) };
    },
  };

  // --- IPC socket: bind BEFORE Discord login ---
  // This guarantees that if listen() fails (EADDRINUSE), we exit before creating
  // a Discord client, avoiding duplicate bot logins and bogus recovery messages.
  let discordReady = false;
  let discordReadyResolve;
  const discordReadyPromise = new Promise((r) => { discordReadyResolve = r; });
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('data', framer(async (msg) => {
      const { op, reqId, params } = msg;
      const handler = ops[op];
      const respond = (payload) => {
        if (socket.destroyed) return;
        writeJson(socket, { reqId, ...payload });
      };
      if (!handler) {
        respond({ ok: false, error: `unknown op: ${op}` });
        return;
      }
      if (!discordReady && op !== 'ping' && op !== 'waitReady') {
        respond({ ok: false, error: 'broker is starting — Discord not yet connected' });
        return;
      }
      try {
        const result = await handler(params ?? {}, socket, reqId, respond);
        if (result !== undefined) respond({ ok: true, result });
      } catch (err) {
        log('op-error', { op, err: err.message });
        respond({ ok: false, error: err.message });
      }
    }));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', (err) => log('socket-error', err.message));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCK, resolve);
  }).catch(async (err) => {
    if (err.code === 'EADDRINUSE') {
      await log('fatal', `peer broker acquired ${SOCK} during startup; exiting`);
      await unlink(LOCK_FILE).catch(() => {});
      await unlink(PID_FILE).catch(() => {});
      process.exit(2);
    }
    throw err;
  });
  await log('listen', SOCK);

  // --- Discord: login only after socket is ours ---
  fallbackAdapter = new DiscordAdapter({
    config: config.discord,
    log: (k, e) => log(`discord-${k}`, e?.message ?? e),
    onMessage: (m) => onChatMessage(m).catch((e) => log('onMessage', e.message)),
    onCommand: (c) => onChatCommand(c).catch((e) => log('onCommand', e.message)),
  });
  await fallbackAdapter.start();

  if (config.backend === 'supervisor') {
    supervisor = new SupervisorAdapter({
      fallback: fallbackAdapter,
      log: (k, e) => log(k, e?.message ?? e),
      autoEscalateAfterSec: config.supervisor?.autoEscalateAfterSec,
    });
    await supervisor.start();
    // In supervisor mode, announcements (register/close/send/smoketest) still
    // go to Discord; SupervisorAdapter.sendTo/send delegate to the fallback.
    adapter = supervisor;
  } else {
    adapter = fallbackAdapter;
  }

  discordReady = true;
  discordReadyResolve();
  await log('ready', `broker up, backend=${config.backend}, pid=${process.pid}`);

  if (registry.list().length) {
    const lines = registry.list().map(formatSessionLine).join('\n');
    try {
      await adapter.send(`♻️ ccx broker restarted. ${registry.list().length} session(s) recovered (pending questions abandoned):\n${lines}`);
    } catch (err) {
      log('recovery-notice-error', err.message);
    }
  }

  const shutdown = async (signal) => {
    log('shutdown', signal).catch(() => {});
    try {
      server.close();
      if (supervisor) await supervisor.stop().catch(() => {});
      if (fallbackAdapter) await fallbackAdapter.stop().catch(() => {});
      await unlink(SOCK).catch(() => {});
      await unlink(PID_FILE).catch(() => {});
      await unlink(LOCK_FILE).catch(() => {});
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  await log('fatal', err.stack ?? err.message);
  process.exit(1);
});
