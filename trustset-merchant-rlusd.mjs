import { Client, Wallet } from 'xrpl';

const seed = process.env.XRPL_SEED;
const issuer = process.env.RLUSD_ISSUER || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const currency = '524C555344000000000000000000000000000000';
const limit = process.env.RLUSD_TRUST_LIMIT || '1000000';
const rpcUrl = process.env.XRPL_RPC_URL || 'wss://xrplcluster.com';

if (!seed) { console.error('XRPL_SEED missing'); process.exit(1); }

const wallet = Wallet.fromSeed(seed);
console.log('merchant address:', wallet.address);

const client = new Client(rpcUrl);
await client.connect();

const tx = {
  TransactionType: 'TrustSet',
  Account: wallet.address,
  LimitAmount: { currency, issuer, value: limit },
};

const prepared = await client.autofill(tx);
const signed = wallet.sign(prepared);
const result = await client.submitAndWait(signed.tx_blob);

console.log('hash:', result.result.hash);
console.log('TransactionResult:', result.result.meta.TransactionResult);
console.log(JSON.stringify(result.result, null, 2));

await client.disconnect();
