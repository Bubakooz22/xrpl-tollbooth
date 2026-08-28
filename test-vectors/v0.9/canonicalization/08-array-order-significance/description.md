# Array order IS significant

Unlike object keys, arrays are ORDER-DEPENDENT. This is a NEGATIVE
fixture: input-a and input-b differ only in array order, and they
MUST produce DIFFERENT digests. An implementation that sorts array
elements is broken.

The expected-digest.txt contains the digest of input-a; input-b's
digest is written to expected-digest-b.txt so implementers can
verify both directions.
