// SupervisorAdapter — routes worker chat_ask calls through an intermediate
// "supervisor session" that can answer autonomously, escalate to a fallback
// (currently Discord), or close with no reply.
//
// M2 scope (see docs/supervisor-design.md §8.1, §13):
//   - Plumbing only: asks queue in this adapter until the supervisor session
//     polls and calls reply / escalate / close. Autonomous-answer logic lives
//     in /ccx:supervisor (M3); this adapter is transport-only.
//   - If the supervisor session never acts, an auto-escalate timer forwards
//     the ask to the fallback adapter so a worker dispatched from a dead
//     supervisor still reaches a human via Discord.
//
// The adapter does NOT itself send Discord messages. Message composition and
// the send-to-fallback side-effect stay in broker.mjs so the onReply/onEscalate
// callbacks can share the existing pendingAsks bookkeeping (messageIds,
// messageToAsk map, timers). Keeping that split means the Discord reply path
// (onChatMessage → resolveAsk) works unchanged whether the ask arrived
// directly or via escalation.

export const DEFAULT_AUTO_ESCALATE_SEC = 60;
const MIN_AUTO_ESCALATE_SEC = 5;
const MAX_AUTO_ESCALATE_SEC = 3600;

export class SupervisorAdapter {
  constructor({ fallback, log, autoEscalateAfterSec } = {}) {
    if (!fallback) {
      throw new Error('SupervisorAdapter requires a fallback adapter');
    }
    this.fallback = fallback;
    this.log = log ?? (() => {});
    const raw = autoEscalateAfterSec ?? DEFAULT_AUTO_ESCALATE_SEC;
    this.autoEscalateAfterSec = Math.min(
      MAX_AUTO_ESCALATE_SEC,
      Math.max(MIN_AUTO_ESCALATE_SEC, raw),
    );
    // askId -> { sessionId, channelId, prompt, timeoutSec, receivedAt,
    //            onReply, onEscalate, autoTimer }
    this.asks = new Map();
  }

  async start() {
    // The fallback is started by the broker directly; nothing else to do here.
  }

  async stop() {
    for (const entry of this.asks.values()) {
      clearTimeout(entry.autoTimer);
    }
    this.asks.clear();
  }

  // Passthrough for announcement traffic: chat_send, session open/close
  // banners, etc. always land on the fallback (Discord) so humans can watch.
  async sendTo(channelId, text) {
    return this.fallback.sendTo(channelId, text);
  }

  async send(text) {
    return this.fallback.send(text);
  }

  // Queue a chat_ask for the supervisor session to handle. The broker supplies
  // two callbacks:
  //   onReply({ reply, source })  — supervisor answered directly
  //   onEscalate({ auto })        — supervisor (or the auto-timer) forwarded
  //                                 the ask to the fallback adapter. The broker
  //                                 does the actual Discord post inside the
  //                                 callback so it can update its
  //                                 messageIds / messageToAsk bookkeeping.
  enqueue({ askId, sessionId, channelId, prompt, timeoutSec, onReply, onEscalate }) {
    if (!askId) throw new Error('enqueue: askId required');
    if (!sessionId) throw new Error('enqueue: sessionId required');
    if (typeof onReply !== 'function') throw new Error('enqueue: onReply must be a function');
    if (typeof onEscalate !== 'function') throw new Error('enqueue: onEscalate must be a function');
    if (this.asks.has(askId)) {
      throw new Error(`enqueue: duplicate askId ${askId}`);
    }

    const entry = {
      askId,
      sessionId,
      channelId: channelId ?? null,
      prompt: prompt ?? '',
      timeoutSec: timeoutSec ?? null,
      receivedAt: Date.now(),
      onReply,
      onEscalate,
      autoTimer: null,
    };
    // Clamp the auto-escalate delay so it always fires before the worker's
    // own chat_ask timeout. Without this, a worker calling
    // `chat_ask({ timeoutSec: 30 })` with `supervisor.autoEscalateAfterSec:
    // 60` would see the outer timer fire first, returning source: "timeout",
    // and the ask would never reach Discord at all — silently breaking the
    // human-fallback path that supervisor mode is supposed to guarantee.
    // Leave a small buffer (2s) so Discord.sendTo has a chance to land
    // before the outer timer would fire.
    const outerLimit = typeof timeoutSec === 'number' && Number.isFinite(timeoutSec) && timeoutSec > 0
      ? Math.max(1, Math.floor(timeoutSec) - 2)
      : Infinity;
    const delaySec = Math.min(this.autoEscalateAfterSec, outerLimit);
    entry.autoEscalateDelaySec = delaySec;
    entry.autoTimer = setTimeout(() => {
      const current = this.asks.get(askId);
      if (!current) return;
      this.asks.delete(askId);
      try {
        this.log('supervisor-auto-escalate', { askId, sessionId, ageSec: delaySec });
      } catch {
        /* swallow — logging must never break routing */
      }
      current.onEscalate({ auto: true });
    }, delaySec * 1000);
    this.asks.set(askId, entry);
  }

  // Non-blocking listing of everything the supervisor still needs to answer.
  poll() {
    const now = Date.now();
    return [...this.asks.values()].map((e) => ({
      askId: e.askId,
      sessionId: e.sessionId,
      prompt: e.prompt,
      timeoutSec: e.timeoutSec,
      receivedAt: new Date(e.receivedAt).toISOString(),
      ageSec: Math.max(0, Math.floor((now - e.receivedAt) / 1000)),
    }));
  }

  // Supervisor → worker, direct answer. Returns true if the ask was still
  // pending; false if it was already resolved / cancelled / escalated.
  reply(askId, reply) {
    const entry = this.asks.get(askId);
    if (!entry) return false;
    this.asks.delete(askId);
    clearTimeout(entry.autoTimer);
    entry.onReply({ reply: reply ?? null, source: 'supervisor-auto' });
    return true;
  }

  // Supervisor → fallback, forward the ask. Returns true if still pending.
  escalate(askId) {
    const entry = this.asks.get(askId);
    if (!entry) return false;
    this.asks.delete(askId);
    clearTimeout(entry.autoTimer);
    entry.onEscalate({ auto: false });
    return true;
  }

  // Supervisor declines to answer. Worker sees source: "closed" and its
  // chat_ask failure path kicks in (AskUserQuestion fallback etc.).
  close(askId) {
    const entry = this.asks.get(askId);
    if (!entry) return false;
    this.asks.delete(askId);
    clearTimeout(entry.autoTimer);
    entry.onReply({ reply: null, source: 'closed' });
    return true;
  }

  // Broker-internal: clear any pending supervisor asks for a session being
  // cancelled or closed. The outer broker is responsible for resolving the
  // worker-facing pendingAsks entry with its own error/closed payload; this
  // only drops our adapter-side state so the auto-escalate timer cannot fire
  // after the session is gone.
  dropSession(sessionId) {
    let dropped = 0;
    for (const [askId, entry] of this.asks) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.autoTimer);
        this.asks.delete(askId);
        dropped += 1;
      }
    }
    return dropped;
  }

  // Broker-internal: the worker-side outer timer fired (timeoutSec elapsed).
  // Drop our pending entry silently — the broker already resolved the ask
  // with source: "timeout".
  dropAsk(askId) {
    const entry = this.asks.get(askId);
    if (!entry) return false;
    clearTimeout(entry.autoTimer);
    this.asks.delete(askId);
    return true;
  }
}
