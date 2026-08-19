import { Wallet } from 'xrpl';
import { x402Fetch } from 'x402-xrpl';

const seed = process.env.XRPL_BUYER_SEED || process.env.PAYER_SEED;
const url  = (process.env.TOLLBOOTH_URL || 'https://api.txnguardian.com')
           + (process.env.TARGET_PATH   || '/wallet-risk');
const body = process.env.REQUEST_BODY   || '{"address":"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh","chain":"xrpl"}';
const network = process.env.XRPL_NETWORK || 'xrpl:0'; // mainnet default; override to xrpl:1 for testnet

if (!seed) { console.error('XRPL_BUYER_SEED / PAYER_SEED missing'); process.exit(1); }

console.log(`=== x402 paid call ===`);
console.log(`URL:     ${url}`);
console.log(`Network: ${network}`);

const probe = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body });
console.log(`unpaid probe status=${probe.status}`);

const wallet = Wallet.fromSeed(seed);
console.log(`buyer:   ${wallet.classicAddress}`);
const fetchPaid = x402Fetch({ wallet, network });

const res = await fetchPaid(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body });
console.log(`paid response status=${res.status}`);
const bodyText = await res.text();
try {
  const parsed = JSON.parse(bodyText);
  console.log('body:');
  console.log(JSON.stringify(parsed, null, 2));
} catch {
  console.log('body:', bodyText);
}

const paymentResp = res.headers.get('payment-response') || res.headers.get('PAYMENT-RESPONSE');
if (paymentResp) {
  const decoded = JSON.parse(Buffer.from(paymentResp, 'base64').toString('utf8'));
  console.log('PAYMENT-RESPONSE:', JSON.stringify(decoded, null, 2));
  const txHash = decoded.transaction || decoded.txHash || decoded.hash || decoded.transactionHash;
  if (txHash) {
    console.log('PAID REQUEST SUCCEEDED');
    console.log('tx=' + txHash);
    const explorer = network === 'xrpl:0'
      ? 'https://xrpscan.com/tx/' + txHash
      : 'https://testnet.xrpl.org/transactions/' + txHash;
    console.log('explorer=' + explorer);
  }
} else {
  console.log('NO PAYMENT-RESPONSE HEADER FOUND');
}
