import { Wallet } from 'xrpl';
import { x402Fetch, defaultPaymentRequirementsSelector } from 'x402-xrpl';

const seed = process.env.PAYER_SEED;
const url = (process.env.TOLLBOOTH_URL || 'http://localhost:8787') + (process.env.TARGET_PATH || '/wallet-risk');
const body = process.env.REQUEST_BODY || '{"address":"rTest"}';
const RLUSD_ASSET = '524C555344000000000000000000000000000000';

if (!seed) { console.error('PAYER_SEED missing'); process.exit(1); }

// Unpaid probe
const probe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
console.log('unpaid probe: status=' + probe.status);

// Paid via t54 SDK's x402Fetch buyer wrapper, forcing selection of the RLUSD accept entry.
const wallet = Wallet.fromSeed(seed);

// Custom selector: prefer the RLUSD (IOU) payment requirement over the default (which picks
// the first network/scheme-matching candidate — here that would be XRP). Falls back to the
// SDK's defaultPaymentRequirementsSelector if no RLUSD entry is present, so this script fails
// loudly instead of silently paying in XRP.
const rlusdSelector = (accepts, networkFilter, schemeFilter, maxValue) => {
  const candidates = accepts.filter((a) => a.asset === RLUSD_ASSET);
  if (candidates.length === 0) {
    console.error('no RLUSD accept entry found in accepts[]; falling back to default selector');
    return defaultPaymentRequirementsSelector(accepts, networkFilter, schemeFilter, maxValue);
  }
  return candidates[0];
};

const fetchPaid = x402Fetch({
  wallet,
  network: process.env.XRPL_NETWORK || 'xrpl:0',
  paymentRequirementsSelector: rlusdSelector,
});

const res = await fetchPaid(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
console.log('paid response: status=' + res.status);
console.log('body:', await res.text());

const paymentResp = res.headers.get('payment-response') || res.headers.get('PAYMENT-RESPONSE');
if (paymentResp) {
  const decoded = JSON.parse(Buffer.from(paymentResp, 'base64').toString('utf8'));
  console.log('PAYMENT-RESPONSE:', JSON.stringify(decoded, null, 2));
  const txHash = decoded.transaction || decoded.txHash || decoded.hash || decoded.transactionHash;
  if (txHash) {
    console.log('PAID REQUEST SUCCEEDED');
    console.log('tx=' + txHash);
    console.log('explorer=https://xrpscan.com/tx/' + txHash);
  }
} else {
  console.log('NO PAYMENT-RESPONSE HEADER FOUND');
}
