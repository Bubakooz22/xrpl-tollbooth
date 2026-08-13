# Nightly scope-refresh systemd timer

## Cost estimate

~15 programs × 1 request/night × sonar (cheapest tier, ~\$0.001-0.005/request with web search) = **~\$0.02-0.07/night ≈ \$7-25/year total**. Sanity-rejected calls cost the same so budget for a bit more if pages become uncooperative.

## Install (on droplet, as root)

```bash
cd /root/xrpl-tollbooth

# 1. Create the env file with your Perplexity API key
#    Get one from https://www.perplexity.ai/settings/api
cat > refresh.env <<'EOF'
PERPLEXITY_API_KEY=pplx-...
EOF
chmod 600 refresh.env

# (Optional: override the model — default is 'sonar')
# echo 'PPLX_MODEL=sonar-pro' >> refresh.env

# 2. Ensure git can push non-interactively (uses existing ~/.ssh/id_* or PAT in remote URL)
git remote -v  # verify origin uses a form that pushes without prompt

# 3. Install the systemd units
cp scripts/systemd/xrpl-tollbooth-scope-refresh.service /etc/systemd/system/
cp scripts/systemd/xrpl-tollbooth-scope-refresh.timer   /etc/systemd/system/
systemctl daemon-reload

# 4. Enable + start the timer (starts at next 04:00 UTC)
systemctl enable --now xrpl-tollbooth-scope-refresh.timer
systemctl list-timers | grep scope-refresh

# 5. Test-fire immediately (writes to master, so only do this once you've verified DRY-RUN works)
systemctl start xrpl-tollbooth-scope-refresh.service
journalctl -u xrpl-tollbooth-scope-refresh.service --no-pager
tail /var/log/xrpl-tollbooth-scope-refresh.log
```

## Behavior

- Runs daily at 04:00 UTC (00:00 EDT, 21:00 PDT day before).
- On each run: fetches all 15 program URLs, extracts payout/status/kyc, applies sanity gates.
- Only mutates `max_payout_usd`, `kyc_required`, `status` fields on existing programs.
- Never adds/removes programs. Never touches `contracts[]`.
- Only commits + pushes on real diffs.
- Sanity-rejects payout drops >50% or jumps >10x (likely misparses).

## Manual operation

```bash
# Dry-run (no writes, no commits, just show what would change)
node scripts/refresh-scope.mjs

# Apply locally but don't commit
node scripts/refresh-scope.mjs --write

# Apply + commit + push
node scripts/refresh-scope.mjs --write --commit

# Debug parse failures
node scripts/refresh-scope.mjs --debug
```

## Logs

`/var/log/xrpl-tollbooth-scope-refresh.log` — one entry per program per run, plus summary.
