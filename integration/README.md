# Local integration fixtures

The KERIA and witness configuration mirrors the integration topology exercised
by Signify-TS at upstream commit
[`5a174b5`](https://github.com/WebOfTrust/Signify-TS/tree/5a174b5456c2d256493f9991ac4ae73857ff4fce).
The service versions are pinned independently in `compose.yaml`; update these
fixtures only after rerunning the E0 identity compatibility proof.

Compose contains external integration services only: KERIA, demo witnesses,
the server, Atlas Local, and disposable MongoDB. Pi, XState, Signify-TS edge clients, the
Run Supervisor, and all Task/Run domain code remain inside TypeScript
applications and packages.

These files contain public demo witness identifiers and endpoints only. They
must never contain issuer keys, KERIA boot credentials, salts, private signing
material, or production endpoints.

## Atlas Local runtime

The pinned [MongoDB Atlas Local image](https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-docker/) provides MongoDB Search and Vector Search on this machine. The normal demo startup starts it with the server:

```sh
nix develop -c just up
curl --fail http://127.0.0.1:3211/ready/work
```

Only the product server receives `DEVRANDOM_ATLAS_LOCAL_URI`; host integration tests can use `127.0.0.1:27019`. Atlas Local persists its data in two named volumes with a stable replica-set hostname. The server accepts the local URI only for the named `atlas-local` service and exact database. The separate Compose MongoDB remains for adapter tests and other hosted state.

Check a real local vector index and query:

```sh
nix develop -c just test-atlas-integration
```

Atlas Local is the hackathon runtime and live demonstration path. Its real Vector Search index and queries must pass the same public acceptance checks as the server capability.
