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
  }

  async ensure() {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.#connectOrSpawn()
      .then(() => this.#waitForReady())
      .finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #waitForReady() {
    const result = await this.#rawCall('waitReady', {}, { timeoutMs: 30000 });
    if (!result) throw new Error('broker did not become ready');
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
];

const server = new Server(
  { name: 'ccx-chat', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const op = {
    chat_register: 'register',
    chat_send: 'send',
    chat_ask: 'ask',
    chat_set_phase: 'setPhase',
    chat_close: 'close',
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
