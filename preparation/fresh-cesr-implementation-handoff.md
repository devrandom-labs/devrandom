# Fresh CESR task preparation checkpoint

E3 P/S/I preparation only. No Task creation, grant change, paid calls, Q evidence or winner claim.

Source: exact recorded repaired `src/lib.rs` from Run `82831e03-d936-4fd9-aad0-ee5d47e31c62`, SHA256 `6bd9282c598aa3d047ca2a18c280d193ce4073da905e576fa07e8885cd1a2f29`. Original frozen fixture unchanged. Fresh fixture: `fixtures/cesr-scoped-receipt-service`; fresh template `fixtures/cesr-scoped-compat.task.json`. Existing model/H1 template/workflow/budgets unchanged.

New module `packages/runtime/src/evaluation/application/cesr-public-contract.ts`: Evaluation application contract, depends inward on protocol types; owns complete original14/fresh31 public stimuli and native expected observations. Exact catalogue matching selects protected construction. The CLI adapter owns source/hash review, preserving all original pins. No caller-controlled oracle/profile flag reaches the sealer.

New native regression `cesr-scoped-oracle.integration.spec.ts`: application-boundary test only; compiles the real Rust API with31 public plus independently sealed trial/terminal expectations. Test-only reference lives outside candidate fixture in `tooling/fixtures/cesr-scoped-reference.rs`. Actual recorded flat repair fails; reference passes. Setting `DEVRANDOM_EVAL_IMAGE` to an exact sha256 image runs the same proof inside isolated nonroot, offline, read-only-source Docker containers. Without it this is host-native proof only.

Public materializer smoke passed:

```
nix develop -c just --command pnpm exec tsx tooling/cesr-receipt-fixture.ts /tmp/devrandom-cesr-scoped-source-review-20260926 scoped-groups
```

Local prepared source commit `40a3117dbf0b040f178eec4475b29d8c0354b735`, tree `474f4722d8ce5a1ee863dd75e3a16e0c77ef3ea6`. This only writes a local source checkout and Task template, not a hosted Task or grant.

Validation:

- Red: old catalogue rejects fresh source; old verifier bundle rejects legitimate large-frame public stimuli; old sealer does not select fresh protected cases.
- Green: eight narrow files,25 tests; includes original materializer regression, fresh fixture/native33-case replay, exact catalogue substitution, protected custody and original manifest sequencing.
- CLI and dependency builds PASS; workspace strict typecheck PASS; changed TypeScript lint PASS.
- `git diff --check` PASS.
- Docker native replay NOT RUN: serialized behind backup demo at lead request.
- Full `just check` NOT RUN: pending coordinated heavy gate.
- Q NOT RUN: proper bindings/profile/source/budget gates remain open. There is no evidence of repeatable unchanged-H1 failure.

Review finding still awaiting follow-up: `GitCesrPublicHistory` hardcodes that parser rejects non-Current versions; that assertion is false of this recorded repaired starting point. Must repair projection semantics before any C3 causal claim; do not invent a failure history. Lead notified, no unauthorized edit made.
