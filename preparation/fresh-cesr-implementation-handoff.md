# Fresh CESR task preparation checkpoint

E3 P/S/I preparation only. No Task creation, grant change, paid calls, Q evidence or winner claim.

Source: exact recorded repaired `src/lib.rs` from Run `82831e03-d936-4fd9-aad0-ee5d47e31c62`, SHA256 `6bd9282c598aa3d047ca2a18c280d193ce4073da905e576fa07e8885cd1a2f29`. Original frozen fixture unchanged. Fresh fixture: `fixtures/cesr-scoped-receipt-service`; fresh template `fixtures/cesr-scoped-compat.task.json`. Existing model/H1 template/workflow/budgets unchanged.

New module `packages/runtime/src/evaluation/application/cesr-public-contract.ts`: Evaluation application contract, depends inward on protocol types; owns complete original14/fresh31 public stimuli and native expected observations. Exact catalogue matching selects protected construction. The CLI adapter owns source/hash review, preserving all original pins. No caller-controlled oracle/profile flag reaches the sealer.

New native regression `cesr-scoped-oracle.integration.spec.ts`: application-boundary test only; compiles the real Rust API with31 public plus independently sealed trial/terminal expectations. Test-only reference lives outside candidate fixture in `tooling/fixtures/cesr-scoped-reference.rs`. Actual recorded flat repair fails; reference passes. Setting `DEVRANDOM_EVAL_IMAGE` to an exact sha256 image runs the same proof inside isolated nonroot, offline, read-only-source Docker containers, transferring source over streamed tar for remote Linux daemons. Without it this is host-native proof only.

Public materializer smoke passed:

```
nix develop -c just --command pnpm exec tsx tooling/cesr-receipt-fixture.ts /tmp/devrandom-cesr-scoped-source-review-v2-20260926 scoped-groups
```

Local prepared source commit `087d94c252e693a25a917fa1184fd4c2b761f668`, tree `a89b00f68e27f67d87827a151c32af3bb6335e98`. This only writes a local source checkout and Task template, not a hosted Task or grant.

Validation:

- Red: old catalogue rejects fresh source; old verifier bundle rejects legitimate large-frame public stimuli; old sealer does not select fresh protected cases.
- Green: nine narrow files,26 tests (25 initial plus C3 regression); includes original materializer regression, fresh fixture/native33-case replay, exact catalogue substitution, protected custody and original manifest sequencing.
- CLI and dependency builds PASS; workspace strict typecheck PASS; changed TypeScript lint PASS.
- `git diff --check` PASS.
- Docker native replay PASS at17:32UTC using pinned image `sha256:13dda7da2b6af646a9a0459641fd6d1763e711192110f9a92f7c2b9a04cc6cdd`: actual flat source executes and fails case14; independent reference passes all33 public/protected API cases. Two isolated containers were removed. Source is streamed by tar into root-owned read-only scratch source; executable target scratch is separate, nonroot/offline/read-only-root constraints retained.
- Lead reports merged main `a6d6a3a` full `just check` PASS:411files2244tests,142explicit skips, builds/public smokes/Darwin flake. The subsequent test-only remote Docker transport fix passed its native replay, lint and strict typecheck; no production bytes changed.
- Q NOT RUN: proper bindings/profile/source/budget gates remain open. There is no evidence of repeatable unchanged-H1 failure.

Approved follow-up repairs `GitCesrPublicHistory`: exact line-numbered source excerpts replace its false claim that the repaired parser rejects Legacy. Real clean Git/source/raw projection regression failed for that claim and now passes; substituted raw bytes remain rejected. Fresh large-boundary tests retain every assertion while emitting compact parse/length/per-receipt diagnostics. CLI rebuild, changed-source lint, strict typecheck and six affected narrow tests passed after this follow-up. Production changes passed the merged main full gate reported above; the remote-Docker test transport now has actual native proof.
