# Fresh scoped CESR campaign — operator sequence, not a launch receipt

Prepared at 2026-09-26 17:35 UTC. No paid calls or hosted Task creation were performed by this preparation. The original rejected campaign remains immutable. The backup simulation is separate and is not Q/E3 evidence.

## Settled preparation

- Fresh fixture preserves actual H1 repair bytes, SHA256 `6bd9282c598aa3d047ca2a18c280d193ce4073da905e576fa07e8885cd1a2f29`.
- Final fixture source materializes as commit `087d94c252e693a25a917fa1184fd4c2b761f668`, tree `a89b00f68e27f67d87827a151c32af3bb6335e98`.
- Public31/protected2 real Rust API replay PASS on pinned Linux image `sha256:13dda7da2b6af646a9a0459641fd6d1763e711192110f9a92f7c2b9a04cc6cdd`. This is an oracle/fixture proof, not model qualification.
- Lead reports merged main `a6d6a3a` full `just check` PASS: 411 files,2244 tests,142 explicitly skipped tests, builds/public smokes/Darwin flake. The later test-only remote-Docker transport change has its own native proof and narrow checks; it does not change runtime bytes.
- Lead prepared a frozen-lockfile production runtime deployment at `/Users/joel/Code/devrandom/devrandom/.devrandom/prd03-runtime-a6d6a3a`, digest `sha256:8b9f9a0a50e900b969c4d0f7ffdce91ece7736850fc34f8727e4360f3e53f94f`. Digest record: `/private/tmp/devrandom-prd03-runtime-a6d6a3a-digest.json`. A live H1 profile and parent-death proof for the fresh Task are still required.

## Pending bindings — do not substitute invented values

| Name | Required actual value |
| --- | --- |
| `ACCEPTED_ROOT` / `ACCEPTED_COMMIT` | Clean accepted merged code and recorded gate commit. Rebuild/redeploy if production bytes change. |
| `CLI_ENV` / `USER_STATE` | Existing authorized owner identity environment/state, preserving historical usage. Never copy signing keys into source or OCI. |
| `REVIEWED_TASK_JSON` | Reviewed fresh **v2** Task source with new label, disclosed scoped source contract, exact Git binding and currently lawful budgets/expiry. |
| `RUN_QUOTA_APPROVAL` | Actual authority for owner Run ceiling8 instead of6, with corresponding accepted code/server/mandate law. This remains pending; an environment override or a JSON8 is not approval. |
| `OLD_RUN_CLOSURE` | Durable verified reconciliation/seal of original active Run, released active slots and resolved usage. A local process exit alone is insufficient. |
| `TASK_ID` / `TASK_REVISION_SAID` | Returned by actual fresh Task creation; never preinvent a hosted Task UUID. |
| `BUNDLE` | Newly generated and verified Linux H1 bundle for that exact Task/revision/source/runtime. |
| `RETAINED_RUN_ID`, `ACTIVE_H1_SAID`, `POLICY`, `M`, `CLOSURE` | Actual accepted later evidence; unavailable until the preceding stage succeeds. |

The committed fixture `.task.json` is a materializer **v1** template inherited from the original prepared fixture (3600 wall seconds,50 calls,$5). It is not the live v2 allocation. Do not silently promote those values or submit this template as the planned live experiment. Construct the reviewed v2 Task from the actual admitted original v2 ceilings: at most14400 Task wall seconds,256 requests,2500000 input tokens,500000 output tokens,$6,7200 aggregate child seconds,3000 tool proposals,256 changed files,16MiB changed source and128MiB Task evidence. Verify every value against the actual authority document. The only proposed ceiling amendment is owner Run count6→8; all other spending/resource ceilings stay unchanged. Copying the unapproved `/private/tmp/devrandom-fresh-campaign-review/task-proposed-not-authorized.json` is not authorization.

At the 17:35 review time the old proposed18:45 expiry leaves only70 minutes. The conservative profile plan is Q6×600 + D900 +15B×300 +F900 =9900 seconds (165 minutes), before continuity/publication headroom. The original four-hour wall ceiling is14400 cumulative seconds, not a renewal on each Run. Choose a newly reviewed absolute expiry covering remaining work and live mandate lifetimes, and reserve enough residual wall for E4–E6. Do not set expiry automatically to18:45 or raise14400. Actual Q usage reduces the D+15B+F reservation; if it no longer fits, stop. Provider-account balance and unresolved external charges must also be checked; new Task identity does not erase historical account spend.

## Non-paid source/runtime preparation

These commands write local preparation artifacts only. Use new destinations, never overwrite an existing source/profile.

```sh
ACCEPTED_ROOT=/Users/joel/Code/devrandom/devrandom
SOURCE_DIR=/private/tmp/devrandom-cesr-scoped-live-source
RUNTIME_DEPLOY=/Users/joel/Code/devrandom/devrandom/.devrandom/prd03-runtime-a6d6a3a
IMAGE=sha256:13dda7da2b6af646a9a0459641fd6d1763e711192110f9a92f7c2b9a04cc6cdd
cd "$ACCEPTED_ROOT"
nix develop -c just --command pnpm exec tsx tooling/cesr-receipt-fixture.ts "$SOURCE_DIR" scoped-groups
git -C "$SOURCE_DIR" status --porcelain=v1
git -C "$SOURCE_DIR" rev-parse HEAD 'HEAD^{tree}'
```

If accepted runtime code changes, create a NEW deploy directory after its gate; the verified pnpm12 command is:

```sh
nix develop -c just --command pnpm --filter @devrandom/runtime deploy --prod --frozen-lockfile "$NEW_RUNTIME_DEPLOY"
```

Recompute with the existing `digestEvaluationRuntimeMounts` owner and capture its receipt. Do not mount the main whole `node_modules/.pnpm` (previously>1GiB), widen digest limits, edit the lockfile, or reuse the prior runtime digest. The already prepared deploy above is the preferred current input if its exact bytes remain unchanged.

## Public CLI wrapper with fixed model

Fill `CLI_ENV`, `USER_STATE`, and later `BUNDLE` from actual local custody. Shell variables are deliberately required; no keys are printed. The outer Nix/Just command fixes the toolchain; the command's working directory remains the fresh source for exact Git admission.

```sh
fresh_cli() {
  : "${ACCEPTED_ROOT:?unbound}" "${SOURCE_DIR:?unbound}" "${CLI_ENV:?unbound}" "${USER_STATE:?unbound}"
  nix develop "$ACCEPTED_ROOT" -c just --justfile "$ACCEPTED_ROOT/justfile" --working-directory "$SOURCE_DIR" --command \
    env DEVRANDOM_USER_STATE_DIR="$USER_STATE" \
    DEVRANDOM_MODEL_PROVIDER=concentrate \
    DEVRANDOM_MODEL_ID=deepinfra/deepseek-v4-flash-0731 \
    DEVRANDOM_MODEL_THINKING_LEVEL=low \
    DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS=8192 \
    DEVRANDOM_MODEL_CREDENTIAL_SOURCE=CONCENTRATE_API_KEY \
    node --env-file="$CLI_ENV" "$ACCEPTED_ROOT/apps/cli/dist/main.js" "$@"
}
fresh_cli whoami
fresh_cli task list
```

Verify the credential-source value against accepted model configuration before use; this wrapper does not change the actual credential. Explicit model variables override an env file's stale `bluelobster/gpt-oss-20b` configuration. Never rotate models on failure. Do not source an env file as shell code or print it.

## Launch only after P/S/B authority and old closure are settled

1. Independently verify current hosted usage, owner remaining Run slots, old Run closure, accepted quota amendment, source/disclosure rights and actual prepaid provider capacity. No automatic retries against an unresolved original effect or missing permission.
2. Review `REVIEWED_TASK_JSON` fields against the fresh fixture and actual original v2 authority. Its new label/title/objective/source contract must refer to scoped groups; retain identical model/H1/tools and finite consumable ceilings. Persist reviewed absolute expiry and stable new label. Use the real source directory above.
3. Only then create the new Task:

```sh
: "${REVIEWED_TASK_JSON:?unbound reviewed v2 Task source}"
fresh_cli task create "$REVIEWED_TASK_JSON"
fresh_cli task inspect "$TASK_LABEL"
```

Bind `TASK_ID` and `TASK_REVISION_SAID` from these accepted outputs. Do not proceed on denial/conflict/expired authority.

4. Build a fresh exact H1 profile and real cleanup receipt using the reviewed existing helper. It hardcodes the required `concentrate / deepinfra/deepseek-v4-flash-0731 / low /8192` configuration. The helper's draft placeholder receipt IDs are only transient probe inputs; its final bundle must contain actual observed effective-limit and parent-death receipts. It spawns a real parent-loss probe and checks both worker/native containers disappear. Never substitute prerecorded success.

```sh
: "${TASK_ID:?unbound accepted Task UUID}" "${BUNDLE:?unbound new profile destination}"
test ! -e "$BUNDLE"
cd "$ACCEPTED_ROOT"
nix develop -c just --command node /private/tmp/devrandom-prd03-h1-bundle.mjs \
  "$ACCEPTED_ROOT" "$SOURCE_DIR" "$REVIEWED_TASK_JSON" "$TASK_ID" \
  "$RUNTIME_DEPLOY" "$BUNDLE" "$IMAGE"
```

Reviewed helper SHA256: bundle `811f23893da8c3fbdf5a9f362d42c57b74bc56709d26f0b1939ba91c5ec446ae`; `/private/tmp/devrandom-prd03-parent-loss.mjs` `01f1bf63b62aa70f90c2159ab581961be239cba740d6d4f4e973ce6c33ffba04`. If either changes or is unavailable, re-review/recover its actual probe logic before use. Check generated task revision exactly equals accepted `TASK_REVISION_SAID`; exact source commit/tree/model/runtime digest/image must match. No fake Task, copied old profile or synthetic cleanup receipt.

5. Export the new bundle into the fixed wrapper environment and invoke the public campaign once:

```sh
export DEVRANDOM_LINUX_H1_BUNDLE="$BUNDLE"
fresh_cli task run "$TASK_LABEL"
```

`task run` performs ordinary Task/Promotion mandate preparation and H1 admission and owns the five-calibration/sixth-retained sequence. There is no separate invented mandate CLI command. Inspect its accepted personal-agent/Governor/Task mandate attribution, budgets and H1/profile bindings. Do not shell-loop six independent campaigns. Restart only through the same durable campaign path after reconciliation. H1Passed/different category rejects this campaign; no reset, model switch or task escalation.

## Only after real Q

Five sealed acknowledged calibrations must contain≥4 identical clean compatibility failures and≤1 lawful exclusion; a distinct sixth retained Run must reproduce failure with Task Open and H1 active. Capture real checkpoint/seal/raw verifier receipts. Infrastructure, context exhaustion, partial/unsealed/unknown-cost runs cannot count.

```sh
fresh_cli task status "$TASK_LABEL"
fresh_cli harness source-inventory "$TASK_LABEL" --from-run "$RETAINED_RUN_ID" \
  --profile-said "$PROFILE_SAID" --active-revision-said "$ACTIVE_H1_SAID" --output-dir "$REVIEW_DIR"
```

Use exact recorded inventory/profile and actual residual consumables to prepare the existing closed policy file; `/private/tmp/devrandom-fresh-campaign-review/allocation-proposal.json` is an unbound plan, not admission. Refresh its scope/Task/mandate/exposure identities and verify budget equality before Research. Keep D+15B+F,18 coding rollouts and15 measurements unchanged.

```sh
fresh_cli harness evaluate "$TASK_LABEL" --from-run "$RETAINED_RUN_ID" --policy "$POLICY"
```

A truthful Closed evidence-only result leaves H1 active. Use actual Evaluation/M/closure for `harness promote --evaluation ... --closure ... --command-id ... --confirm-manifest ...`; do not substitute the backup's artifacts or fabricate a winner. Then the ordinary `task resume --run ... --pause-after-checkpoint`, external SIGKILL after its actual checkpoint, `task resume`, immutable `task verify`, and publish/fetch/fork flow remains required. A null comparison or missing acknowledgement blocks all H2-dependent claims.

## E4–E6 read-only prerequisite audit

The fresh31-condition catalogue is carried in the locked verifier bundle. E4 `local-evaluation-promotion.ts` reopens that exact M/bundle and passes it into protected regrading; E5 `TerminalSourceVerification` loops `bundle.publicConditions` and uses the M-bound `terminalCase`. Neither path hardcodes fourteen old conditions. Terminal native calls reserve/commit actual parent-verifier child budget. `task verify` inspects the accepted immutable submission/receipt and does not reopen the holdout for coaching. These are code findings, not a live E4/E5 proof.

Important remaining publication contingency: the pre-M proposal prompt permits evidence-derived C1 wording, but `safePortableInstruction` currently accepts only four exact reviewed sentences. A lawful C1 winner with different wording will fail publication safely. Do not prefer C2/C3, mutate the winning C1 or whitelist it automatically to make E6 succeed. That semantic sanitation gap needs an independently reviewed solution if C1 wins. C2's exact structured workflow and C3's parameterized context policy currently match their publication translators and do not embed old fixture case counts.

The portability adapter uses a fixed clean Node `PUBLIC-V1` reference and checks transferred instruction/workflow/context mechanics. This is not another live-model CESR performance experiment and must not be described as one. Clean-profile fetch requires its own initialized Signify/KERIA custody and publisher OOBI resolution; copying the publisher state/signing keys is forbidden. Publication/fork retries need stable command UUIDs and exact package SAID, not aliases or a freshly regenerated command on each retry.
