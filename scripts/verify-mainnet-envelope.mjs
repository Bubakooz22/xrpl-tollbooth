// Standalone verifier: pulls the published pubkey manifest, extracts the key
// that signed the pasted envelope, and confirms the signature. No secrets.
//
// Usage:
//   node scripts/verify-mainnet-envelope.mjs

import { verifyEnvelope } from '../lib/envelope-signer.mjs';
import { createPublicKey } from 'node:crypto';

const MANIFEST_URL = 'https://api.txnguardian.com/.well-known/tollbooth-keys.json';

// The full response body from the paid call.
const responseBody = {
  "envelope": {
    "version": "0.8",
    "endpoint": "/wallet-risk",
    "request_hash": "a98888b659d1062fe5af3b8fdfe51a8264cb5dbe681d4ac5c631dfcb84b7190d",
    "risk_level": "critical",
    "reason_codes": [
      {
        "code": "OFAC_SANCTIONED",
        "severity": "critical",
        "override_permitted": false,
        "source": "us-treasury-sdn",
        "evidence": "OFAC SDN ETH list hit"
      }
    ],
    "human": "This address is on the OFAC SDN list. Do not send funds.",
    "fulfillment_status": "complete",
    "retry_permitted": false,
    "retry_after_seconds": null,
    "issued_at": "2026-08-26T14:24:38.636Z",
    "expires_at": "2026-08-26T15:24:38.636Z",
    "signing_key_id": "tb-2026-08a",
    "envelope_hash": "ee5a16c6fc6662f26d1ba01b0a6092d263b21e9a7b40e0c371c766fc2a1da4c9"
  },
  "signature": {
    "alg": "Ed25519",
    "key_id": "tb-2026-08a",
    "value": "8mAPPAisLw+Q5KiU3w1b4SkEgvhWKx14TaCxzx0ZZpztzdtL1KmQ8CkLn2QMr9l7uXF9DCyyoF84djLyM0FRDw=="
  }
};

console.log('Fetching manifest from', MANIFEST_URL);
const manifestRes = await fetch(MANIFEST_URL);
if (!manifestRes.ok) {
  console.error(`Manifest fetch failed: ${manifestRes.status}`);
  process.exit(1);
}
const manifest = await manifestRes.json();
console.log(`Manifest has ${manifest.keys.length} key(s)`);

const keyId = responseBody.signature.key_id;
const keyEntry = manifest.keys.find((k) => k.key_id === keyId);
if (!keyEntry) {
  console.error(`Key ${keyId} not in manifest`);
  process.exit(1);
}
console.log(`Found key ${keyId} in manifest`);
console.log(`  public_key: ${keyEntry.public_key}`);
console.log(`  status:     ${keyEntry.status}`);

// Convert raw 32-byte base64 pubkey to a Node crypto PublicKey.
// Ed25519 SPKI DER prefix is fixed 12 bytes: 302a300506032b6570032100
const rawPubKey = Buffer.from(keyEntry.public_key, 'base64');
if (rawPubKey.length !== 32) {
  console.error(`Unexpected pubkey length: ${rawPubKey.length} (want 32)`);
  process.exit(1);
}
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const spkiDer = Buffer.concat([spkiPrefix, rawPubKey]);
const pubKeyPem = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
  .export({ type: 'spki', format: 'pem' });

// verifyEnvelope reconstructs envelope_hash, checks it, then verifies the
// signature over canonical(envelope with envelope_hash).
const result = verifyEnvelope(responseBody, (kid) => {
  if (kid !== keyId) throw new Error(`unexpected key_id ${kid}`);
  return pubKeyPem;
});
if (result.valid) {
  console.log('');
  console.log('SIGNATURE VERIFIED');
  console.log(`  envelope_hash: ${responseBody.envelope.envelope_hash}`);
  console.log(`  key_id:        ${keyId}`);
  console.log(`  alg:           Ed25519`);
} else {
  console.error('SIGNATURE INVALID:', result.reason);
  process.exit(1);
}
