const { GH_PROJECT_TOKEN, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

const ORG = 'skygoph';
const PROJECT_NUMBER = 68;
const STALE_DAYS = Number(process.env.STALE_DAYS ?? 2);
const DONE_STATUSES = ['Done', 'Closed', 'Cancelled'];

// GitHub login -> Slack member ID (Slack: profile > ⋯ > Copy member ID)
const SLACK_USERS = {
  'github-username-1': 'U0123ABCD',
  'github-username-2': 'U0456EFGH',
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
      if (DONE_STATUSES.includes(item.status?.name)) continue;

      // Latest of project item update (status moves) and issue update (comments, edits)
      const lastActivity = Math.max(new Date(item.updatedAt), new Date(c.updatedAt));
      const days = dayNumber(now) - dayNumber(lastActivity);
      if (days >= STALE_DAYS) {
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
  return SLACK_USERS[login] ? `<@${SLACK_USERS[login]}>` : `@${login}`;
}

async function slack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text, unfurl_links: false }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
}

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
    const who = login === '(unassigned)' ? '*Unassigned tickets*' : mention(login);
    const lines = tickets
      .sort((a, b) => b.days - a.days)
      .map(t => `• <${t.url}|${t.repo}#${t.number} ${t.title}> — _${t.status}_, no activity for *${t.days}d*`);
    await slack(`${who} ⏰ Follow-up: no progress on:\n${lines.join('\n')}\nPlease comment or move the ticket. I'll remind you every hour until there's activity.`);
  }
})().catch(e => { console.error(e); process.exit(1); });
