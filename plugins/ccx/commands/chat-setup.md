---
description: "Install and configure the ccx-chat Discord bridge (two-way chat for ccx loop sessions)"
argument-hint: ""
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# /ccx:chat-setup — Install & configure the Discord chat bridge

One-time setup for the optional `ccx-chat` MCP server. After this completes, `/ccx:loop --chat` and `/ccx:forever --chat` route progress and questions to a Discord channel, and user replies unblock the loop.

## What this does

1. Runs `npm install` inside `${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat` to fetch `discord.js` and the MCP SDK.
2. Ensures `~/.claude/ccx-chat/` exists.
3. Prompts for the Discord bot token, channel ID, and allowed Discord user ID, and writes them to `~/.claude/ccx-chat/config.json`.
4. Smoke-tests the broker by sending a real message to the configured Discord channel.
5. Registers the `ccx-chat` MCP server **in the user scope** (`claude mcp add --scope user`). The plugin deliberately does NOT ship a `.mcp.json` so that users who never opt into `--chat` are not forced to install Node dependencies or create a Discord config — the MCP entry only exists after this setup succeeds.

## Prerequisites

Before running this setup, the Discord bot must have the **Message Content** privileged intent enabled:
1. Go to https://discord.com/developers/applications → your application → **Bot**.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
3. Save.

Without this intent, the bot can send messages but **cannot read reply content** from users, so `chat_ask` will receive empty strings and the loop will fall back to `AskUserQuestion` every time.

## Rules

- If `~/.claude/ccx-chat/config.json` already exists, ask before overwriting — treat the existing config as authoritative unless the user says otherwise.
- Never log or echo the bot token after writing it. Mask it in any confirmation.
- The allowed-user list must contain at least one ID; otherwise any Discord user in the channel could drive the loop. If the user declines to provide one, refuse to write the config.

## Setup steps

### 1. Install deps

```bash
cd "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat" && npm install --omit=dev --no-audit --no-fund
```

Report the tail of the output. If `npm` is missing, STOP and tell the user to install Node.js ≥18.17.

### 2. Prepare config directory

```bash
mkdir -p ~/.claude/ccx-chat
```

### 3. Collect credentials

If `~/.claude/ccx-chat/config.json` already exists, ask whether to keep or overwrite. On "keep", skip to step 5.

**Security:** the Discord bot token is a secret. Do NOT collect it via `AskUserQuestion` — that would record it in the conversation transcript/history. Instead:

1. Copy the example config to `~/.claude/ccx-chat/config.json` (mode `600`):
   - **Fresh install** (no existing config): `cp "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/config.example.json" ~/.claude/ccx-chat/config.json`
   - **Overwrite** (user chose to replace): same `cp` command — overwrite is intentional.
   ```bash
   cp "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/config.example.json" ~/.claude/ccx-chat/config.json
   chmod 600 ~/.claude/ccx-chat/config.json
   ```
2. Tell the user to edit `~/.claude/ccx-chat/config.json` **manually** (outside Claude) and fill in:
   - `discord.token` — bot token from https://discord.com/developers/applications → Bot → Reset Token.
   - `discord.channelId` — numeric ID (enable Developer Mode in Discord, right-click channel → Copy ID).
   - `discord.allowedUserIds` — array of Discord user ID strings (right-click avatar → Copy User ID).
3. Use `AskUserQuestion` to ask ONLY: "Have you finished editing `~/.claude/ccx-chat/config.json`? (yes/no)". Wait for confirmation before proceeding.
4. After confirmation, read the config file and validate that `token`, `channelId`, and `allowedUserIds` are filled in (not the placeholder values). If any are still placeholders, tell the user and repeat the prompt.

### 5. Smoke-test the broker + Discord channel

The goal is to prove the bot can actually post to the configured channel, not just that the broker process started.

**Before touching any running broker**, check for active sessions and confirm:

1. Test whether a broker is already running by probing the socket.
2. If it is running, use `AskUserQuestion` to warn: "A ccx-chat broker is already running. Restarting it will disconnect any active `--chat` sessions. Proceed?" If the user says no, STOP.
3. Only after confirmation (or if no broker was running), kill it:

```bash
# Only kill via PID if the socket proves the broker is actually running.
# If the socket is dead/missing, the PID file is stale (that PID may belong to
# an unrelated process now) — just clean up the files without sending any signal.
BROKER_LIVE=0
if node -e 'const n=require("net"); const s=n.createConnection(process.argv[1]); s.once("connect",()=>{s.end();process.exit(0)}); s.once("error",()=>process.exit(1));' ~/.claude/ccx-chat/broker.sock 2>/dev/null; then
  BROKER_LIVE=1
fi

if [ "$BROKER_LIVE" = "1" ] && [ -f ~/.claude/ccx-chat/broker.pid ]; then
  OLD_PID=$(cat ~/.claude/ccx-chat/broker.pid 2>/dev/null)
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
fi
rm -f ~/.claude/ccx-chat/broker.pid ~/.claude/ccx-chat/broker.sock ~/.claude/ccx-chat/broker.lock

node "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/broker.mjs" &
BROKER_PID=$!
# Wait (up to 10s) for the broker to accept connections.
for i in $(seq 1 40); do
  if node -e 'const n=require("net"); const s=n.createConnection(process.argv[1]); s.once("connect",()=>{s.end();process.exit(0)}); s.once("error",()=>process.exit(1));' ~/.claude/ccx-chat/broker.sock 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if node "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/smoketest.mjs"; then
  echo "smoketest-ok"
  SMOKE_OK=1
else
  echo "smoketest-failed"
  SMOKE_OK=0
  tail -n 60 ~/.claude/ccx-chat/broker.log 2>/dev/null || true
fi

# Clean up the smoke-test broker — the real run will spawn its own.
kill "$BROKER_PID" 2>/dev/null || true
wait "$BROKER_PID" 2>/dev/null || true
rm -f ~/.claude/ccx-chat/broker.pid ~/.claude/ccx-chat/broker.sock ~/.claude/ccx-chat/broker.lock

test "$SMOKE_OK" = "1"
```

If any ccx sessions were active through the previous broker, they will lose their chat bridge. The setup flow should warn the user if `!ccx sessions` shows active sessions before proceeding — use `AskUserQuestion` to confirm if an existing broker is detected at the start of this step.

The smoke-test script issues a real `send` against the configured Discord channel via the broker. It fails (non-zero exit) when the bot is missing from the server, the channel ID is wrong, the token is invalid, or the bot lacks `Send Messages` on the channel — any of which would otherwise only surface on the first real `/ccx:loop --chat` run.

If the smoke test passes, report success and tell the user:
- Check the channel — they should see the "✅ ccx-chat setup smoke test" message; delete it if desired.
- Run `/ccx:loop --chat <task>` to try it end-to-end.

If the smoke test fails, surface the log tail, DO NOT claim success, and suggest the three most common causes: bot not invited to the server/channel, wrong `channelId`, or missing `Send Messages` permission.

### 6. Register the MCP server (user scope)

Only run this AFTER the smoke test passes — registering a server that can't start would surface an error on every future Claude Code session.

```bash
SERVER="${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/server.mjs"
# If already registered, remove it first so we pick up path changes (plugin re-install moves the path).
claude mcp remove --scope user ccx-chat 2>/dev/null || true
claude mcp add --scope user ccx-chat -- node "$SERVER"
claude mcp list | grep -E '(^| )ccx-chat( |$)' || { echo "mcp-register-failed"; exit 1; }
```

If `claude mcp add` is not available (older CLI), fall back to writing the entry manually:

```bash
node -e '
  const fs = require("node:fs");
  const path = require("node:os").homedir() + "/.claude.json";
  const cur = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  cur.mcpServers = cur.mcpServers || {};
  cur.mcpServers["ccx-chat"] = { command: "node", args: [process.argv[1]] };
  fs.writeFileSync(path, JSON.stringify(cur, null, 2));
' "${CLAUDE_PLUGIN_ROOT}/mcp/ccx-chat/server.mjs"
```

### 7. Cleanup + next steps

```bash
rm -f ~/.claude/ccx-chat/broker.pid
```

Tell the user: **restart Claude Code** (or run `/reload`) so the new `ccx-chat` MCP server is picked up. After that, `/ccx:loop --chat <task>` and `/ccx:forever --chat <task>` will bridge to Discord.
