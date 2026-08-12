// pay-and-fetch.mjs
//
// Payer-side end-to-end x402 flow against the xrpl-tollbooth server.
//
// 1. Load payer config from payer.env (via `node --env-file=payer.env`).
// 2. Validate config (placeholder detection, basic shape checks).
// 3. Unpaid probe -> expect 402 + PAYMENT-REQUIRED header.
// 4. Decode PAYMENT-REQUIRED, build + sign an XRPL Payment tx for the
//    requested amount/destination/invoiceId.
// 5. Build a PAYMENT-SIGNATURE header (x402 "exact" scheme payload) and
//    retry the request.
// 6. On 200: decode PAYMENT-RESPONSE, print the settled tx hash + explorer
//    link. On 402: print PAYMENT-ERROR and exit(2).
//
// NOTE ON SPEC UNCERTAINTY: the exact shape of `payload` inside the x402
// PAYMENT-SIGNATURE envelope for the XRPL "exact" scheme is not fully
// pinned down from the /supported probe alone (that endpoint only confirms
// scheme="exact", network="xrpl:1", x402Version=2 — it does not publish a
// JSON schema for the payload). This script assumes the shape documented
// in the task spec (signedTransactionBlob + transactionHash). If the
// facilitator expects different field names, Step D will come back with a
// PAYMENT-ERROR / non-200 and that error body is printed verbatim so it
// can be diagnosed against the real facilitator contract.

import { Client, Wallet } from "xrpl";

const {
  PAYER_SEED,
  PAYER_ADDRESS,
  TOLLBOOTH_URL,
  TARGET_PATH,
  REQUEST_BODY,
} = process.env;

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// ---- Step 0: validation -----------------------------------------------

if (!PAYER_SEED || !PAYER_ADDRESS || !TOLLBOOTH_URL || !TARGET_PATH || !REQUEST_BODY) {
  fail("payer.env not filled in — set PAYER_SEED and PAYER_ADDRESS");
}

if (PAYER_SEED === "sYOUR_PAYER_TESTNET_SEED_HERE") {
  fail("payer.env not filled in — set PAYER_SEED and PAYER_ADDRESS");
}
if (PAYER_ADDRESS === "rYOUR_PAYER_TESTNET_ADDRESS_HERE") {
  fail("payer.env not filled in — set PAYER_SEED and PAYER_ADDRESS");
}

if (!/^s[a-zA-Z0-9]{27,34}$/.test(PAYER_SEED)) {
  fail(
    `PAYER_SEED does not look like a valid testnet seed (expected to start with 's', ~28-31 chars). Got length ${PAYER_SEED.length}.`
  );
}
if (!PAYER_ADDRESS.startsWith("r")) {
  fail("PAYER_ADDRESS must start with 'r'");
}

let requestBodyObj;
try {
  requestBodyObj = JSON.parse(REQUEST_BODY);
} catch (e) {
  fail(`REQUEST_BODY is not valid JSON: ${e.message}`);
}

const targetUrl = new URL(TARGET_PATH, TOLLBOOTH_URL).toString();

// ---- helpers ------------------------------------------------------------

function b64decodeJson(headerValue, label) {
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (e) {
    fail(`Failed to base64/JSON decode ${label}: ${e.message}`);
  }
}

function b64encodeJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

// ---- Step A: unpaid probe ------------------------------------------------

async function unpaidProbe() {
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBodyObj),
  });

  if (res.status !== 402) {
    fail(
      `Expected 402 on unpaid probe, got ${res.status}. Body: ${await res.text()}`
    );
  }

  const paymentRequiredHeader = res.headers.get("payment-required");
  if (!paymentRequiredHeader) {
    fail("402 response missing PAYMENT-REQUIRED header");
  }

  const paymentRequired = b64decodeJson(paymentRequiredHeader, "PAYMENT-REQUIRED");

  const accept = paymentRequired?.accepts?.[0];
  if (!accept) {
    fail(`PAYMENT-REQUIRED decoded but has no accepts[0]: ${JSON.stringify(paymentRequired)}`);
  }

  console.log(
    `unpaid probe: 402 as expected, invoiceId=${accept.invoiceId}, price=${accept.maxAmountRequired} drops, payTo=${accept.payTo}`
  );

  return paymentRequired;
}

// ---- Step B: build + sign XRPL Payment -----------------------------------

async function buildSignedPayment(paymentRequired) {
  const accept = paymentRequired.accepts[0];

  const client = new Client("wss://s.altnet.rippletest.net:51233");
  await client.connect();

  try {
    const wallet = Wallet.fromSeed(PAYER_SEED);

    if (wallet.classicAddress !== PAYER_ADDRESS) {
      console.warn(
        `WARNING: derived address from PAYER_SEED (${wallet.classicAddress}) does not match PAYER_ADDRESS (${PAYER_ADDRESS}) in payer.env. Using the address derived from the seed for signing purposes, but this mismatch should be fixed in payer.env.`
      );
    }

    const invoiceIdHex = accept.invoiceId
      .replace(/-/g, "")
      .padStart(64, "0")
      .toUpperCase();

    const tx = {
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: accept.payTo,
      Amount: accept.maxAmountRequired,
      InvoiceID: invoiceIdHex,
    };

    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);

    console.log(
      `signed tx: hash=${signed.hash}, sequence=${prepared.Sequence}, LastLedgerSequence=${prepared.LastLedgerSequence}`
    );

    return signed;
  } finally {
    await client.disconnect();
  }
}

// ---- Step C: build PAYMENT-SIGNATURE header -------------------------------

function buildPaymentSignatureHeader(signed) {
  // Per the task spec's understanding of the t54/xrpl-x402 "exact" scheme.
  // SPEC-UNCERTAIN: field names (`signedTransactionBlob`, `transactionHash`)
  // are inferred from the task brief, not confirmed against a published
  // JSON schema from t54. If the facilitator rejects this shape, the
  // PAYMENT-ERROR body from Step D should reveal the expected shape.
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: "xrpl:1",
    payload: {
      signedTransactionBlob: signed.tx_blob,
      transactionHash: signed.hash,
    },
  };

  return b64encodeJson(paymentPayload);
}

// ---- Step D: paid request ------------------------------------------------

async function paidRequest(paymentSignatureHeader) {
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": paymentSignatureHeader,
    },
    body: JSON.stringify(requestBodyObj),
  });

  const bodyText = await res.text();

  if (res.status === 200) {
    console.log("PAID REQUEST SUCCEEDED");

    let bodyJson;
    try {
      bodyJson = JSON.parse(bodyText);
      console.log(JSON.stringify(bodyJson, null, 2));
    } catch {
      console.log(bodyText);
    }

    const paymentResponseHeader = res.headers.get("payment-response");
    if (paymentResponseHeader) {
      const paymentReceipt = b64decodeJson(paymentResponseHeader, "PAYMENT-RESPONSE");
      console.log("PAYMENT-RESPONSE (decoded):");
      console.log(JSON.stringify(paymentReceipt, null, 2));

      const settledHash =
        paymentReceipt?.transactionHash ||
        paymentReceipt?.txHash ||
        paymentReceipt?.hash;

      if (settledHash) {
        console.log(`settled tx hash: ${settledHash}`);
        console.log(`testnet explorer link: https://testnet.xrpl.org/transactions/${settledHash}`);
      } else {
        console.log(
          "WARNING: could not find a tx hash field in PAYMENT-RESPONSE (checked transactionHash/txHash/hash)."
        );
      }
    } else {
      console.log("WARNING: 200 response missing PAYMENT-RESPONSE header");
    }

    return;
  }

  if (res.status === 402) {
    const paymentErrorHeader = res.headers.get("payment-error");
    if (paymentErrorHeader) {
      const paymentError = b64decodeJson(paymentErrorHeader, "PAYMENT-ERROR");
      console.error("PAYMENT-ERROR (decoded):");
      console.error(JSON.stringify(paymentError, null, 2));
    } else {
      console.error("402 response has no PAYMENT-ERROR header");
    }
    console.error("response body:");
    console.error(bodyText);
    process.exit(2);
  }

  fail(`Unexpected status ${res.status} on paid request. Body: ${bodyText}`);
}

// ---- main -----------------------------------------------------------------

async function main() {
  const paymentRequired = await unpaidProbe();
  const signed = await buildSignedPayment(paymentRequired);
  const paymentSignatureHeader = buildPaymentSignatureHeader(signed);
  await paidRequest(paymentSignatureHeader);
}

main().catch((e) => {
  console.error("FATAL:", e.stack || e.message || e);
  process.exit(1);
});
