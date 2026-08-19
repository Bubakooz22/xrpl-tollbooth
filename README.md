# xrpl-tollbooth

A payment-gated "tollbooth" on the XRP Ledger (mainnet). Clients pay XRP to a
collection address with a unique DestinationTag, then redeem that tag for a
short-lived access token once the payment is validated on-ledger.

## Setup

1. Install deps: `npm install`
2. Copy `.env.example` to `.env` and fill in your values:
   - `XRPL_SEED` - mainnet wallet seed (keep secret)
   - `TOLL_DESTINATION` - address that collects tolls
   - `TOLL_PRICE_XRP` - price to pass (default 20)
   - `PORT` - HTTP port (default 8787)

`.env` is gitignored and must never be committed.

## Scripts

- `npm start` - run the tollbooth server (`node --env-file=.env tollbooth.mjs`)
- `npm run pay <destination> <amountXrp> [destTag]` - send an XRPL payment

## Endpoints

- `POST /challenge` - returns `{ destination, destinationTag, priceXrp, instructions }`
- `POST /redeem?tag=<tag>` - verifies payment on-ledger; returns `{ token, expiresInSeconds }` (402 if unpaid)
- `GET /gated` - send `Authorization: Bearer <token>` to access the gated resource

## Flow

1. `POST /challenge` to get a destination + unique DestinationTag.
2. Pay the quoted XRP to that destination with the DestinationTag
   (e.g. `npm run pay <destination> <amount> <tag>`).
3. `POST /redeem?tag=<tag>` to exchange the confirmed payment for a token.
4. Call `GET /gated` with the bearer token.

## Payment helper notes

`send-payment.mjs` sets `LastLedgerSequence = ledger_current_index + 300`
(~20 min) explicitly after autofill, avoiding `tefMAX_LEDGER` expiry during
confirmation round-trips.

Mainnet live at https://api.txnguardian.com. Live but pre-audit — use small amounts.
