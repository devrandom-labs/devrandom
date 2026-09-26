# Public CESR Receipt Group Compatibility Task

Keep `parse_receipt_stream(&str)` and its public result/error types. Read one complete CESR text-domain stream of top-level `-A##` generic pipeline groups. The two Base64 count digits give the number of quadlets (four-character units) in each group body. Reject truncated, extra, or malformed framing.

Each group contains one or more complete 44-character `E`-qualified URL-safe Base64 payload primitives. A group may begin with `-_AAABAA` (KERI/ACDC genus/version 1.00) or `-_AAACAA` (version 2.00). Without a marker, that group's version is 2.00. A marker applies only within its own group; the next group returns to the default. Return all payloads in stream order with their effective version. Reject unsupported markers, partial or malformed payloads, and non-CESR trailing content. Nested groups are outside this Task. These are framing checks, not cryptographic authenticity claims.

Run the current and tamper public tests before editing, then preserve their passing behavior while repairing legacy compatibility. After the first focused edit, call submit_result with the current work even if a public test fails; use verifier feedback for later revisions.

All requirements and tests are visible and immutable. Do not add dependencies, change tests/build configuration, or use network access. CESR source: https://trustoverip.github.io/kswg-cesr-specification/
