import { Client, Wallet } from 'xrpl';

const seed = process.env.PAYER_SEED;
if (!seed) { console.error('PAYER_SEED missing'); process.exit(1); }
const RLUSD_ISSUER = process.env.RLUSD_ISSUER;
if (!RLUSD_ISSUER) { console.error('RLUSD_ISSUER env var required'); process.exit(1); }

const RLUSD_CURRENCY_HEX = '524C555344000000000000000000000000000000';

const wallet = Wallet.fromSeed(seed);
const client = new Client('wss://xrplcluster.com');
await client.connect();

const trustSet = {
  TransactionType: 'TrustSet',
  Account: wallet.address,
  LimitAmount: {
    currency: RLUSD_CURRENCY_HEX,
    issuer: RLUSD_ISSUER,
    value: '1000000',
  },
};

const prepared = await client.autofill(trustSet);
const signed = wallet.sign(prepared);
console.log('Submitting TrustSet from ' + wallet.address + ' to issuer ' + RLUSD_ISSUER);
const result = await client.submitAndWait(signed.tx_blob);
console.log('TrustSet result:', result.result.meta.TransactionResult);
console.log('TrustSet hash:', result.result.hash);
console.log('Explorer: https://xrpscan.com/tx/' + result.result.hash);
await client.disconnect();
