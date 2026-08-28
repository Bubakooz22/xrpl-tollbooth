# String escapes

Per RFC 8785 §3.2.2, only these control characters get short escapes:
\b \t \n \f \r \" \\ — everything else < U+0020 uses \uXXXX.
Characters ≥ U+0020 (including non-ASCII) pass through literally,
NOT as \uXXXX escapes.

This fixture proves an implementation escapes exactly the mandated
set — no more, no less. Over-escaping (e.g. \u0041 for "A") and
under-escaping (e.g. literal newlines inside strings) both break
digest agreement.
