import http from "node:http";
import crypto from "node:crypto";
import { Client, dropsToXrp } from "xrpl";

// Payment-gated "tollbooth": clients pay XRP to a destination with a unique
// DestinationTag, then redeem that tag for a short-lived access token once the
// payment is validated on the XRPL testnet.
const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
const PORT = Number(process.env.PORT ?? 8787);
const TOLL_DESTINATION = process.env.TOLL_DESTINATION; // r-address that collects tolls
const TOLL_PRICE_XRP = Number(process.env.TOLL_PRICE_XRP ?? 20);

if (!TOLL_DESTINATION) throw new Error("TOLL_DESTINATION not set");

// In-memory challenge + token stores (swap for a DB in production).
const challenges = new Map(); // tag -> { priceXrp, createdAt, paid }
const tokens = new Map();     // token -> expiresAt

function newTag() {
  // XRPL DestinationTag is a uint32.
  return crypto.randomInt(1, 0xffffffff);
}

async function findPayment(client, destinationTag) {
  const { result } = await client.request({
    command: "account_tx",
    account: TOLL_DESTINATION,
    ledger_index_min: -1,
    ledger_index_max: -1,
    limit: 50,
  });
  for (const entry of result.transactions) {
    const tx = entry.tx ?? entry.tx_json ?? {};
    const meta = entry.meta;
    if (tx.TransactionType !== "Payment") continue;
    if (tx.Destination !== TOLL_DESTINATION) continue;
    if (tx.DestinationTag !== destinationTag) continue;
    if (!entry.validated) continue;
    const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount ?? tx.Amount;
    if (typeof delivered !== "string") continue; // only care about XRP (drops)
    const paidXrp = Number(dropsToXrp(delivered));
    if (paidXrp + 1e-6 >= TOLL_PRICE_XRP) return { hash: tx.hash, paidXrp };
  }
  return null;
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // 1) Request a toll challenge.
    if (req.method === "POST" && url.pathname === "/challenge") {
      const tag = newTag();
      challenges.set(tag, { priceXrp: TOLL_PRICE_XRP, createdAt: Date.now(), paid: false });
      return send(res, 200, {
        destination: TOLL_DESTINATION,
        destinationTag: tag,
        priceXrp: TOLL_PRICE_XRP,
        instructions: `Send ${TOLL_PRICE_XRP} XRP to ${TOLL_DESTINATION} with DestinationTag ${tag}, then POST /redeem?tag=${tag}`,
      });
    }

    // 2) Redeem a paid challenge for an access token.
    if (req.method === "POST" && url.pathname === "/redeem") {
      const tag = Number(url.searchParams.get("tag"));
      const ch = challenges.get(tag);
      if (!ch) return send(res, 404, { error: "unknown or expired tag" });

      const client = new Client(TESTNET_URL);
      await client.connect();
      let payment;
      try {
        payment = await findPayment(client, tag);
      } finally {
        await client.disconnect();
      }
      if (!payment) return send(res, 402, { error: "payment not found yet", tag });

      ch.paid = true;
      const token = crypto.randomBytes(24).toString("hex");
      tokens.set(token, Date.now() + 15 * 60 * 1000); // 15 min
      return send(res, 200, { token, expiresInSeconds: 900, paidXrp: payment.paidXrp, txHash: payment.hash });
    }

    // 3) Access a gated resource with the token.
    if (req.method === "GET" && url.pathname === "/gated") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const exp = tokens.get(token);
      if (!exp || exp < Date.now()) return send(res, 401, { error: "invalid or expired token" });
      return send(res, 200, { ok: true, message: "Access granted through the tollbooth." });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, () => {
  console.log(`tollbooth listening on :${PORT} (dest=${TOLL_DESTINATION}, price=${TOLL_PRICE_XRP} XRP)`);
});
