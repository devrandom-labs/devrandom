# Devrandom backup demonstration

This is a **recorded simulation with independent mechanism proofs**. It is not
one continuous live campaign. Qualification of a genuine H1 failure, live H2
activation, and completion of the original Task remain unestablished.

The product idea: **an agent can improve how it works without increasing what
it is allowed to do**. The agent proposes changes; protected evaluation and a
separate Governor control activation. Recovery preserves the Run, and
publication shares sanitized behavior without sharing identity or authority.

## Prepare once before presenting

Run from this repository with Docker running and the repository Nix environment
available. Preparation runs real native and process-loss checks with fixture
inputs. It does not call a paid model, create a live Task, or publish to Atlas.

The pinned evaluation image already used on this demo machine is:

```sh
DEVRANDOM_EVAL_IMAGE=sha256:13dda7da2b6af646a9a0459641fd6d1763e711192110f9a92f7c2b9a04cc6cdd \
  nix develop -c just demo-prd03-prepare
```

This image must exist locally. Do not substitute an arbitrary image or tag.
Preparation retains a new directory beneath `.devrandom/prd03-demo/` and prints
its location. It preserves older preparations. Proceed only when the output
says `DEMO PROOFS READY`; failed, missing, or skipped proof suites are blocked.

## Present in six minutes

Presentation rechecks the retained proof hashes. Docker and a model provider
are not needed for playback after a successful preparation.

1. **Opening — 45 seconds.** Display the overview:

   ```sh
   nix develop -c just demo-prd03
   ```

   Say: “This is our simulation backup. These are recorded, independently
   executed mechanism proofs, using fixture inputs. We are demonstrating how
   improvement is governed; this is not a claim of a completed live evolution.”

2. **Protected evaluation — 60 seconds.**

   ```sh
   nix develop -c just demo-prd03 .devrandom/prd03-demo native-evaluation
   ```

   Point to real Docker containment, native Rust execution, immutable source
   capture, and denial of protected source access. Explain: “A candidate can
   change its behavior, but cannot change the evaluator or read protected
   source.” The model stimuli and authority inputs are fixtures; this is not
   the full eighteen-Trial comparison.

3. **Independent authority — 90 seconds.**

   ```sh
   nix develop -c just demo-prd03 .devrandom/prd03-demo governed-promotion
   ```

   Explain: “Measurements are bound to a frozen manifest. Selection can return
   no winner. The personal agent and Governor are separate principals, and
   approval must match the exact evaluation. A forbidden effect stays
   forbidden even when a candidate appears useful.” Observations and hosted
   receipts here are fixtures; no live Governor promotion is claimed.

4. **Durable recovery — 60 seconds.**

   ```sh
   nix develop -c just demo-prd03 .devrandom/prd03-demo process-loss-recovery
   ```

   Explain: “This proof actually killed an OS process and reopened its SQLite
   evidence and Git checkpoint. It continued the same Run in a fresh
   incarnation. Tampered source was rejected before admission.” Its initial
   authority is simulated, and it is independent of the previous stage.

5. **Share behavior — 60 seconds.**

   ```sh
   nix develop -c just demo-prd03 .devrandom/prd03-demo portable-publication
   ```

   Explain: “Publication sanitizes a behavior package. A consumer verifies and
   forks it into a private lineage without receiving the publisher's identity,
   credentials, mandate, or compute.” Package provenance and some adapters are
   fixtures; this stage does not publish a live winner to Atlas.

6. **Close — 45 seconds.** State the three differentiators: independently
   governed improvement, evidence-preserving recovery, and portable behavior
   without transferred authority. Say: “The proper live demonstration will
   connect these mechanisms through one genuinely qualified campaign.”

## Evidence and fallback

Each stage prints a retained proof path and SHA-256 digest. The preparation
directory contains `simulation-proof-report.json`, raw Vitest reports, and
`presentation.txt`. The recovery stage also records its process-loss details.
These files are test evidence, not signed production campaign evidence.

If presentation reports missing or invalid evidence, do not claim a pass.
Reprepare before the demo when possible. For terminal trouble, open the retained
`presentation.txt` and identify it explicitly as a static recorded backup.
Do not edit proof reports to make a failed preparation appear successful.

## Scope and verification ownership

This tooling advances execution-contract demo hardening and the Phase 10
labeled-fallback checklist. The demo operator owns the presentation; the
existing domain owners retain evaluation, promotion, recovery, and publication
law. `tooling/prd03-demo.ts` is a tooling composition boundary that invokes
existing acceptance suites and reads their retained proof reports. It adds no
product Task, Harness, authority, or durable production state. The simulation
does not waive any live PRD03 acceptance requirement.
