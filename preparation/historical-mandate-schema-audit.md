# Historical mandate schema compatibility audit

2026-09-26. Read-only source audit at `9bb3a6f6bec5427761e43ba5ee6f3d7cc3bd76e0`.
Sibling worktree observations are in-progress snapshots, not integrated behavior.
No production/test/schema changes, private custody reads, or live mutations.

**Finding:** widening the PRD03 owner Run allowance from 6 to 8 changes THREE
credential schema identities. Existing signatures remain cryptographically bound
to their original bytes; current application allowlists stop recognizing those
credentials. Merely retaining their JSON files does not fix verification.
The new historical cancellation composition avoids mandate verification entirely
and retains exact original credential bindings; it does not need renewed authority.

Scope: E1 exact mandate bindings and E2 sealed truthful evidence, supporting the
E3 qualification gate (execution-contract acceptance; hackathon checklist 3, 10,
11). Protocol owns immutable schema identity, Identity owns cryptographic evidence,
Mandate owns current authority, Evidence/Run own historical sealing and cancellation.
No deferred execution/promotion boundary is opened by this audit.

## Exact public artifacts

Each old/new pair was verified with pinned Signify `Saider.verify(schema, true,
false, undefined, '$id')` through `nix develop -c just --command node`.
Sibling artifact diffs contain only `runsPerAdmittedUser.maximum: 6 -> 8` and `$id`.
Spend/token limits are unchanged in these artifact diffs. This does not certify
the rest of the quota implementation.

| Artifact under `schemas/` | Original SAID | Observed widened SAID |
| --- | --- | --- |
| `devrandom-task-mandate-v2.json:386` | `EOY8HBroEjfQNrCcePMlfVbP-nb1n4cEphePUB4X_KCZ` | `EKVur3gden7nXXSrtI-TfafFTwgJ7i43U719lmswgLM8` |
| `devrandom-promotion-mandate-v2.json:386` | `EKJIBacKPWlMuJFCmmcq4rHZWUnMEBc8PicQRFOCMvkD` | `EPuAJm_fUjIBtIvZSvZrMNkqa4TfqhaJO-Xxg1GpKuh4` |
| `devrandom-promotion-mandate-v3.json:491` | `EAQCbiVS9-JfwXwYHEgNCOryzg9Aq1ft1m98u_5TP742` | `ELgjxunSnMV5UaQWGQYCnb8ESebSba32WH1TiruYTsF2` |

Original committed file fingerprints (pretty JSON including final newline):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Task v2 | 11472 | `6a1fd666199cc2c3fe3882c6abeb12d64ff4f79aba5f44827d7ff3700eb7626f` |
| Promotion v2 | 11368 | `54adc138a4ae5f5c3152e403e78cb94c29f85420db937d902196ee0bff8d5ce6` |
| Promotion v3 | 14172 | `6a64b3b8c87587ce09a16b02a75b56362d43615743a8bac3bdbd232a3f68a3ca` |

V1 remains unchanged in the sibling artifacts: Task
`EA1IvABDQ7L9XtBkLtJmw4ouzR3ie3a_C6oAKpVPqKyk`, Promotion
`EHL1THTMidi0ibU-Yuw9mOzUyxg0G5eBwmqJsnbFDp-s`.
SAIDs bind serialized schema content, not the pretty file's whitespace. Preserve
property order and original documents; do not serve widened content at old `$id`.

## Exact failure gates

Paths below are relative to this audit worktree unless marked otherwise.

1. **Generated schema identity.**
   `packages/protocol/src/mandate/mandate-credential.ts:76`, `:124`, `:135`
   embed/inherit `taskEvaluationBudgetsSchema`; `:214`, `:253`, `:272` saidify
   those definitions. `packages/protocol/src/task/task-command.ts:305` imports
   the mutable task budget shape. The generator
   `services/server/src/credential-schema-artifact.ts:24` overwrites named files.
   Promotion v2 is affected even if attention is focused on exact-M v3.

2. **Protocol recognition.**
   `packages/protocol/src/mandate/mandate-credential.ts:622`, `:658`, `:675`
   require the current schema SAID after shape validation. Old 6-valued credentials
   still fit the widened shape but return `UnexpectedSchema`. Changing `s` would
   invalidate credential `d` and its issuance/anchor bindings; never rewrite it.
   Canonical order, attribute SAID, and credential SAID checks must all remain.

3. **Independent identity allowlists and current-authority gates.**
   `packages/identity/src/mandate-credential.ts:200`, `:232`, `:282`, `:301`
   decode and independently pin schema identity (including exact-M inspection).
   `:148` verifies credential, issuance/registry, anchor, resolved schema SAID,
   schema-to-credential equality, TEL state, and issuer KEL evidence.
   `packages/identity/src/mandate-exchange.ts:1511`, `:1698` pin schemas again.
   Fixing one decoder alone is insufficient.
   Application expected-schema pins also exist at
   `apps/cli/src/mandate/application/task-mandate-authorization.ts:761`, `:793`, `:810`;
   `apps/cli/src/run/infrastructure/signify-task-tool-mandate.ts:102`;
   `apps/cli/src/evolution/infrastructure/signify-current-experience-mandate.ts:88`;
   `apps/cli/src/promotion/infrastructure/signify-exact-promotion-authority.ts:136`, `:151`;
   `services/server/src/mandate/application/mandate-acceptance.ts:81`, `:233`, `:384`;
   `services/server/src/activation/infrastructure/keria-activation-authority.ts:211`.
   Domain checks at `packages/domain/src/mandate/mandate-verification.ts:270`,
   `:293`, `:322` retain exact schema equality, revocation, and expiry. Historical
   recognizability must never mint a `CurrentTaskMandate` for an expired Task.

4. **Publication and resolution.**
   `services/server/src/route/schema-oobi-route.ts:25` serves only compiled current
   schemas as compact JSON buffers. An old `/oobi/<said>` becomes 404 after replacement.
   `packages/identity/src/credential-schema.ts:57` fetches the exact expected ID,
   verifies its SAID, and resolves OOBI only for that ID's 404. Mandate inspection
   at `packages/identity/src/mandate-exchange.ts:1111`, `:1152` fetches the credential's
   actual `s` from KERIA but has no on-demand missing-schema resolution fallback.
   A populated KERIA cache can hide the resolution defect, not the local decoder defect.
   Local schema preparation at `:1571` prepares current v1/v2; exact v3 resolves on
   issuance at `:1595`. Server startup at `services/server/src/main.ts:665`
   listens then resolves current schemas; failure closes the listener. Readiness
   at `:637` verifies current schemas only. Coordinate deployment/OOBI availability
   with parent; do not restart the demo from this audit.

5. **Retry/custody risk beyond verification.**
   `packages/identity/src/mandate-exchange.ts:649` selects issuance schema from
   claims using current constants; `:739` rejects a different `s` during stable
   reconciliation; `:896` filters out nonmatches and `:926` can return `NotFound`.
   `:958` also expects the newly computed schema when observing completed issuance.
   Thus an interrupted old issuance can stop matching and risk a second issuance
   if its caller retries submission. Archive support must cover reconciliation,
   not just inspection. Preserve ambiguity rejection, exact claims, and original SAIDs.
   `apps/cli/src/mandate/domain/task-authorization.ts:24` and
   `apps/cli/src/mandate/infrastructure/task-authorization-file.ts:59` persist
   credential SAID, issuance time, operation and grant/admission references—not
   schema bytes or a frozen issuance schema choice. Actual credential evidence is
   retrieved from KERIA. File read at `:299` enforces ownership/mode/no-symlink and
   validates records without making them current authority. Server presentations
   are keyed by owner/credential and grant, not replaceable schema aliases
   (`services/server/src/mandate/infrastructure/mongo-mandate-presentations.ts:30`).

## Historical cancellation path

Read-only inspection of `../devrandom-prd03-campaign-audit/` found:

- `apps/cli/src/mandate/infrastructure/signify-local-mandate-authority.ts:70`
  implements `historicalEvidenceSeal`: reads existing custody/profile, checks
  owner/controller/KERIA-agent/witness binding, and connects only evidence sealing.
  It does not call `establish`, prepare schemas, provision identities/registry, or
  issue/inspect mandates. Keep that separation.
- `apps/cli/src/run/composition/cancel-expired-calibration.ts:25` checks expired
  owned Task and exact Run; `:37` requires persisted Ready authorization; `:48`
  reads exact accepted H1; `:56` checks original principals/registry; `:82` passes
  original credential SAIDs. `run/composition/terminal-calibration.ts:98` compares
  both mandate SAIDs and principals against the durable Run. Historical schema
  decoding is not on this path. A missing/insecure record, unavailable H1, changed
  signer, or different stored mandate must block rather than renew authority.
- `packages/identity/src/evidence-seal-exchange.ts:143` connects an existing
  controller (no bootstrap); `:218` gets the sender alias and verifies the prepared
  exchange against the expected agent, recipient, payload and SAID. Alias/key/OOBI
  availability remains a real dependency. Generic caught `Unavailable` can obscure
  its cause; inspect boundary evidence without logging secret material.
- Server `services/server/src/evidence/application/reconcile-evidence-seal.ts:80`
  constructs the seal expectation from the persisted Run/cursor, including the
  original mandate SAID, then verifies the agent exchange before transactional
  commit. It does not require current mandate inspection. HTTP still requires a
  current owner's `evidence:seal` grant (`evidence/route/evidence-routes.ts:835`).
  Campaign server `evidence/application/terminal-calibration-reconciliation.ts:172`
  additionally checks Task expiry/no accepted submission for cancellation. Keep
  exact cursor/checkpoint/incarnation and recorded-write checks; never classify
  cancellation as compatibility confirmation.

This is a source-based assessment, **not proof that Run2 can presently cancel**.
No private Run2 custody, actual hosted state, or KERIA connection was inspected.
Old H1/Task/Run projections also need to decode after the quota merge; widening
maximums should accept 6, but regression fixtures must preserve original SAIDs.

## Recommended implementation handoff

For this narrow allowance change, use an **additive immutable schema catalog**:

1. Freeze the three original public documents above under their exact SAIDs before
   regeneration. Add the three widened documents as distinct identities. Serve
   both sets, verify every catalog entry's self-addressing, and test byte fingerprints.
   Do not derive archived schemas from mutable current budget constants.
2. Select validation by credential `s` through a closed catalog mapping to exact
   schema/family/claim semantics; validate against the selected schema, not a broad
   union or widened shape. An old-schema credential re-signed with allowance 8 must
   still fail. Preserve canonical rebuild, all SAIDs, TEL/anchor checks, exact-M
   requirements, expiry, resource/capability/budget law. Update every gate above
   needed by supported historical inspection/current verification consumers.
3. Resolve accepted historical IDs from trusted server OOBIs when unavailable;
   prove both cold-cache resolution and warm-cache integrity failure behavior.
   Serving archives alone is insufficient. Never follow arbitrary credential URLs.
4. Freeze schema choice in new durable issuance intent and reconcile old pending
   intent against recognized historical schemas plus exact stable claims. Never
   treat schema drift as permission to reissue, modify expiry, or migrate old Run
   bindings. Fresh allowance8 authority belongs to freshly approved Task/mandates.
5. Keep Run2 cancellation on the existing-signer evidence path above. It must not
   enter mandate establishment as a fallback. Schema archival is preservation of
   evidence, not authorization to execute the old Task.

Explicit next credential versions are the cleaner alternative if product versions
must identify one permanent schema. Freeze current Task v2 and Promotion v2/v3,
introduce distinct new Task and initial/exact Promotion schema variants, and update
issuance/protocol consumers deliberately. Do not conflate initial Promotion v2
with exact-M v3. This is broader than archival because version dispatch and durable
issuance intent also change; it still needs old schema serving, inspection and
retry coverage. Neither approach permits replacing an existing SAID's bytes.

## Regression-first tests and commands

Implementer should add public-boundary cases before code:

- Frozen original credentials for all three schemas still decode/inspect after
  widening. New credentials decode under distinct schemas. Reject unknown schema,
  old-SAID/new-content substitution, allowance8 under the archived ceiling6 schema,
  changed credential/attribute SAIDs, issuer/subject/registry/resource mismatch,
  missing anchor, revoked TEL, and expired current authorization. Preserve exact-M.
- Old and new OOBI GETs return correct ordered content and verify against requested
  IDs; old documents retain the fingerprints above; unknown ID is 404. Cold KERIA
  resolution works for archived schemas; corrupted cached schema fails closed.
- Old interrupted issuance reconciles to the original credential/operation, never
  `NotFound` or a duplicate; fresh issuance binds the new ID; conflicting multiple
  matches fail. Persisted Ready authorization and original H1/Run bindings survive.
- Historical expired cancellation uses the original SAIDs, never calls principal
  provisioning/mandate establishment/issuance/provider execution, seals exactly once,
  survives lost replies, rejects wrong owner/signer/cursor/mandates/worktree, and
  leaves ordinary expired execution and promotion forbidden. Run the composed path
  after integrating BOTH sibling changes, not only a mocked signer unit test.

Build prerequisites: `nix develop -c just build-package @devrandom/domain`, then
`@devrandom/protocol`, then `@devrandom/identity`; implementation owners additionally
build affected `@devrandom/cli` and `@devrandom/server` (and runtime prerequisites).
For each path below run `nix develop -c just test-file <path>`:

```text
packages/protocol/src/mandate/mandate-credential.spec.ts
packages/identity/src/credential-schema.spec.ts
packages/identity/src/mandate-credential.spec.ts
packages/identity/src/mandate-exchange.spec.ts
packages/identity/src/evidence-seal-exchange.spec.ts
packages/domain/src/mandate/mandate-verification.spec.ts
services/server/src/route/schema-oobi-route.spec.ts
services/server/src/mandate/application/current-task-mandate.spec.ts
services/server/src/mandate/application/current-promotion-mandate.spec.ts
services/server/src/evidence/application/reconcile-evidence-seal.spec.ts
apps/cli/src/mandate/infrastructure/task-authorization-file.spec.ts
apps/cli/src/mandate/application/task-mandate-authorization.spec.ts
apps/cli/src/mandate/infrastructure/signify-local-mandate-authority.spec.ts
apps/cli/src/run/application/terminal-calibration-reconciliation.spec.ts
services/server/src/evidence/application/terminal-calibration-reconciliation.spec.ts
```

After parent coordination, run the real localhost schema route and isolated
KERIA/Mongo cancellation/mandate journey; include
`services/server/src/evidence/infrastructure/mongo-terminal-calibration-evidence.integration.spec.ts`
with its owning integration configuration. No standalone unit run establishes
that Mongo integration ran. Parent owns `just smoke`, `just check`, live gates and
any Compose lifecycle action. Do not run a paid provider journey for this audit.

## Actual verification

- PASS: domain, protocol, identity builds; six public schema SAID verifications.
- PASS: existing protocol mandate tests (12), identity mandate evidence tests (8),
  mandate exchange tests (22), OOBI route tests (7): 49 tests. These establish the
  old baseline only; coexistence regressions described above are still required.
- Initial protocol test collection was BLOCKED by absent domain build output;
  rerun passed after building prerequisites. An initial CommonJS diagnostic import
  failed because Signify is ESM-only; corrected ESM diagnostic passed.
- NOT RUN: CLI/server builds (no implementation changes here), live sockets,
  KERIA/Mongo/Atlas/provider activity, Run2 cancellation, smoke, full `just check`.
  Those are intentionally reserved for parent coordination. No completion claim
  for the quota or cancellation implementation.
