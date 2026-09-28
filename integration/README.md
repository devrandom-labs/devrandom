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

## Atlas Local development

The pinned [MongoDB Atlas Local image](https://www.mongodb.com/docs/atlas/cli/current/atlas-cli-deploy-docker/) provides MongoDB Search and Vector Search on this machine. Start it with the server overlay:

```sh
nix develop -c just integration-runtime-start
DEVRANDOM_ENV_FILE=.env nix develop -c just integration-atlas-local-up
curl --fail http://127.0.0.1:3211/ready/work
```

`compose.atlas-local.yaml` keeps the cloud URI in `.env` untouched and clears it from the local server container. Only the product server receives `DEVRANDOM_ATLAS_LOCAL_URI`; host integration tests can use `127.0.0.1:27019`. Atlas Local persists its data in two named volumes with a stable replica-set hostname. The server accepts the local URI only for the named `atlas-local` service and exact database. Cloud TLS and detailed index-readiness checks remain in force for the cloud binding.

Check a real local vector index and query:

```sh
DEVRANDOM_ATLAS_URI='mongodb://127.0.0.1:27019/?directConnection=true' \
DEVRANDOM_ATLAS_DATABASE=devrandom_prd03_local \
nix develop -c just --command pnpm exec vitest run packages/storage/src/e0/atlas-vector.integration.spec.ts
```

Atlas Local is a development deployment. It does not establish the managed Atlas demonstration required by the accepted hackathon stack.
