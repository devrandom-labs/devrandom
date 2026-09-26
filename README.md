# Devrandom

Governed harness evolution for long-horizon coding agents.

The hackathon architecture is locked in
[docs/hackathon-decision.md](docs/hackathon-decision.md). Read that document before
designing or implementing the prototype.

## Document map

1. [Hackathon decision](docs/hackathon-decision.md) — canonical product and
   architecture contract.
2. [Demo specification](docs/harness-demo.md) — required live journey and visible
   proofs.
3. [Technology stack](docs/hackathon-tech-stack.md) — accepted TypeScript prototype
   architecture.
4. [Implementation hypotheses](docs/implementation-hypotheses.md) — retained,
   rejected, and still-unmeasured claims.
5. [Execution contract](docs/execution-contract.md) — dependency-ordered work,
   acceptance evidence, and stop conditions.
6. [Implementation checklist](docs/hackathon-changes.md) — ordered delivery work.
7. [Product requirements](docs/harness-logic.md) — broader requirements and research
   rationale.
8. [Agent harness research audit](docs/research-audit.md) — dated external-source,
   repository, and technology audit; advisory rather than architectural authority.
9. [Implementation TODO](docs/todo.md) — living progress checklist and planned
   technology additions; it does not override the architecture decision.

The subordinate [initial issuer PRD](docs/issuer-initial.md) defines the
persistent issuer bootstrap/serve lifecycle and its type-safety boundary.
The [PRD 01 identity journey](docs/identity-initial.md) is implemented. The subsequent
[PRD 02 authenticated-work journey](docs/02-authenticated-work-execution.md)
defines the post-identity Devrandom Server migration, first Task/Run path, and
baseline execution boundary; its implementation remains blocked on PRD 01
acceptance.

Post-hackathon architecture and expansion ideas are isolated under
[docs/future](docs/future/README.md) and are not part of the active plan.

Repository-specific implementation constraints are in [AGENTS.md](AGENTS.md).

## Development environment

The repository does not support an ad-hoc host Node.js installation. Nix owns
the executable toolchain, the pnpm lockfile owns JavaScript dependency
resolution, and Just owns repository commands.

```sh
direnv allow
just bootstrap
just check
```

Without direnv, enter the same environment explicitly:

```sh
nix develop
just bootstrap
just check
```

Do not use host `npm`, `npx`, or globally installed TypeScript tools. Update
`flake.lock`, `package.json`, or `pnpm-lock.yaml` only as a deliberate
dependency change with its compatibility evidence.

## Workspace ownership

```text
apps/
  cli/       local identity custody and the devrandom command experience
  site/      browser registration and read-only presentation

services/
  server/    Devrandom Server composition with issuer and registration contexts

packages/
  domain/    product states, transitions, and laws
  protocol/  versioned cross-application wire schemas
  identity/  Signify-TS and KERIA adapters
  runtime/   XState Run supervision, Pi adapter, evidence, context, and tools
  storage/   MongoDB and Atlas Vector Search adapters
```

Deployable applications and services never import one another. Shared behavior
belongs to the package that owns its invariant; browser, CLI, HTTP, KERI, and
MongoDB adapters do not create competing task, mandate, harness, or evaluation
models.

The proven issuer composition is one bounded context inside a single Fastify
Devrandom Server alongside hosted access, work admission, evidence ingestion,
and read-only Task and Run queries. Experience retrieval, signed activation
commit, and publication admission are later server capabilities. Only the
server receives the Atlas connection string. Pi, XState, candidate workers,
protected evaluation, tamper audit, promotion selection, and the Governor key
remain in the trusted local CLI control plane.

The public terminal product is the Commander-based `devrandom` CLI. Identity
admission completes before the work runtime is constructed. Pi supplies the
embedded provider/model loop and Pi Agent Sessions; XState realizes live Run
Incarnations beneath the Run Supervisor. A durable Task, a governed Run, a Pi
Agent Session, and a Registration Session are different lifecycles. Pi's CLI,
`InteractiveMode`, and RPC are not product boundaries, and the core uses plain
structured terminal output rather than a full-screen TUI.

## Runnable boundaries

The selected application stack is Next.js App Router, Material UI, RTK Query,
and Fastify with generated OpenAPI. Repository policy rejects competing stack
dependencies and imports.

Inside `nix develop`, run each boundary with:

```sh
just run-cli
just run-server # http://127.0.0.1:3211/health
just run-site   # http://127.0.0.1:3210
```

`just smoke` exercises all three public boundaries after a build. `just
openapi` regenerates the committed server contract.

## Local integration

Docker Compose supplies only the external integration environment: MongoDB,
the demo witnesses, KERIA, and the Devrandom Server.
Pi, XState, candidate workers, protected governance, and the CLI itself remain
host-side and are never Compose services.

The service-side `.env` is read only by `just up` and Docker Compose. The CLI
does not load it and never receives Atlas configuration or the issuer bran. The
complete demonstration is:

```sh
just up
devrandom init
just down
```

The CLI model configuration is a separate caller-supplied environment. For the
PRD 02 runtime, put `CONCENTRATE_API_KEY` and the five non-secret
`DEVRANDOM_MODEL_*` values in the ignored, owner-readable `.env.cli`, then source
it explicitly in each shell that invokes the CLI or the PRD 02 journey:

```sh
chmod 600 .env.cli
set +x
set -a
. ./.env.cli
set +a
nix develop -c just test-prd02-journey
```

The pinned profile is provider `concentrate`, model
`deepinfra/gemma-4-e4b`, a supported Pi thinking level, at most 32768 output
tokens, and credential source
`CONCENTRATE_API_KEY`. Neither the CLI nor Just automatically loads `.env.cli`,
and its values must not be passed to Compose services or child tool commands.

`just up` installs the workspace, which exposes the package-declared
`devrandom` executable through `node_modules/.bin`, builds the deployables, and
starts the health-gated Compose services. Before reporting readiness it runs
`devrandom status`, which compares the issuer's public AID, OOBI, registry, and
schema to the CLI's compiled demonstration expectations. `devrandom init`
creates its own owner-only identity directory and files under `~/.devrandom`;
no CLI config file or environment handoff is prepared by `just up`.

`devrandom whoami` and `devrandom identity rotate` require a continuous,
SAID-bound inception-to-current KEL with exact predecessor links. They verify
the configured witness policy and the current receipt indexes reported by
KERIA; KERIA remains the protocol component that validates the witness receipt
signatures themselves.

From `nix develop`, the supported macOS path is:

```sh
just integration-runtime-start
just integration-up
just integration-health
```

On Linux, `integration-runtime-start` verifies the existing Docker daemon
instead of starting a second one. The remaining lifecycle is:

```sh
just integration-logs
just integration-reset # removes only this Compose project's named volumes
just integration-down
```

`just test-integration` performs a bounded health-gated startup, exercises the
public issuer, KERIA, and witness endpoints, and always removes its containers
and disposable volumes. Copy `.env.example` to the ignored service-only `.env`,
set `DEVRANDOM_ISSUER_BRAN`, and run `chmod 600 .env`. The bran is the issuer's
private bootstrap secret; never commit or pass it to the CLI. Port and Compose
project overrides also belong there.
