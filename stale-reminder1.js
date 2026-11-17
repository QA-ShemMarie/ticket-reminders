'use strict';

// GitHub Project #68 -> Slack stale-ticket reminders
// Requires Node.js 18+ (built-in fetch).
const { GH_PROJECT_TOKEN, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

const ORG = 'skygoph';
const PROJECT_NUMBER = 68;
const STALE_DAYS = Number(process.env.STALE_DAYS ?? 2);
const DRY_RUN = String(process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';

// This marker appears in new Slack messages so you can identify which script sent them.
const SCRIPT_VERSION = 'stale-filter-v3-allowlist';

// Normalize case, whitespace, punctuation, emoji, and invisible characters.
const norm = value => String(value ?? '')
  .normalize('NFKC')
  .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
  .toLowerCase();

// The 14 official GitHub Project #68 statuses shown in the project settings.
// Fail-closed policy: ONLY these eight statuses are eligible for reminders.
const REMINDER_STATUSES = new Set([
  'Return to Helpdesk',
  'Backlog Helpdesk',
  'Backlog QA',
  'For Triage',
  'Under Engineering',
  'Endorsed to Consultants',
  'Endorsed to Process Owners',
  'For QA Confirmation',
].map(norm));

const EXCLUDED_STATUSES = new Set([
  'Issue Verification',
  'System Enhancement',
  'Endorsed to Data Team',
  'Confirmed QA',
  'Released',
  'Closed',
].map(norm));

function canNotifyStatus(status) {
  const normalized = norm(status);
  return normalized !== ''
    && REMINDER_STATUSES.has(normalized)
    && !EXCLUDED_STATUSES.has(normalized);
}

// Validate that a status never appears in both sets. Useful when editing later.
for (const status of REMINDER_STATUSES) {
  if (EXCLUDED_STATUSES.has(status)) {
    throw new Error(`Configuration error: status is both allowed and excluded: ${status}`);
  }
}

// GitHub login -> Slack member ID.
const SLACK_USERS = {
  'AlvinAmpoloquio2025': 'U0AQW7XK80Z',
  'Bacusmon': 'U06KMJJ2BQF',
  'CanalesES': 'U05396NPYQJ',
  'chemespi': 'U09HMEZ4WK1',
  'j3know': 'U05TGS7KF2M',
  'Jamesjumawan': 'U047TT7479A',
  'Jeffgarcia09': 'U05SPM4PGTZ',
  'jezzerjohn21': 'U05TGS7DVJ5',
  'Jonasreycian': 'U0668FV4H43',
  'josheeortalla': 'U04K4784S3W',
  'Mariceleri': 'U016V4RL53N',
  'Medjuil': 'U05SPM4V72B',
  'Pretz81': 'U05D27S55BQ',
  'QA-ShemMarie': 'U0AQ1T2JALX',
  'Relevie': 'U05T6LNQBKN',
  'rhosellcalipusan': 'U06KWDBR0HL',
  'RMJ-reymarkjan': 'U09JVTSR6JW',
};
const UNASSIGNED_OWNER = 'mariceleri';

const slackIdOf = login => Object.entries(SLACK_USERS)
  .find(([name]) => name.toLowerCase() === String(login).toLowerCase())?.[1];

const mention = login => {
  const id = slackIdOf(login);
  return id ? `<@${id}>` : `@${login}`;
};

const QUERY = `
query($org:String!, $num:Int!, $cursor:String) {
  organization(login:$org) {
    projectV2(number:$num) {
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          updatedAt
          status: fieldValueByName(name:"Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue {
              number title url state updatedAt
              repository { nameWithOwner }
              assignees(first:5) { nodes { login } }
            }
            ... on PullRequest {
              number title url state updatedAt
              repository { nameWithOwner }
              assignees(first:5) { nodes { login } }
            }
          }
        }
      }
    }
  }
}`;

async function gh(variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GH_PROJECT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'skygoph-stale-ticket-reminder',
    },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data?.organization?.projectV2?.items) {
    throw new Error(`GitHub API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data.organization.projectV2.items;
}

// Manila calendar days; this avoids relying on locale-specific date formatting.
const manilaDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
});
function dayNumber(ms) {
  const parts = Object.fromEntries(
    manilaDate.formatToParts(new Date(ms)).map(p => [p.type, p.value])
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
}

async function getStaleItems() {
  const today = dayNumber(Date.now());
  const stale = [];
  let cursor = null;
  let excluded = 0;
  let missingStatus = 0;
  let notAllowed = 0;

  do {
    const items = await gh({ org: ORG, num: PROJECT_NUMBER, cursor });
    for (const item of items.nodes ?? []) {
      const c = item?.content;
      if (!c || !['Issue', 'PullRequest'].includes(c.__typename)) continue;
      if (c.state !== 'OPEN') continue;

      // FILTER #1: apply exclusions as soon as the GitHub status is retrieved.
      const status = item.status?.name ?? '';
      if (!canNotifyStatus(status)) {
        if (norm(status) === '') {
          missingStatus++;
          console.log(`SKIPPED MISSING STATUS ${c.repository.nameWithOwner}#${c.number}`);
        } else if (EXCLUDED_STATUSES.has(norm(status))) {
          excluded++;
          console.log(`SKIPPED EXCLUDED ${c.repository.nameWithOwner}#${c.number}: ${JSON.stringify(status)}`);
        } else {
          notAllowed++;
          console.log(`SKIPPED UNKNOWN STATUS ${c.repository.nameWithOwner}#${c.number}: ${JSON.stringify(status)}`);
        }
        continue;
      }

      // Project-item updates (including status moves) and issue/PR updates reset the clock.
      const lastActivity = Math.max(Date.parse(item.updatedAt), Date.parse(c.updatedAt));
      if (!Number.isFinite(lastActivity)) {
        console.warn(`INVALID DATE ${c.repository.nameWithOwner}#${c.number}; skipped`);
        continue;
      }
      const days = today - dayNumber(lastActivity);
      if (days < STALE_DAYS) continue;

      stale.push({
        title: c.title,
        url: c.url,
        repo: c.repository.nameWithOwner,
        number: c.number,
        status,
        days,
        assignees: (c.assignees?.nodes ?? []).map(a => a.login),
      });
      console.log(`STALE ${c.repository.nameWithOwner}#${c.number} status=${JSON.stringify(status)} days=${days}`);
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`Excluded: ${excluded}; unknown/not allowed: ${notAllowed}; missing status: ${missingStatus}; stale candidates: ${stale.length}`);
  return stale;
}

// Escape untrusted issue titles/statuses in Slack's mrkdwn format.
const escapeSlack = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatTicket(t) {
  return `• <${t.url}|${escapeSlack(t.repo)}#${t.number} ${escapeSlack(t.title)}> — _${escapeSlack(t.status)}_, no activity for *${t.days}d*`;
}

async function slack(message, channel = SLACK_CHANNEL_ID) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text: message, unfurl_links: false }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) throw new Error(`Slack chat.postMessage ${res.status}: ${json.error ?? JSON.stringify(json)}`);
}

async function openDm(userId) {
  const res = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users: userId }),
  });
  const json = await res.json();
  if (!res.ok || !json.ok || !json.channel?.id) {
    throw new Error(`Slack conversations.open ${res.status}: ${json.error ?? JSON.stringify(json)}`);
  }
  return json.channel.id;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log(`Running ${SCRIPT_VERSION}; SHA=${process.env.GITHUB_SHA ?? 'local'}; DRY_RUN=${DRY_RUN}`);
  console.log(`Allowed statuses: ${[...REMINDER_STATUSES].join(' | ')}`);
  if (String(process.env.STATUS_TEST_ONLY ?? '').toLowerCase() === 'true') {
    for (const status of ['Return to Helpdesk', 'Backlog Helpdesk', 'Backlog QA', 'Issue Verification', 'System Enhancement', 'For Triage', 'Under Engineering', 'Endorsed to Consultants', 'Endorsed to Process Owners', 'Endorsed to Data Team', 'For QA Confirmation', 'Confirmed QA', 'Released', 'Closed']) {
      console.log(`${canNotifyStatus(status) ? 'ALLOW' : 'BLOCK'}: ${status}`);
    }
    return;
  }
  if (!GH_PROJECT_TOKEN) throw new Error('Missing GH_PROJECT_TOKEN');
  if (!Number.isFinite(STALE_DAYS) || STALE_DAYS < 0) throw new Error('STALE_DAYS must be a nonnegative number');
  if (!DRY_RUN && (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID)) {
    throw new Error('Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID');
  }

  // FILTER #2: a final status check on the assembled candidate list.
  const stale = (await getStaleItems()).filter(t => {
    if (canNotifyStatus(t.status)) return true;
    console.warn(`FINAL FILTER BLOCKED ${t.repo}#${t.number}: ${JSON.stringify(t.status)}`);
    return false;
  });
  if (!stale.length) {
    console.log('No eligible stale tickets.');
    return;
  }

  // Group by assignee so each person gets one channel message.
  const byPerson = new Map();
  for (const t of stale) {
    const owners = t.assignees.length ? t.assignees : ['(unassigned)'];
    for (const login of owners) {
      if (!byPerson.has(login)) byPerson.set(login, []);
      byPerson.get(login).push(t);
    }
  }

  const footer = "Please comment or move the ticket. I'll remind you every hour until there's activity.";
  for (const [login, tickets] of byPerson) {
    // FILTER #3: check once more immediately before creating any Slack messages.
    const eligible = tickets.filter(t => canNotifyStatus(t.status));
    if (!eligible.length) continue;
    eligible.sort((a, b) => b.days - a.days);

    const unassigned = login === '(unassigned)';
    const owner = unassigned ? UNASSIGNED_OWNER : login;
    const who = unassigned ? `${mention(owner)} *Unassigned tickets*` : mention(owner);
    const list = eligible.map(formatTicket).join('\n');
    const channelText = `${who} ⏰ Follow-up [${SCRIPT_VERSION}]: no progress on:\n${list}\n${footer}`;

    if (DRY_RUN) {
      console.log(`DRY RUN: would send channel summary to ${owner} (${eligible.length} ticket(s))`);
    } else {
      try {
        await slack(channelText);
        console.log(`Channel reminder posted for ${owner}: ${eligible.length} ticket(s)`);
      } catch (err) {
        console.error(`CHANNEL FAILED for ${owner}: ${err.message}`);
      }
      await sleep(1100);
    }

    const userId = slackIdOf(owner);
    if (!userId) {
      console.log(`No Slack member ID for ${owner}; skipped DMs.`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`DRY RUN: would DM ${owner} once for each of ${eligible.length} ticket(s)`);
      continue;
    }

    let target = userId;
    try {
      target = await openDm(userId);
    } catch (err) {
      console.error(`${err.message}; attempting DM via user ID`);
    }

    const intro = unassigned ? 'This ticket has no assignee and no progress' : 'No progress on your ticket';
    for (const t of eligible) {
      // FILTER #4: absolutely no DM for an excluded/missing status.
      if (!canNotifyStatus(t.status)) continue;
      try {
        await slack(`⏰ ${intro} [${SCRIPT_VERSION}]:\n${formatTicket(t)}\n${footer}`, target);
        console.log(`DM sent to ${owner} for ${t.repo}#${t.number}`);
      } catch (err) {
        console.error(`DM to ${owner} for ${t.repo}#${t.number} FAILED: ${err.message}`);
      }
      await sleep(1100);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
