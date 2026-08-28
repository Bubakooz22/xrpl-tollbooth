# 19-signature-invalid — rejection: envelope signature invalid

An implementation MUST reject an envelope whose
`__sig` fails signature verification against the buyer's declared
public key. The rejection MUST happen before nonce lookup and before
budget check — signature verification is the first gate.

The failure mode this catches: state pollution from unauthenticated
input. If an implementation consumed the nonce and THEN verified the
signature, an attacker could force-consume a victim's nonce by
submitting a garbage-signed envelope with the victim's nonce.

The nonce_status remains "fresh" because the attempt failed before
reaching nonce lookup.
