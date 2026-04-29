---
name: init-local-chat
description: Wire the local-http channel to an agent group so a non-technical user can chat with NanoClaw from a browser at http://127.0.0.1:3030. Pairs with /add-ollama-provider for a fully local, Ollama-backed setup, but works equally with the default Anthropic API provider. Use after the host has been built and started at least once.
---

# Init Local Chat

Stand up the local browser chat so a non-technical user can talk to a NanoClaw agent from `http://127.0.0.1:3030` without touching the terminal. Idempotent — rerunning is safe.

The channel binds to loopback only; the bind address IS the trust boundary, so there is no auth UI. See `src/channels/local-http.ts` for the adapter.

## Prerequisites

- **`local-http` channel registered.** Check: `grep -c "import './local-http.js';" src/channels/index.ts` — must be ≥ 1. If zero, the channel module is missing; this skill cannot proceed.
- **Service runs locally.** Check: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux). If stopped, the welcome message can't be queued — pass `--no-welcome` later, or start the service first (`/setup` covers initial install).
- **Build is current.** `pnpm run build` — needed if `src/channels/local-http.ts` was added/edited since the last build.

## 1. Identify the local user

Ask the user in plain text (NOT `AskUserQuestion` — free-form):

> What's your name? This is just used as the display name on the local chat UI and to name the agent group folder.

Record as `DISPLAY_NAME`. If they answer with something multi-word or with punctuation, keep it as-is for `--display-name`; the script will normalize it for the folder name.

## 2. Resolve the agent group

List existing agent groups:

```bash
pnpm exec tsx -e "import Database from 'better-sqlite3'; const db = new Database('data/v2.db', { readonly: true }); console.log(JSON.stringify(db.prepare('SELECT id, name, folder FROM agent_groups').all(), null, 2));"
```

Branch on the count:

- **Zero groups.** Skip ahead — the script will create one named after the user (`groups/local-chat-<normalized-name>/`).
- **Exactly one group.** Show its folder + name and ask in plain text:
  > You have one agent group already (`<folder>` — `<name>`). Wire the browser chat to it, or create a separate one for local chat?
  Default to reuse if the user is non-committal. Record `AG_FOLDER=<folder>` if reusing, else leave unset.
- **Multiple groups.** Show the list, then ask in plain text which folder to wire (or `new` to create a fresh one). Record `AG_FOLDER=<folder>` if they pick an existing one, else leave unset.

If the user picked an Ollama-configured group (you'll see `env.ANTHROPIC_BASE_URL` set when you read its `groups/<folder>/container.json`), call that out — it means the browser chat will run against the local model.

## 3. Pick agent persona name (optional)

If creating a new group, ask in plain text:

> What should the assistant call itself? (default: `<DISPLAY_NAME>` or whatever `ASSISTANT_NAME` is in `.env`)

Record as `AGENT_NAME`. If reusing an existing group, skip this — the existing name stands.

## 4. Run the init script

```bash
pnpm exec tsx scripts/init-local-chat.ts \
  --display-name "${DISPLAY_NAME}" \
  ${AGENT_NAME:+--agent-name "${AGENT_NAME}"} \
  ${AG_FOLDER:+--agent-group-folder "${AG_FOLDER}"}
```

Add `--no-welcome` if the service is not running (the script tries to hand the welcome to the CLI socket; without the service it logs a warning but still completes the wiring).

The script:

1. Upserts the synthetic `local-http:user` user with the chosen display name.
2. Reuses or creates the agent group + filesystem (CLAUDE.local.md, container.json, skills/).
3. Grants global owner to `local-http:user` if no owner exists yet.
4. Adds the membership row.
5. Reuses or creates the `local-http`/`browser` messaging group with `unknown_sender_policy='public'`.
6. Wires them via `messaging_group_agents` (auto-creates the matching `agent_destinations` row).
7. Hands a welcome message to the running service via the CLI socket so the user gets greeted on first poll.

Show the script's output to the user.

## 5. Open the browser

```bash
# macOS
open http://127.0.0.1:3030
# Linux
xdg-open http://127.0.0.1:3030
```

Tell the user the chat opens at `http://127.0.0.1:3030` and that they can bookmark it. The connection dot in the header turns green when the host is reachable.

If the host wasn't running for the welcome step, tell the user to start it (`/setup` if they need help), then refresh the page — the welcome will arrive once the container wakes (~60s cold start on first launch).

## Verify

Ask the user in plain text:

> The browser chat should be open and the agent should greet you within a minute. Let me know when you've sent and received a message (or if it doesn't arrive).

If they confirm receipt, the skill is done.

If something is wrong, diagnose without polling:

- `curl -s http://127.0.0.1:3030/api/info` — confirms the channel adapter is listening and reports `{channelType: "local-http", platformId: "browser", ready: true}`.
- `pnpm exec tsx -e "import Database from 'better-sqlite3'; const db = new Database('data/v2.db', { readonly: true }); console.log(JSON.stringify(db.prepare(\"SELECT mga.* FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id = mga.messaging_group_id WHERE mg.channel_type = 'local-http'\").all(), null, 2));"` — confirms wiring exists.
- `tail -50 logs/nanoclaw.log` — look for `Local HTTP channel listening` at startup, `unknown_sender` drops, or container errors.

## Channel Info

- **type**: `local-http`
- **terminology**: There is exactly one conversation — the local browser session. Refresh persists.
- **how-to-find-id**: Not user-supplied. The platform id is hardcoded to `browser` in `src/channels/local-http.ts`.
- **supports-threads**: no
- **typical-use**: Single-user local chat — pair with `/add-ollama-provider` for a fully local Ollama-backed agent.
- **default-isolation**: Same agent group as anything else the user runs locally, since it's all the same person on the same machine. Wire to a separate agent group only if you want the browser chat to have a different persona/memory than (say) Discord or Slack.
- **trust boundary**: 127.0.0.1 bind. Do NOT change the bind address to expose this on a LAN — the channel has no auth.

## Troubleshooting

**`Cannot find module './local-http.js'`** — `src/channels/index.ts` doesn't import the local-http channel. This skill needs the channel adapter installed first; if the file is missing, the user has an older checkout and should pull the latest.

**`Welcome skipped: CLI socket not reachable`** — the host service isn't running. The wiring is still complete; start the service and the user's first browser message will wake the container, the welcome won't appear but the agent will respond to whatever the user types.

**Page loads but connection dot stays red** — port 3030 isn't reachable. Check `lsof -i :3030`; if nothing is listening, the host either isn't running or `LOCAL_HTTP_PORT` is set to a non-default port (check `.env`).

**Page loads but nothing happens after a message is sent** — open browser devtools, check the Network tab for the `POST /api/messages` response. 415 means the SPA isn't sending JSON (shouldn't happen). 202 means the message was queued — then check `logs/nanoclaw.log` for `unknown_sender` drops or container errors.

**`Reusing agent group` for the wrong group** — re-run with `--agent-group-folder` set to the folder you actually want. The script never deletes existing wiring; if you wired to the wrong AG once, delete the row directly:

```bash
pnpm exec tsx -e "import Database from 'better-sqlite3'; const db = new Database('data/v2.db'); db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = (SELECT id FROM messaging_groups WHERE channel_type = ?)').run('local-http');"
```

Then re-run with the correct folder.
