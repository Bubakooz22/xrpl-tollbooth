# Signing keys (do NOT commit contents)

This directory holds the Ed25519 signing keys used to sign v0.8 response envelopes.

## Layout

```
keys/
├── README.md                          # this file (committed)
├── .gitkeep                           # committed
├── tollbooth-2026-q3-01.private.pem   # mode 0600, NEVER committed
├── tollbooth-2026-q3-01.meta.json     # NEVER committed
├── tollbooth-2026-q2-01.private.pem   # retired key, still needed to verify old envelopes
└── tollbooth-2026-q2-01.meta.json
```

## meta.json shape

```json
{
  "key_id": "tollbooth-2026-q3-01",
  "status": "active",
  "valid_from": "2026-07-01T00:00:00Z",
  "valid_until": "2026-10-01T00:00:00Z"
}
```

Exactly ONE key file has `status: "active"`. All others are `"retired"`.

## Generating a new key

```bash
node -e "
import('./lib/envelope-signer.mjs').then(({ generateSigningKey }) => {
  const { publicKeyPem, privateKeyPem, publicKeyBase64 } = generateSigningKey();
  const fs = require('node:fs');
  const kid = 'tollbooth-2026-q3-01';
  fs.writeFileSync('./keys/' + kid + '.private.pem', privateKeyPem, { mode: 0o600 });
  fs.writeFileSync('./keys/' + kid + '.meta.json', JSON.stringify({
    key_id: kid,
    status: 'active',
    valid_from: '2026-07-01T00:00:00Z',
    valid_until: '2026-10-01T00:00:00Z'
  }, null, 2));
  console.log('active pubkey (b64):', publicKeyBase64);
});
"
chmod 700 ./keys
chmod 600 ./keys/tollbooth-2026-q3-01.private.pem
```

## Rotation procedure (quarterly)

1. Generate the new key with `status: "active"` and `valid_from` set to the
   start of the new quarter.
2. In the OLD key's `meta.json`, flip `status` to `"retired"`.
3. Restart the server.
4. Verify `/.well-known/tollbooth-keys.json` shows the new key as active
   and the old key as retired.

Retired keys stay on disk indefinitely so historic envelope signatures
remain verifiable.

## Filesystem permissions

- Directory: `chmod 700 keys/`
- Private PEMs: `chmod 600 keys/*.private.pem`

The `TOLLBOOTH_SIGNING_KEYS_DIR` environment variable overrides this location
(defaults to `./keys`).
