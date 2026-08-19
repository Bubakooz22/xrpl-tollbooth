# XRPL Tollbooth — Changelog

## 2026-08-11 — Initial scaffold complete

### Merchant server (tollbooth.mjs)
- Custom `/challenge` + `/redeem` + bearer-token flow implemented (Node built-ins + xrpl@5.0.0, no framework).
- Payment verification via `account_tx` matching on DestinationTag.
- Listening on `:8787` in tmux window `tollbooth:server`.

### Payment CLI (send-payment.mjs)
- Reusable `sendPayment()` function + CLI wrapper.
- Fixed ledger-buffer bug: `autofill(tx, N)` second arg is signer count, NOT ledger buffer. Correct pattern: explicit `LastLedgerSequence = ledger_current_index + 300` for ~20-min expiry window.

## [0.7.0] - 2026-08-19 — MAINNET LIVE

### Cutover
- Migrated production listener from XRPL testnet (`xrpl:1`) to mainnet (`xrpl:0`).
- New merchant wallet: `rK1C1DPzJo9gSjK2LSdhV5J5veFB84zHer`.
- Facilitator: `https://xrpl-facilitator-mainnet.t54.ai` (T54 hosted).
- Pricing: 5000 drops XRP (~$0.0025) per call, up from 1000 drops testnet.
- RLUSD alt-pricing: 0.002 RLUSD per call, mainnet issuer `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De`.

### Infrastructure
- Custom domain `txnguardian.com` with Let's Encrypt HTTPS via Caddy.
- Systemd unit for automatic restart on failure and reboot.
- First paid mainnet tx: `1B56F363D6F5C278516A548D170E7E1E7C0951543147E616872C5E1E1C6665F6`.

### First testnet payment
- 20 XRP → `rhPtQu2YtmUddDMBdUFunhf25RGgXYQ7aL`
- Hash: `98A7E7377836441F30BBA5DBF38BB57C5B9D41FC127368FFAF3F65882FE836C1`
- Result: `tesSUCCESS`, validated.

### Repo
- Commits: `e81468b` (initial) → `fc94fd9` (npm scripts) → `0d29897` (config + docs).
- `.env` protected by `.gitignore`, `.env.example` committed with `!.env.example` override.

## Deferred for Phase 0c (before mainnet)
- Cloudflare + TLS in front of `:8787`; firewall port to localhost.
- Non-root user for the server process.
- Rate limiting.
