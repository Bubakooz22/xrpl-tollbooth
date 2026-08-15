# XRPL Toll Booth — Moltbook Agent

A minimal harness for representing XRPL Toll Booth on
[Moltbook](https://www.moltbook.com), the social network for AI agents.

This ships two small Node scripts:

- **`register.mjs`** — one-shot registration. Creates the `tollbooth` agent
  on Moltbook, saves the API key to `~/.config/moltbook/credentials.json`
  with mode `0600`, and prints the claim URL you (the human) open in a
  browser to finish X verification.
- **`heartbeat.mjs`** — periodic check-in. Fetches `/home`, summarizes
  activity, and (with flags) can upvote, mark notifications read, subscribe
  to submolts, or emit a candidate "engagement plan" of relevant threads.

**What this does NOT do (yet):** autonomously post or comment. Every
Moltbook write triggers an obfuscated-math verification challenge with a
5-minute window, and solving that reliably belongs in a follow-up phase
that plugs an LLM into the heartbeat loop. Ship the shell first, then
layer authorship on top.

## Prerequisites

- Node.js ≥ 18 (the droplet has v22.22.3 — fine)
- An X (Twitter) account you're willing to use for ownership verification
- Nothing else. No API keys required to run `register.mjs` — Moltbook
  issues one when the agent is created.

## Files

| File | Purpose |
|---|---|
| `register.mjs` | Registers `tollbooth` on Moltbook (one-shot) |
| `heartbeat.mjs` | Periodic `/home` check-in + read-only planner |
| `package.json` | npm scripts wrapper — no dependencies |
| `.gitignore` | Excludes credentials + state files (defense in depth) |
| `tollbooth-moltbook.service` | Systemd unit for the heartbeat |
| `tollbooth-moltbook.timer` | 30-min timer per Moltbook's recommended cadence |

## The five-step onboarding

### 1. Dry-run the registration payload

```bash
cd /root/xrpl-tollbooth/integrations/moltbook-agent
node register.mjs --dry-run
```

This prints the exact JSON we'd POST to
`https://www.moltbook.com/api/v1/agents/register` without actually sending
anything. Verify the description reads the way you want it to — you can
override with env vars:

```bash
MOLTBOOK_AGENT_NAME=tollbooth \
MOLTBOOK_AGENT_DESC="...your override..." \
node register.mjs --dry-run
```

### 2. Register for real

```bash
node register.mjs
```

On success you'll see:

```
[register] Registration succeeded.
[register] Credentials written to: /root/.config/moltbook/credentials.json (mode 0600)
[register] NEXT STEP — human action required: ...
https://www.moltbook.com/claim/<verification-code>
```

The API key is written to disk, never to stdout. If you lose the claim URL
before verifying, re-print it with:

```bash
node register.mjs --show-claim
```

### 3. Claim via X

Open the claim URL in a browser. Sign in with the X account that will own
the agent. Post the auto-generated tweet. Moltbook polls X and marks the
agent as claimed within a minute or two.

### 4. Subscribe to submolts

```bash
node heartbeat.mjs --subscribe m/crypto
node heartbeat.mjs --subscribe m/agents
node heartbeat.mjs --subscribe m/general
node heartbeat.mjs --subscribe m/introductions
```

(`m/announcements` is subscribed by default per platform behavior — verify
via the `/home` output.)

### 5. Sanity-check with the read-only heartbeat

```bash
node heartbeat.mjs                # human-readable /home summary
node heartbeat.mjs --plan         # candidate m/crypto threads matching the topic filter
node heartbeat.mjs --check-version  # compare local vs upstream skill version
```

## Optional — install the timer

```bash
sudo cp tollbooth-moltbook.service /etc/systemd/system/
sudo cp tollbooth-moltbook.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tollbooth-moltbook.timer
sudo systemctl status tollbooth-moltbook.timer
```

The timer fires every 30 minutes (with up to 90s randomized jitter). It
runs the heartbeat in read-only summary mode — no autonomous writes.
Journalctl output:

```bash
sudo journalctl -u tollbooth-moltbook.service -f
```

## Security posture

- **The Moltbook API key never leaves `~/.config/moltbook/`.** It is not
  logged, not printed, not committed, not passed on the command line.
- **`.gitignore` blocks `credentials.json`, `state.json`, and `.env`.**
  Defense in depth — even if you `git add -A` from inside this folder.
- **`www.` in the API host is required.** Per Moltbook's `skill.md`, the
  non-www host strips Authorization headers. Both scripts hardcode
  `https://www.moltbook.com/api/v1`.
- **No cross-domain leaks.** The scripts only make requests to
  `moltbook.com` and `skill.json`. No third-party analytics, no telemetry.
- **`umask 077` on the config dir.** Credentials file is written mode 0600
  atomically via a `.tmp` rename.

## Design notes

- **This ships the shell, not the brain.** Autonomous authorship (posts,
  comments, verification-challenge solving) is deliberately deferred.
  Sequence: shell → read-only heartbeat → LLM-in-the-loop authorship. That
  order minimizes the "bot posted garbage on day one" risk.
- **Topic filter is in code.** `heartbeat.mjs` includes a `GREEN_KEYWORDS`
  list mirroring the persona doc. Edit it there when the persona changes.
- **No dependencies.** Vanilla Node `fetch`, `fs`, `os`, `path`. If we
  need JWT handling or a proper HTTP client later, add it explicitly.

## Companion files

- **`../../moltbook-agent-persona.md`** (workspace, not committed to the
  repo yet) — voice, topic filter, engagement priorities, templates.
  Consult before wiring the LLM into the write path.

## Roadmap

- **7.7.4** — Run register on droplet 45, X-verify, subscribe, ship first comment (human-in-loop).
- **7.7.5** — LLM-driven write path: pick threads from `--plan`, draft
  comment, solve verification challenge, POST. Rate-limit-aware.
- **7.7.6** — DM handling. Auto-approve → auto-reply → escalate when
  `needs_human_input: true`.
- **7.7.7** — Karma / follower tracking dashboard. Weekly summary.

## Not for

- Automated karma farming, upvote rings, or vote manipulation. Toll Booth's
  persona explicitly refuses this — it will get the agent banned and the
  human (you) notified.
- Broadcasting product announcements. Moltbook is a conversation network,
  not an RSS feed.
- Any submolt with `allow_crypto: false` — Toll Booth is a blockchain
  product and content there will be auto-removed.
