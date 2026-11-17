const { GH_PROJECT_TOKEN, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

const ORG = 'skygoph';
const PROJECT_NUMBER = 68;
const STALE_DAYS = Number(process.env.STALE_DAYS ?? 2);
// Normalize so capitals, extra spaces, emoji or punctuation never cause a mismatch
const norm = s => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();

// Tickets in these statuses never get reminders
const EXCLUDED_STATUSES = [
  'Issue Verification',
  'Confirmed QA',
  'Released',
  'Closed',
  'System Enhancement',
  'Endorsed to Data Team',
].map(norm);

// GitHub login -> Slack member ID (Slack: profile > ⋯ > Copy member ID)
// Everyone who should be @mentioned or get a direct message must be listed here.
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

// GitHub usernames ignore capitals, so look people up in lowercase
const slackIdOf = login => Object.entries(SLACK_USERS)
  .find(([k]) => k.toLowerCase() === String(login).toLowerCase())?.[1];

// Tickets with no assignee are handed to this person (key from SLACK_USERS above)
const UNASSIGNED_OWNER = 'mariceleri';

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
    headers: { Authorization: `Bearer ${GH_PROJECT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors || !json.data) {
    throw new Error(`GitHub API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.data.organization.projectV2.items;
}

// Calendar day in Manila time. A ticket counts as stale from midnight,
// so the first reminder lands at the 7:00 AM run, then repeats hourly.
const dayNumber = ms => {
  const [y, m, d] = new Date(ms)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
    .split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

async function getStaleItems() {
  const now = Date.now();
  const stale = [];
  let cursor = null;
  do {
    const items = await gh({ org: ORG, num: PROJECT_NUMBER, cursor });
    for (const item of items.nodes) {
      const c = item.content;
      if (!c || !['Issue', 'PullRequest'].includes(c.__typename)) continue;
      if (c.state !== 'OPEN') continue;
      if (EXCLUDED_STATUSES.includes(norm(item.status?.name))) continue;

      // Latest of project item update (status moves) and issue update (comments, edits)
      const lastActivity = Math.max(new Date(item.updatedAt), new Date(c.updatedAt));
      const days = dayNumber(now) - dayNumber(lastActivity);
      if (days >= STALE_DAYS) {
        console.log(`STALE ${c.repository.nameWithOwner}#${c.number} status=${JSON.stringify(item.status?.name)} days=${days}`);
        stale.push({
          title: c.title,
          url: c.url,
          repo: c.repository.nameWithOwner,
          number: c.number,
          status: item.status?.name ?? 'No status',
          days,
          assignees: c.assignees.nodes.map(a => a.login),
        });
      }
    }
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
  } while (cursor);
  return stale;
}

function mention(login) {
  const id = slackIdOf(login);
  return id ? `<@${id}>` : `@${login}`;
}

async function slack(text, channel = SLACK_CHANNEL_ID) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
}

// Open (or find) the direct message channel with a person. Needs the im:write scope.
async function openDm(userId) {
  const res = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: userId }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`conversations.open: ${json.error}`);
  return json.channel.id;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const stale = await getStaleItems();
  if (!stale.length) return console.log('No stale tickets.');

  // Group by assignee so each person gets one message, not one ping per ticket
  const byPerson = new Map();
  for (const t of stale) {
    const owners = t.assignees.length ? t.assignees : ['(unassigned)'];
    for (const o of owners) {
      if (!byPerson.has(o)) byPerson.set(o, []);
      byPerson.get(o).push(t);
    }
  }

  for (const [login, tickets] of byPerson) {
    const unassigned = login === '(unassigned)';
    const owner = unassigned ? UNASSIGNED_OWNER : login;
    tickets.sort((a, b) => b.days - a.days);
    const fmt = t => `• <${t.url}|${t.repo}#${t.number} ${t.title}> — _${t.status}_, no activity for *${t.days}d*`;
    const list = tickets.map(fmt).join('\n');
    const footer = "Please comment or move the ticket. I'll remind you every hour until there's activity.";

    // 1) Post in the channel, mentioning the assignee (or the owner of unassigned tickets)
    const who = unassigned ? `${mention(owner)} *Unassigned tickets*` : mention(owner);
    await slack(`${who} ⏰ Follow-up: no progress on:\n${list}\n${footer}`);

    // 2) Direct message to the same person
    const slackId = slackIdOf(owner);
    if (!slackId) {
      console.log(`No Slack ID for ${owner}; skipped direct message.`);
      continue;
    }
    const intro = unassigned ? 'This ticket has no assignee and no progress' : 'No progress on your ticket';
    let target = slackId;
    try {
      target = await openDm(slackId);
    } catch (e) {
      console.error(`${e.message} - trying the user ID directly`);
    }

    // One DM per ticket
    for (const t of tickets) {
      try {
        await slack(`⏰ ${intro}:\n${fmt(t)}\n${footer}`, target);
        console.log(`DM sent to ${owner} for ${t.repo}#${t.number}`);
      } catch (e) {
        console.error(`DM to ${owner} (${slackId}) for ${t.repo}#${t.number} FAILED: ${e.message}`);
      }
      await sleep(1100); // stay under Slack's rate limit of about 1 message per second
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
