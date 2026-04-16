import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

const DISCORD_MAX = 2000;

function chunk(text) {
  const out = [];
  let rest = text ?? '';
  while (rest.length > DISCORD_MAX) {
    let cut = rest.lastIndexOf('\n', DISCORD_MAX);
    if (cut < DISCORD_MAX - 400) cut = DISCORD_MAX;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out;
}

export class DiscordAdapter {
  constructor({ config, log, onMessage, onCommand }) {
    this.config = config;
    this.log = log ?? (() => {});
    this.onMessage = onMessage;
    this.onCommand = onCommand;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  async start() {
    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg).catch((err) => this.log('msg-error', err)));
    await this.client.login(this.config.token);
    await new Promise((resolve) => {
      if (this.client.isReady()) resolve();
      else this.client.once(Events.ClientReady, resolve);
    });
  }

  async stop() {
    await this.client.destroy();
  }

  allowed(userId) {
    const list = this.config.allowedUserIds;
    if (!Array.isArray(list) || list.length === 0) return false;
    return list.includes(userId);
  }

  async handleMessage(msg) {
    if (msg.author.bot) return;
    if (msg.channelId !== this.config.channelId) return;
    if (!this.allowed(msg.author.id)) return;

    const prefix = this.config.commandPrefix ?? '!ccx';
    const content = msg.content?.trim() ?? '';

    if (content.startsWith(prefix)) {
      const rest = content.slice(prefix.length).trim();
      const [cmd, ...args] = rest.split(/\s+/);
      await this.onCommand({
        channelId: msg.channelId,
        userId: msg.author.id,
        command: (cmd ?? '').toLowerCase(),
        args,
        reply: (text) => this.sendTo(msg.channelId, text),
      });
      return;
    }

    let replyToMessageId = null;
    if (msg.reference?.messageId) replyToMessageId = msg.reference.messageId;

    await this.onMessage({
      channelId: msg.channelId,
      userId: msg.author.id,
      text: content,
      replyToMessageId,
      reply: (text) => this.sendTo(msg.channelId, text),
    });
  }

  async sendTo(channelId, text) {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`channel ${channelId} is not text-based`);
    const parts = chunk(text);
    const ids = [];
    for (const p of parts) {
      const sent = await channel.send(p);
      ids.push(sent.id);
    }
    return ids;
  }

  async send(text) {
    return this.sendTo(this.config.channelId, text);
  }
}
