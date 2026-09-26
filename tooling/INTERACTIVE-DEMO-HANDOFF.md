# Interactive CLI backup

Advances the requested PRD03 demonstration slice: user-directed inspection and
recovery/authority/publication presentation. The presenter is disposable tooling
composition; the simulation module owns only ephemeral presentation state. Neither
owns production Task, harness, authorization or evidence truth. Real operations
cross the existing public CLI boundary through the allowlisted adapter. No new
runtime architecture, browser, service, provider or database interface is added.

Caller regressions cover explicit mutation confirmation, live failure without
simulation fallback, and the complete independently selected simulated journey.
The simulation's original missing-module regression was red before implementation.

Validation in the isolated presenter worktree:

- 15 focused tests PASS (presenter, simulation, adapter, recorded presenter).
- Scoped ESLint, Prettier, workspace TypeScript check and diff whitespace PASS.
- Actual `just demo-prd03` terminal entry through simulated fork PASS.
- Actual live `--help` through the presenter and built CLI adapter PASS, exit 0.
- Adapter owner built CLI and its package dependencies successfully.
- Full `just check`: PASS, 419 test files / 2375 tests; 41 files / 145 tests
  explicitly skipped. All workspace builds, CLI/server/site public smokes and
  native Darwin Nix flake checks passed. First run found the fresh checkout
  lacked the installed CLI build; built CLI and reran the complete gate.
- No Docker, paid provider, Task creation, credential mutation or Atlas writes run.

`just demo-prd03` is now interactive. `just demo-prd03-recorded` retains the
previous proof playback. The `proofs` command delegates to the existing hash
verification reader; it never substitutes simulation when reports are missing.
