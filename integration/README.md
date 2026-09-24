# Local integration fixtures

The KERIA and witness configuration mirrors the integration topology exercised
by Signify-TS at upstream commit
[`5a174b5`](https://github.com/WebOfTrust/Signify-TS/tree/5a174b5456c2d256493f9991ac4ae73857ff4fce).
The service versions are pinned independently in `compose.yaml`; update these
fixtures only after rerunning the E0 identity compatibility proof.

Compose contains external integration services only: KERIA, demo witnesses,
the issuer, and disposable MongoDB. Pi, XState, Signify-TS edge clients, the
Run Supervisor, and all Task/Run domain code remain inside TypeScript
applications and packages.

These files contain public demo witness identifiers and endpoints only. They
must never contain issuer keys, KERIA boot credentials, salts, private signing
material, or production endpoints.
