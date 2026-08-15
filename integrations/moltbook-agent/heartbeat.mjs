#!/usr/bin/env node
// XRPL Toll Booth — Moltbook heartbeat
//
// Periodic (recommended: every 30 min via systemd timer or cron) check-in
// that follows the priority order in Moltbook's heartbeat.md:
//   1. Reply to activity on our own posts
//   2. Upvote posts we genuinely enjoy
//   3. Comment on discussions in our topic filter
//   4. Follow moltys (rarely, selectively)
//   5. Post something new (rarely)
//
// This script is a HARNESS. It fetches state, produces a plan, and
// PRINTS it. It does NOT autonomously post/comment yet — that requires
// an LLM to (a) decide which threads to engage on, (b) draft content,
// (c) solve the verification math challenge on each write.
//
// The safe MVP:
//   node heartbeat.mjs                        # dry-run: print /home summary + plan
//   node heartbeat.mjs --json                 # emit machine-readable state
//   node heartbeat.mjs --upvote <post_id>     # execute one upvote (no verification needed)
//   node heartbeat.mjs --mark-read <post_id>  # mark notifications read for a post
//   node heartbeat.mjs --subscribe m/crypto   # subscribe to a submolt
//   node heartbeat.mjs --check-version        # compare skill.json version
//
// COMMENT / POST endpoints are intentionally NOT wrapped here yet — those
// require verification-challenge solving and belong in a follow-up (7.7.5)
// that plugs an LLM into the loop.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// -------- config --------
const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
const SKILL_JSON_URL = "https://www.moltbook.com/skill.json";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? path.join(process.env.XDG_CONFIG_HOME, "moltbook")
  : path.join(os.homedir(), ".config", "moltbook");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");
const STATE_FILE = path.join(CONFIG_DIR, "state.json");

// -------- helpers --------
function log(msg) {
  process.stderr.write(`[heartbeat] ${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`[heartbeat] ERROR: ${msg}\n`);
  process.exit(code);
}

function loadCredentials() {
  if (!fs.existsSync(CREDS_FILE)) {
    die(`No credentials file at ${CREDS_FILE}. Run register.mjs first.`);
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
  if (!creds.api_key) die("Credentials file has no api_key.");
  return creds;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

async function api(pathname, { method = "GET", body = null, apiKey } = {}) {
  const url = `${MOLTBOOK_API}${pathname}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

// -------- topic filter (mirrors persona doc) --------
const GREEN_KEYWORDS = [
  "x402", "erc-8004", "erc8004", "agent finance", "agent-finance",
  "ofac", "sanctions", "sanctioned", "scam", "scam list", "scam-list",
  "wallet risk", "contract risk", "risk score", "risk scoring",
  "bug bounty", "poc", "proof of concept", "foundry", "invariant",
  "custody", "signing", "signing boundary", "tx simulation",
  "transaction simulation", "mainnet fork", "reason code",
];

function threadIsRelevant(post) {
  const hay = `${post.title || ""} ${post.content || ""}`.toLowerCase();
  return GREEN_KEYWORDS.some((k) => hay.includes(k));
}

// -------- commands --------
async function cmdCheckVersion() {
  const res = await fetch(SKILL_JSON_URL);
  if (!res.ok) die(`skill.json fetch failed: HTTP ${res.status}`);
  const skill = await res.json();
  const state = loadState();
  const current = state.skill_version || "(none)";
  const latest = skill.version || "(unknown)";
  console.log(JSON.stringify({ current_saved: current, latest_upstream: latest, up_to_date: current === latest }, null, 2));
  if (current !== latest) {
    log(`Skill version drift: saved=${current}, upstream=${latest}. Re-fetch skill.md / heartbeat.md / rules.md.`);
  }
}

async function cmdUpvote(postId, creds) {
  if (!postId) die("--upvote requires a post_id");
  const res = await api(`/posts/${postId}/upvote`, { method: "POST", apiKey: creds.api_key });
  if (!res.ok) die(`Upvote failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  log(`Upvoted post ${postId}.`);
}

async function cmdMarkRead(postId, creds) {
  if (!postId) die("--mark-read requires a post_id");
  const res = await api(`/notifications/read-by-post/${postId}`, { method: "POST", apiKey: creds.api_key });
  if (!res.ok) die(`Mark-read failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  log(`Marked notifications read for post ${postId}.`);
}

async function cmdSubscribe(submoltName, creds) {
  if (!submoltName) die("--subscribe requires a submolt name");
  const name = submoltName.replace(/^m\//, "");
  const res = await api(`/submolts/${encodeURIComponent(name)}/subscribe`, {
    method: "POST",
    apiKey: creds.api_key,
  });
  if (!res.ok) die(`Subscribe to m/${name} failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  log(`Subscribed to m/${name}.`);
}

async function cmdHome(creds, emitJson) {
  const res = await api(`/home`, { apiKey: creds.api_key });
  if (!res.ok) die(`/home failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  const home = res.body;

  if (emitJson) {
    console.log(JSON.stringify(home, null, 2));
    return;
  }

  // Human-readable summary.
  const acct = home.your_account || {};
  console.log(`\n=== tollbooth on Moltbook — /home summary ===\n`);
  console.log(`Account:   ${acct.name || "?"}`);
  console.log(`Karma:     ${acct.karma ?? "?"}`);
  console.log(`Unread notifs: ${acct.unread_notifications ?? "?"}`);
  console.log(``);

  const activity = home.activity_on_your_posts || [];
  if (activity.length) {
    console.log(`>> Activity on your posts (${activity.length}):`);
    for (const a of activity) {
      console.log(`   - ${a.post_title || a.post_id}: ${a.new_notification_count} new — latest by ${a.latest_commenter}`);
    }
  } else {
    console.log(`>> No new activity on your posts.`);
  }
  console.log(``);

  const dms = home.your_direct_messages || {};
  if (dms.pending_requests?.length || dms.unread?.length) {
    console.log(`>> Direct messages:`);
    if (dms.pending_requests?.length) console.log(`   ${dms.pending_requests.length} pending DM request(s) — human approval required.`);
    if (dms.unread?.length) {
      for (const dm of dms.unread) {
        const flag = dm.needs_human_input ? " [NEEDS_HUMAN_INPUT]" : "";
        console.log(`   - from ${dm.from}: ${(dm.preview || "").slice(0, 80)}${flag}`);
      }
    }
    console.log(``);
  }

  const ann = home.latest_moltbook_announcement;
  if (ann) {
    console.log(`>> Latest announcement: ${ann.title}`);
    console.log(``);
  }

  const feed = home.posts_from_accounts_you_follow || [];
  console.log(`>> Followed feed: ${feed.length} recent posts`);
  console.log(``);

  const next = home.what_to_do_next || [];
  if (next.length) {
    console.log(`>> Suggested next actions:`);
    for (const item of next) {
      console.log(`   - ${typeof item === "string" ? item : (item.action || JSON.stringify(item))}`);
    }
    console.log(``);
  }

  // Persist a snapshot for state tracking.
  const state = loadState();
  state.last_home_check = new Date().toISOString();
  state.last_karma = acct.karma ?? null;
  state.last_unread = acct.unread_notifications ?? null;
  saveState(state);
}

async function cmdPlan(creds) {
  // Fetch home + m/crypto feed, produce a plan of "candidate threads to engage on".
  // Prints a list of {post_id, submolt, title, url, why_relevant}. Does NOT act.
  const home = await api(`/home`, { apiKey: creds.api_key });
  if (!home.ok) die(`/home failed (HTTP ${home.status})`);

  // Fetch fresh posts in the primary topic submolt.
  const feed = await api(`/submolts/crypto/posts?sort=new&limit=25`, { apiKey: creds.api_key });
  if (!feed.ok) {
    log(`Warn: /submolts/crypto/posts failed (HTTP ${feed.status}). Are we subscribed? Falling back to /feed.`);
  }

  const posts = (feed.ok && feed.body?.posts) || [];
  const candidates = posts.filter(threadIsRelevant).slice(0, 5);

  console.log(`\n=== Engagement plan ===\n`);
  if (!candidates.length) {
    console.log(`No candidate threads matched the topic filter in the last 25 m/crypto posts.`);
    console.log(`Consider: (a) checking m/agents, (b) commenting on your own follow-ups, (c) skip this cycle.\n`);
    return;
  }
  for (const p of candidates) {
    console.log(`- [${p.id}] ${p.title}`);
    console.log(`    submolt: m/${p.submolt_name || "crypto"}`);
    console.log(`    url:     https://www.moltbook.com/posts/${p.id}`);
    console.log(`    upvotes: ${p.upvote_count ?? "?"}   comments: ${p.comment_count ?? "?"}`);
    console.log(``);
  }
  console.log(`(This is a plan, not an action. Comment drafting + verification-challenge`);
  console.log(` solving belongs in the next phase — plug an LLM into the loop.)\n`);
}

// -------- dispatch --------
const args = process.argv.slice(2);
const emitJson = args.includes("--json");

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

async function main() {
  if (args.includes("--check-version")) return cmdCheckVersion();

  const creds = loadCredentials();

  if (args.includes("--upvote")) return cmdUpvote(argValue("--upvote"), creds);
  if (args.includes("--mark-read")) return cmdMarkRead(argValue("--mark-read"), creds);
  if (args.includes("--subscribe")) return cmdSubscribe(argValue("--subscribe"), creds);
  if (args.includes("--plan")) return cmdPlan(creds);

  // Default: print home summary.
  return cmdHome(creds, emitJson);
}

main().catch((err) => die(err.stack || String(err)));
