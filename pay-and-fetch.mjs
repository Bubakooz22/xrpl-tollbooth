import { Wallet } from 'xrpl';
import { x402Fetch } from 'x402-xrpl';

const seed = process.env.PAYER_SEED;
const url = (process.env.TOLLBOOTH_URL || 'http://localhost:8787') + (process.env.TARGET_PATH || '/wallet-risk');
const body = process.env.REQUEST_BODY || '{"address":"rTest"}';

if (!seed) { console.error('PAYER_SEED missing'); process.exit(1); }

// Unpaid probe
const probe = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
console.log('unpaid probe: status=' + probe.status);

// Paid via t54 SDK's x402Fetch buyer wrapper
const wallet = Wallet.fromSeed(seed);
const fetchPaid = x402Fetch({
  wallet,
  network: 'xrpl:1',
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
    console.log('explorer=https://testnet.xrpl.org/transactions/' + txHash);
  }
} else {
  console.log('NO PAYMENT-RESPONSE HEADER FOUND');
}
