#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SOCK, CONFIG_FILE, ensureHome } from './paths.mjs';
import { connect, framer, writeJson } from './ipc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROKER = join(HERE, 'broker.mjs');

class BrokerClient {
  constructor() {
    this.sock = null;
    this.pending = new Map();
    this.connecting = null;
    // Set of op names the connected broker understands. Populated by
    // #refreshCapabilities() on every (re)connect. Tools whose backing op
    // is missing must be hidden from the MCP tool list so an upgrade-server-
    // but-not-restart-broker scenario cannot silently break features. Set
    // back to `null` in the socket close handler so a broker restart during
    // the server's lifetime re-probes capabilities instead of reusing the
    // stale set.
    this.capabilities = null;
    // In-flight capabilities probe — used to serialize concurrent ensure()
    // callers. Without this, every tool call arriving before the probe
    // completes would kick off its own parallel probe.
    this.capsRefreshing = null;
  }

  async ensure() {
    if (this.sock && !this.sock.destroyed) {
      // Socket is alive but capabilities may be unknown either because the
      // initial probe returned a transient error (timeout, broker restart
      // mid-call) or because the close handler cleared them and a fresh
      // probe has not yet fired. Lazy-retry on the next ensure() so a
      // transient probe failure does not permanently hide a supported tool
      // for the lifetime of the connection.
      if (!this.capabilities) {
        if (!this.capsRefreshing) {
          this.capsRefreshing = this.#refreshCapabilities()
            .finally(() => { this.capsRefreshing = null; });
        }
        await this.capsRefreshing;
      }
      return;
    }
    if (this.connecting) return this.connecting;
    this.connecting = this.#connectOrSpawn()
      .then(() => this.#waitForReady())
      .then(() => this.#refreshCapabilities())
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #waitForReady() {
    const result = await this.#rawCall('waitReady', {}, { timeoutMs: 30000 });
    if (!result) throw new Error('broker did not become ready');
  }

  async #refreshCapabilities() {
    // A pre-capabilities broker replies with "unknown op: capabilities"; treat
    // that — and ONLY that — as the legacy op set (every op that existed
    // before the capabilities RPC itself was added). Newer ops (like
    // supervisorRecentClosures) are deliberately omitted from the legacy
    // list so a stale detached broker does not get asked for ops it cannot
    // handle. Any OTHER error (timeout, socket dropped mid-probe) leaves
    // capabilities untouched (null) so ensure() can retry on a later call
    // instead of permanently pinning to LEGACY_OPS on a transient hiccup.
    const LEGACY_OPS = new Set([
      'ping', 'waitReady', 'register', 'send', 'ask', 'setPhase', 'close',
      'supervisorPoll', 'supervisorReply', 'supervisorEscalate', 'supervisorClose',
      'smoketest', 'list',
    ]);
    try {
      const result = await this.#rawCall('capabilities', {}, { timeoutMs: 5000 });
      if (result && Array.isArray(result.ops)) {
        this.capabilities = new Set(result.ops);
        return;
      }
      // Broker responded but shape is unexpected — treat as malformed, leave
      // capabilities null so callers advertise the full tool list and later
      // individual tool calls surface broker errors directly.
    } catch (err) {
      const msg = err?.message ?? '';
      if (/unknown op: capabilities/i.test(msg)) {
        this.capabilities = LEGACY_OPS;
        return;
      }
      // Transient probe failure — keep capabilities null so ensure() retries.
    }
  }

  async #connectOrSpawn() {
    await ensureHome();
    if (!existsSync(CONFIG_FILE)) {
      throw new Error(
        `ccx-chat config missing at ${CONFIG_FILE}. Copy config.example.json there and fill the Discord token/channel.`,
      );
    }
    try {
      this.sock = await connect(SOCK, { timeoutMs: 1500 });
      this.#attach();
      return;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED') throw err;
    }
    this.#spawnBroker();
    this.sock = await this.#connectUntilLive(8000);
    this.#attach();
  }

  async #connectUntilLive(timeoutMs) {
    const start = Date.now();
    let lastErr;
    while (Date.now() - start < timeoutMs) {
      try {
        return await connect(SOCK, { timeoutMs: 800 });
      } catch (err) {
        lastErr = err;
        if (err.code !== 'ENOENT' && err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
          throw err;
        }
        await delay(150);
      }
    }
    throw new Error(`broker did not accept connections in ${timeoutMs}ms: ${lastErr?.message ?? lastErr}`);
  }

  #spawnBroker() {
    const child = spawn(process.execPath, [BROKER], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }

  #attach() {
    this.sock.on('data', framer((msg) => {
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'broker error'));
    }));
    this.sock.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('broker connection closed'));
      this.pending.clear();
      this.sock = null;
      // Clear cached capabilities so a restarted broker (e.g. the user just
      // followed the "restart the broker" hint) gets a fresh probe on the
      // next ensure(). Without this, ListTools would keep filtering against
      // the previous broker's op set even though a newer broker is now live.
      this.capabilities = null;
    });
    this.sock.on('error', () => { /* handled via close */ });
  }

  #rawCall(op, params, { timeoutMs = 0 } = {}) {
    const reqId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(reqId);
            reject(new Error(`ipc ${op} timeout`));
          }, timeoutMs)
        : null;
      this.pending.set(reqId, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      writeJson(this.sock, { op, reqId, params });
    });
  }

  async call(op, params, opts) {
    await this.ensure();
    return this.#rawCall(op, params, opts);
  }
}

const broker = new BrokerClient();

// Fire-and-forget warmup at module load. The MCP server's listTools handler
// is intentionally non-blocking so the StdioServerTransport handshake is not
// delayed by broker connect + Discord login (the earlier blocking version
// could stall MCP clients for up to ~30s). Kicking off ensure() in the
// background gives capabilities a chance to populate before the first
// listTools arrives; when it does, listTools filters tools against the real
// broker's op set. If listTools races ahead of the warmup, the handler falls
// back to advertising the full list and the call-time capability check still
// catches unsupported ops (see CallToolRequestSchema), which in turn is
// translated by supervisor.md §P2.5 into an M5_DISABLED degradation.
broker.ensure().catch(() => { /* errors surface on actual tool use */ });

const TOOLS = [
  {
    name: 'chat_register',
    description: 'Register a new ccx session with the chat broker. Returns a sessionId used for subsequent chat.* calls.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short label — typically the task description.' },
        cwd: { type: 'string', description: 'Absolute working directory.' },
        branch: { type: 'string', description: 'Git branch name.' },
      },
      required: ['label'],
    },
  },
  {
    name: 'chat_send',
    description: 'Send a one-way message to the chat channel for this session (cycle summary, status, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'chat_ask',
    description: 'Post a question to the chat channel and BLOCK until the user replies (or timeout / cancel). Returns { reply, source }. source may be "reply", "prefix", "focus", "only-active", "timeout", "cancel", or "closed". If source is timeout/cancel/closed, reply is null — fall back to AskUserQuestion.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        prompt: { type: 'string' },
        timeoutSec: { type: 'number', description: 'Max seconds to wait for a reply (default 900, max 86400).' },
      },
      required: ['sessionId', 'prompt'],
    },
  },
  {
    name: 'chat_set_phase',
    description: 'Update the session\'s phase label shown in /sessions (e.g. "implement", "review 2/3", "commit").',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        phase: { type: 'string' },
      },
      required: ['sessionId', 'phase'],
    },
  },
  {
    name: 'chat_close',
    description: 'Close the session and announce its final status in the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        status: { type: 'string', description: 'approved | stuck | cap-hit | aborted | error | closed' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'chat_supervisor_poll',
    description: 'Supervisor-only. List chat_ask calls queued for supervisor handling. Returns { asks: [{ askId, sessionId, prompt, timeoutSec, receivedAt, ageSec }] }. Errors if the broker is not in supervisor mode.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'chat_supervisor_reply',
    description: 'Supervisor-only. Answer a pending chat_ask directly (worker receives { reply, source: "supervisor-auto" }). Returns { ok: true } if the ask was still pending.',
    inputSchema: {
      type: 'object',
      properties: {
        askId: { type: 'string' },
        reply: { type: 'string' },
      },
      required: ['askId', 'reply'],
    },
  },
  {
    name: 'chat_supervisor_escalate',
    description: 'Supervisor-only. Forward a pending chat_ask to the fallback (Discord) — a human answers on Discord and the reply flows back to the worker. Returns { ok: true } if the ask was still pending.',
    inputSchema: {
      type: 'object',
      properties: {
        askId: { type: 'string' },
      },
      required: ['askId'],
    },
  },
  {
    name: 'chat_supervisor_close',
    description: 'Supervisor-only. Decline a pending chat_ask — worker receives { reply: null, source: "closed" } and its chat_ask failure path runs (falls back to AskUserQuestion).',
    inputSchema: {
      type: 'object',
      properties: {
        askId: { type: 'string' },
      },
      required: ['askId'],
    },
  },
  {
    name: 'chat_supervisor_recent_closures',
    description: 'Supervisor-only. Return the broker\'s in-memory ring buffer of recent chat_close events, filtered and bounded to avoid MCP output blowups. Each entry: { sessionId, cwd, branch, label, status, at }. The supervisor uses this to distinguish stuck / cap-hit / filtered-clean / aborted exits after a worker session terminates, since registry.close() removes the session itself. All parameters are optional; pass (cwd, branch, since) matching the supervisor\'s scope and (limit) no larger than needed. Errors if the broker is not in supervisor mode.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Exact-equality filter on closure.cwd. Use meta.worktree_path to scope to this supervisor\'s repo.' },
        branch: { type: 'string', description: 'Exact-equality filter on closure.branch. Use "ccx/<task_id>".' },
        since: { type: 'string', description: 'ISO 8601 UTC timestamp; only closures with at >= since are returned. Use meta.started_at to reject prior-attempt closures.' },
        limit: { type: 'number', description: 'Max entries to return (clamped to [1, 256], default 64). Entries are returned chronologically; newest matches are preserved when the limit truncates.' },
      },
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: 'ccx-chat', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Map each advertised tool to the broker op it ultimately calls. The
// ListToolsRequestSchema handler uses this to suppress tools whose backing op
// the currently-connected broker does not support (e.g. server was upgraded
// but a stale detached broker from an older install is still holding the
// socket). Without this filter, Claude would advertise the tool to the model
// but every invocation would fail with "unknown op: ...", which is exactly
// the silent degradation the capabilities handshake is designed to avoid.
const TOOL_OP = {
  chat_register: 'register',
  chat_send: 'send',
  chat_ask: 'ask',
  chat_set_phase: 'setPhase',
  chat_close: 'close',
  chat_supervisor_poll: 'supervisorPoll',
  chat_supervisor_reply: 'supervisorReply',
  chat_supervisor_escalate: 'supervisorEscalate',
  chat_supervisor_close: 'supervisorClose',
  chat_supervisor_recent_closures: 'supervisorRecentClosures',
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Intentionally side-effect-free — do NOT trigger broker.ensure() here.
  // listTools is typically called during MCP session init, and a blocking
  // ensure() would spawn the detached broker and await Discord login
  // (≤30s) before the client sees any tools, stalling every plugin
  // consumer even when no chat tool is ever used. Instead, if the broker
  // has already been contacted earlier (so capabilities are cached), filter
  // tools to match; otherwise advertise the full list and defer the
  // capability check to call-time (see CallToolRequestSchema handler).
  const caps = broker.capabilities;
  if (!caps) return { tools: TOOLS };
  const filtered = TOOLS.filter((t) => {
    const op = TOOL_OP[t.name];
    return !op || caps.has(op);
  });
  return { tools: filtered };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const op = {
    chat_register: 'register',
    chat_send: 'send',
    chat_ask: 'ask',
    chat_set_phase: 'setPhase',
    chat_close: 'close',
    chat_supervisor_poll: 'supervisorPoll',
    chat_supervisor_reply: 'supervisorReply',
    chat_supervisor_escalate: 'supervisorEscalate',
    chat_supervisor_close: 'supervisorClose',
    chat_supervisor_recent_closures: 'supervisorRecentClosures',
  }[name];
  if (!op) {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
    };
  }
  try {
    const timeoutMs = name === 'chat_ask'
      ? Math.max(15000, ((args.timeoutSec ?? 86400) + 60) * 1000)
      : 15000;
    // broker.call() runs ensure() internally, which on first call populates
    // broker.capabilities. After that returns, verify the specific op is
    // actually supported by the connected broker — if it is not (upgrade-
    // server-but-stale-broker scenario), produce a clear error telling the
    // user to restart the broker instead of letting the RPC fail with the
    // less-actionable "unknown op: ..." line.
    await broker.ensure();
    if (broker.capabilities && !broker.capabilities.has(op)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `tool ${name} requires a newer ccx-chat broker (op "${op}" is missing). Restart the broker: pkill -f ccx-chat/broker.mjs — it will respawn on the next call.` }],
      };
    }
    const result = await broker.call(op, args, { timeoutMs });
    return {
      content: [{ type: 'text', text: JSON.stringify(result ?? {}) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err.message }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
