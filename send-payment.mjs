import { Client, Wallet, xrpToDrops } from "xrpl";

// XRPL testnet payment helper with an explicit ledger buffer so the
// transaction does not expire (tefMAX_LEDGER) during a confirmation round-trip.
export const TESTNET_URL = "wss://s.altnet.rippletest.net:51233";
export const XRPL_STARTER_KIT_SOURCE_TAG = 20260530;
const LEDGER_BUFFER = 300; // ~20 min at ~4s/ledger

export async function sendPayment({
  destination,
  amountXrp,
  seed = process.env.XRPL_SEED,
  destinationTag,
} = {}) {
  if (!seed) throw new Error("XRPL_SEED not set");
  if (!destination) throw new Error("destination is required");
  if (amountXrp == null) throw new Error("amountXrp is required");

  const wallet = Wallet.fromSeed(seed);
  const tx = {
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: destination,
    Amount: xrpToDrops(String(amountXrp)),
    SourceTag: XRPL_STARTER_KIT_SOURCE_TAG,
  };
  if (destinationTag != null) tx.DestinationTag = destinationTag;

  const client = new Client(TESTNET_URL);
  await client.connect();
  try {
    const prepared = await client.autofill(tx);
    const { result: lc } = await client.request({ command: "ledger_current" });
    prepared.LastLedgerSequence = lc.ledger_current_index + LEDGER_BUFFER;

    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    return {
      hash: signed.hash,
      engine_result: res.result.meta?.TransactionResult,
      validated: res.result.validated,
      ledger_index: res.result.ledger_index,
      account: wallet.address,
    };
  } finally {
    await client.disconnect();
  }
}

// CLI: node --env-file=.env send-payment.mjs <destination> <amountXrp> [destTag]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [destination, amountXrp, destTag] = process.argv.slice(2);
  if (!destination || !amountXrp) {
    console.error("usage: node --env-file=.env send-payment.mjs <destination> <amountXrp> [destTag]");
    process.exit(1);
  }
  const out = await sendPayment({
    destination,
    amountXrp,
    destinationTag: destTag ? Number(destTag) : undefined,
  });
  console.log(JSON.stringify(out, null, 2));
}
