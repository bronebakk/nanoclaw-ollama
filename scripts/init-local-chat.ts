/**
 * Initialize the local-http browser chat for a non-technical end user.
 *
 * Wires the loopback browser channel (channel_type='local-http',
 * platform_id='browser') to an agent group and optionally hands a welcome
 * message to the running service via the CLI socket. After this script
 * completes, opening http://127.0.0.1:3030 reaches the agent through the
 * normal router/delivery path.
 *
 * Pairs naturally with `/add-ollama-provider`: run that first to point the
 * agent at a local model, then this to give the user a browser UI.
 *
 * Runs alongside the service (WAL-mode sqlite + CLI socket IPC) — does NOT
 * initialize channel adapters, so there's no port conflict on 3030. The
 * welcome step requires the service to be running so the CLI socket is up;
 * pass --no-welcome to skip it (e.g. when bootstrapping before first start).
 *
 * Usage:
 *   pnpm exec tsx scripts/init-local-chat.ts \
 *     --display-name "Alice" \
 *     [--agent-name "Andy"] \
 *     [--agent-group-folder local-chat-alice] \
 *     [--welcome "System instruction: ..."] \
 *     [--no-welcome]
 *
 * If --agent-group-folder is omitted, a new group is created at
 * groups/local-chat-<normalized-display-name>/.
 */
import net from 'net';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

// Must match src/channels/local-http.ts — the adapter emits these as
// channelType/platformId on every inbound event, so the messaging_groups
// row's keys have to be byte-identical or router lookups miss.
const CHANNEL = 'local-http';
const PLATFORM_ID = 'browser';
const USER_ID = `${CHANNEL}:user`;

const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new browser channel.';

interface Args {
  displayName: string;
  agentName: string;
  agentGroupFolder: string | null;
  welcome: string;
  skipWelcome: boolean;
}

function parseArgs(argv: string[]): Args {
  let displayName: string | undefined;
  let agentName: string | undefined;
  let agentGroupFolder: string | null = null;
  let welcome: string | undefined;
  let skipWelcome = false;

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--display-name':
        displayName = val;
        i++;
        break;
      case '--agent-name':
        agentName = val;
        i++;
        break;
      case '--agent-group-folder':
        agentGroupFolder = val;
        i++;
        break;
      case '--welcome':
        welcome = val;
        i++;
        break;
      case '--no-welcome':
        skipWelcome = true;
        break;
    }
  }

  if (!displayName) {
    console.error('Missing required arg: --display-name');
    console.error('See scripts/init-local-chat.ts header for usage.');
    process.exit(2);
  }

  return {
    displayName,
    agentName: agentName?.trim() || ASSISTANT_NAME || displayName,
    agentGroupFolder,
    welcome: welcome?.trim() || DEFAULT_WELCOME,
    skipWelcome,
  };
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  // 1. Synthetic local user. The local-http adapter hardcodes this senderId
  // on every inbound event — the users row must match so the access gate
  // resolves it as a real principal, not unknown_sender.
  upsertUser({
    id: USER_ID,
    kind: CHANNEL,
    display_name: args.displayName,
    created_at: now,
  });

  // 2. Resolve or create the agent group.
  const folder = args.agentGroupFolder || `local-chat-${normalizeName(args.displayName)}`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName} ` +
      `running through the local browser chat at http://127.0.0.1:3030. When the ` +
      `user first reaches out (or you receive a system welcome prompt), introduce ` +
      `yourself briefly and invite them to chat. Keep replies concise.`,
  });

  // 3. Promote the local user to global owner if no owner exists yet. The
  // local-http channel only ever has one user, and it's whoever sits at the
  // machine — the natural owner of a single-user local install.
  const existingRoles = getUserRoles(USER_ID);
  const alreadyOwner = existingRoles.some(
    (r) => r.role === 'owner' && r.agent_group_id === null,
  );
  if (!alreadyOwner && !hasAnyOwner()) {
    grantRole({
      user_id: USER_ID,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    console.log(`Granted global owner: ${USER_ID}`);
  }

  // Membership row so the access gate has a direct yes for this AG even if
  // the user isn't a global owner (e.g. an existing setup already had one).
  addMember({
    user_id: USER_ID,
    agent_group_id: ag.id,
    added_by: null,
    added_at: now,
  });

  // 4. Messaging group. There is exactly one possible (channel_type,
  // platform_id) for local-http; reuse if present.
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CHANNEL, PLATFORM_ID);
  if (!mg) {
    mg = {
      id: generateId('mg'),
      channel_type: CHANNEL,
      platform_id: PLATFORM_ID,
      name: 'Local Browser Chat',
      is_group: 0,
      // public: any client that reaches the loopback socket is the owner.
      // The bind address is the trust boundary (see local-http.ts).
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`Created messaging group: ${mg.id}`);
  } else {
    console.log(`Reusing messaging group: ${mg.id}`);
  }

  // 5. Wiring (idempotent).
  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      // DM-style channel — respond to everything.
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired local-http: ${mg.id} -> ${ag.id}`);
  } else {
    console.log(`Wiring already exists: ${existing.id}`);
  }

  // 6. Welcome hand-off (optional).
  if (!args.skipWelcome) {
    try {
      await sendWelcomeViaCliSocket(mg, args.welcome, {
        senderId: USER_ID,
        sender: args.displayName,
      });
      console.log('Welcome message queued.');
    } catch (err) {
      console.warn(
        `Welcome skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.warn('Start the service and the user will see the agent reply on first message.');
    }
  }

  console.log('');
  console.log('Init complete.');
  console.log(`  user:    ${USER_ID} (${args.displayName})`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: ${CHANNEL}/${PLATFORM_ID}`);
  console.log('');
  console.log('Open http://127.0.0.1:3030 in a browser to start chatting.');
}

/**
 * Same shape as init-first-agent's sendWelcomeViaCliSocket, but targets
 * the local-http messaging group. Routing-wise it's identical — the CLI
 * adapter is just a transport for the operator's intent; the `to` address
 * decides which channel ultimately delivers the reply.
 */
async function sendWelcomeViaCliSocket(
  mg: MessagingGroup,
  welcome: string,
  identity: { senderId: string; sender: string },
): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;

    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };

    socket.once('error', (err) =>
      settle(
        new Error(
          `CLI socket at ${sockPath} not reachable: ${err.message}. Is the NanoClaw service running?`,
        ),
      ),
    );
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text: welcome,
          senderId: identity.senderId,
          sender: identity.sender,
          to: {
            channelType: mg.channel_type,
            platformId: mg.platform_id,
            threadId: null,
          },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) {
          settle(err);
          return;
        }
        // Brief flush delay so the router picks up the line before close.
        setTimeout(() => settle(null), 50);
      });
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
