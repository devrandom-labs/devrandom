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

Presentation polish (2026-09-26): cyan headings, colored outcomes, staggered
scenario output, natural commands, one opening disclosure, and a separate
working directory for real Task creation. `demo.md` is the copy-and-paste guide;
`recorded-demo.md` preserves the previous fixture setup instructions.

- Public presenter regression and selected-repository subprocess regression
  each failed before their changes and now pass.
- Real terminal entry completed the entire scenario with ANSI colors and
  staggered output. Real `whoami` returned `Identity Ready`, `ExistingIdentity`,
  exit 0 through the existing CLI and current server.
- Final `just check` PASS: 419 files / 2377 tests, 145 skipped; all builds,
  CLI/server/site smokes, and Darwin flake check passed. Incompatible Linux
  flake check NOT RUN. Log: `/private/tmp/devrandom-terminal-polish-final-check.log`.
- Creating the presentation Task through the server is NOT RUN; its local JSON
  is prepared and the guide requires explicit operator confirmation.
