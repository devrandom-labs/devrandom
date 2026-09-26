# Fresh CESR compatibility task — proposal only

Prepared from accepted main 0ef8bf1. No source, tests, Task, mandate, campaign, model, or authority changed. No paid calls. This document is a review input, not qualified failure evidence.

## Recommendation

A genuine extension is parsing large generic pipeline frames and nested version-scoped generic groups through the existing `parse_receipt_stream(&str)` API. Approve preparation of one fully disclosed fresh task only after source provenance and P/S/B preflight. Do not launch qualification now. There is no empirical basis for claiming four of five unchanged-H1 attempts will fail. A successful H1 closes the fresh campaign as rejected; it must not trigger task/model roulette.

The original fixture is a small flat-group compatibility repair that actual H1 already solved. Git history contains only its introduction in 14b27e1; its materializer creates one prepared-source commit. Do not invent historical bug fixes or treat the old successful run as a qualifying analogue.

## Source and contract

Use the actual successfully repaired original source as the fresh starting point, after retrieving and binding its exact submitted bytes/commit/tree. Preserve all old current, tamper, and flat legacy behavior. Do not deliberately restore old bugs. Its exact repaired artifact has not been located by this review, so starting-source provenance remains a prerequisite. An alternative is unchanged original source plus the genuine new compatibility requirements; that preserves the historical baseline but should be explicitly reviewed, not passed off as the successful repair.

The fresh task keeps the same public Rust function, receipt/error types, Cargo dependencies, and non-cryptographic framing purpose. Keep unchanged H1 template, model/settings, tools, workflow and actual authority ceilings. Do not add a stronger first-edit submission restriction or hide requirements.

Primary-source basis: the [CESR specification](https://trustoverip.github.io/kswg-cesr-specification/) defines small `-A##` and large `--A#####` generic pipeline groups, with two/five Base64 count digits measuring body quadlets. Groups may contain primitives or groups. Universal A groups permit an initial genus/version override; scope is the enclosing group. The exact large prefix is `--A`, not `-0A`. The new task would select a disclosed text-only subset of these semantics; it would not claim to implement all CESR.

Proposed explicitly disclosed application subset:

1. Accept concatenated top-level A groups in either short or large form. Count the complete body, including nested headers and initial version marker, exactly. Large form remains legal for small bodies. Reject truncation, invalid count digits, overflow, and bytes outside frames. Check byte bounds before slicing Rust strings.
2. Permit group bodies containing complete E-qualified 44-character payloads and nested short/large A groups, in stream order. Flatten receipts without losing effective version.
3. Top-level groups start with Current as in the old task. A nested group inherits its parent's effective version unless its initial `-_AAABAA` or `-_AAACAA` marker overrides it. Leaving a nested group restores the parent; leaving a top-level group restores the default for the next top-level group. Markers elsewhere are invalid in this bounded subset. Unsupported versions remain rejected. Top-level standalone markers remain outside this application subset and must be stated as such.
4. Preserve the old nonempty group/payload and malformed-payload rules. Explicitly document any finite supported nesting bound before tests; do not hide a resource-limit requirement. Binary CESR, other group types, JSON interleaving and cryptographic verification remain outside this task.

Public examples must exercise every rule: large flat legacy frame, nested legacy inheritance, inner Current override followed by a Legacy sibling, restoration at the next top-level group, mixed small/large nesting, malformed inner count, invalid UTF-8 input rejection without panic, and large advertised count with truncated input. Include a valid body crossing the 4095-quadlet small-counter boundary. These are requirements, not protected surprises. Existing current/tamper suites must initially pass; a new legacy-compatibility suite may fail only for the actual missing compatibility behavior.

## Trusted evaluator changes required before qualification

`apps/cli/src/harness/infrastructure/verified-cesr-public-catalogue.ts` currently pins AGENTS plus three test-file SHA256s and reconstructs fourteen original observations. Any altered public contract/tests are correctly rejected. Add an explicit reviewed fresh catalogue identity and complete expected observations, preserving the old catalogue for old bindings. Do not weaken hash checks or silently apply fourteen old cases to a larger contract. Fourteen is this implementation's old catalogue size, not PRD03's experiment law; the PRD's fourteen acceptance cases are unrelated. The eighteen rollout/fifteen measurement law remains unchanged.

`packages/runtime/src/evaluation/application/seal-cesr-comparison-cases.ts` currently seals two fresh payloads in a flat `-AAY` Legacy frame for both TrialHoldout and TerminalCase. It must select the exact new contract's independently generated nested/large composition and native expected flattened receipts, with fresh payloads and independently sealed terminal material. Old flat holdouts would not establish the proposed new behavior. Hidden data may vary payloads, arrangement and disclosed boundary combinations, never introduce a new semantic requirement. Keep protected custody, native build/API mapping, expected observation shape and artifact binding unchanged.

The current native observation shape already represents ordered Legacy/Current receipts or rejection, so no Rust API or protocol outcome expansion appears necessary. Regressions must reject the old flat-only solution under the new public and protected catalogue, accept an independently reviewed compliant implementation, preserve the old catalogue, and reject contract/case substitution. Run real native build/API smoke and the complete retained-loop gate before P/S closure.

`apps/cli/src/evolution/infrastructure/git-cesr-public-history.ts` currently admits Current-marker context and checks exact public source tokens including `strip_prefix("-_AAACAA")`. The repaired starting implementation may not retain that spelling. Review its semantic source projection for the new immutable source; never insert meaningless tokens to pass this guard. `VerifiedCesrPublicCatalogue`, public-history projection, and case selection are trusted adaptation points, not changes to candidate-controlled oracle law.

Estimate: roughly 1–2 hours for reviewed fixture/catalogue/protected-case adaptation plus native/full checks if the existing API remains valid; allow another review/check loop for source projection. This is an estimate, not authorization or a promise of qualification. Paid five-plus-six qualification and repeated comparison are additional and may reject the premise.

## C1/C2/C3 applicability and evidence limits

C1 can encode an evidence-derived reminder to inspect inherited/restored version context and counters, but no prompt should be drafted as an alleged learned fix before qualified H0 exists. C2 can trigger exact analogous-source inspection and fresh compatibility verification after an observed mismatch; genuine scoped episodes must exist and be authorized, not manufactured. C3 can include the immutable disclosed format contract and relevant actual failure history at version-sensitive edits; the current source projection needs semantic review as above. Each remains only a hypothesis. It is plausible that ordinary H1 inspection solves this extension immediately, in which case none may be used to claim evolution.

## P/S/B release checklist

P: freeze one actual Linux OCI profile with executable/image identities and prove unchanged runtime-built H1 behavior. Existing Darwin execution is not this proof. New source does not authorize a changed template/model.

S: exact source commit/tree, public AGENTS/tests/catalogue and protected-contract identity; same usable source rights across arms; explicit repository/history/analogous-experience disclosure. Nine baseline tools do not gain network or cross-task memory. Parent native verification remains separately authorized. Finish trusted catalogue/history/case updates before spending on Q.

B: current mandates, finite remaining consumables for all six runs and downstream work, unresolved usage reconciled. Parent reports owner quota six with two used: fresh six-run qualification cannot fit that residual. A quota increase requires explicit authority; this proposal does not grant it.

Q remains unchanged: five acknowledged sealed terminal calibrations with at least four identical clean compatibility confirmations, at most one lawful exclusion, then a sixth retained confirmation. H1Passed, missing artifacts, infrastructure failures and context exhaustion cannot count. No resets, replacements or favorable selection.

## Review disposition

Proceed only with static/native preparation after lead review of this proposal. Block paid qualification on source provenance, P/S changes, actual B authority, and explicit fresh bindings. The extension is a plausible legitimate task; reproducible harness failure remains unproved. Existing rejected campaign and original frozen fixture remain intact.
