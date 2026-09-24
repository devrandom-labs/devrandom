# CLI application

Owns the `devrandom` command experience, local profile interaction, locally held
identity material, browser registration initiation, and verification of
returned credentials. It does not own registration policy, credential
issuance, Tasks, Runs, Harness Revisions, or promotion law.

The CLI is the public product shell. It uses Commander and bounded structured
terminal output; it does not expose Pi's CLI, `InteractiveMode`, or RPC.
Identity admission must return `Ready` before the application constructs a Run
Supervisor, Pi `AgentSession`, resource loader, or active tool inventory. CLI
rendering consumes typed Devrandom projections and cannot invoke Pi directly.

The package exposes `dist/main.js` as its `devrandom` bin. Workspace installation
creates `node_modules/.bin/devrandom`; there is no separate shell launcher. The
identity commands create and maintain their owner-only custody and profile files
under `~/.devrandom` (or the explicit test-only state-directory override).
