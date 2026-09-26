# Devrandom presentation

Run these commands in your normal zsh terminal. They invoke the built product CLI.
Identity and Task creation are real; opening this guide starts no model or paid Run.

## What is complete — September 26, 6:26 PM Eastern

| Part | Verified result |
| --- | --- |
| Normal CLI | Commands run directly from zsh through `devrandom`; no interactive presenter or `RUN` prompt. |
| Registration | Real browser approval, credential issuance, `init`, and `whoami` passed against the running services. |
| Task management | Real Task creation, listing, and inspection passed using a separate rehearsal identity. |
| Registration repairs | Corrected the schema service address and mixed-credential reconciliation that caused the silent wait and rejected issuance. |
| Integration | Distinct changes from all 86 worktrees are integrated into `main`; obsolete duplicate patches were excluded. |
| Signed continuation receipts | Fixed HTTP serialization to preserve signed JSON field order and SAID verification; real HTTP regressions passed. |
| Unstarted continuation recovery | Passed real MongoDB/HTTP recovery tests while preserving the Run, signed segment, incarnation, and budget; started or uncertain execution is rejected. |
| Evidence across restarts | Fixed batch admission and artifact reading to preserve original provenance while reusing exact files within the same Run. Seven real MongoDB/HTTP tests passed; the repair is deployed. |
| Checks | Latest `just check` passed: 2,491 tests, builds, CLI/server/site smoke checks, four pitch browser tests, and the Darwin Nix check. External integration tests run separately; 151 suite cases were skipped. |

The live evolution campaign is **not complete**. Its first calibration Run has
a sealed checkpoint after `ContextLimitReached`. Its continuation started, then
stopped when batch admission rejected reused evidence files. The receipt and
artifact-admission defects are repaired, but recovery of this started process
still needs a verified checkpoint and a new incarnation. That recovery is being
implemented. The failed successor made no model request or tool call; its recorded
nine seconds remain consumed. Live Task execution is **not ready**.

The complete native comparison fixture ran 18 coding rollouts and produced 15
measurements. Its honest result was **retain H1 / no eligible improvement**.
That fixture uses a simulated provider and qualification inputs. Qualified live
failure, live candidate selection and activation, H2 crash recovery, original
Task completion, and live publication/fetch/fork remain to be proven.

## 1. Configure the command

If the older interactive presenter is open, type `exit` first. Paste this block
into zsh once. It uses the separate presentation identity and the Task's source
repository, preserving the live campaign's profile.

```zsh
export DEVRANDOM_USER_STATE_DIR=/Users/joel/.devrandom-presentation-20260926-rip_1w7i
export DEVRANDOM_TASK_DIRECTORY=/Users/joel/Code/devrandom/devrandom/.devrandom/prd03-cesr-scoped-20260926a
export DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL=http://server:3211/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4

devrandom() {
  nix develop /Users/joel/Code/devrandom/devrandom -c \
    just --justfile /Users/joel/Code/devrandom/devrandom/justfile cli "$@"
}
```

## 2. Initialize identity

```zsh
devrandom init --no-open
```

Open the printed registration URL, complete browser registration, and leave the
CLI running until it reports the issued credential and ready identity. Repeating
`init` recovers the same presentation identity. A rejection or timeout is an actual
failure, not successful onboarding.

```zsh
devrandom whoami
```

Explain: “Identity admission comes before execution.”

## 3. Create and inspect the Task

```zsh
devrandom task create /private/tmp/devrandom-presentation-task.json
devrandom task list
devrandom task inspect presentation-20260926
```

Task creation should report a Task ID and immutable Task Revision SAID. If this
Task already exists, skip creation and inspect it. These commands do not start
a model or alter the existing `cesr-scoped-compat` campaign.

Explain: “The Task binds the repository, outcome, permitted actions, budget,
and expiry. The agent does not get to rewrite this contract.”

The prepared contract expires at **6:33 PM Eastern, September 26**. Do not create
it after expiry. The new presentation identity sees its own Task; the live
campaign belongs to a separate profile.

## 4. Inspect the available product commands

```zsh
devrandom --help
devrandom task --help
devrandom harness --help
```

Do not start `task run`, `task resume`, or promotion against the live campaign
for this recording: its recovery and qualification remain unfinished. Do not
present simulated qualification, selection, activation, or publication as output
from these product commands.

## Optional: retained independent test proofs

This separate command displays recorded test evidence, not a completed live
campaign. It does not enter the interactive presenter.

```zsh
cd /Users/joel/Code/devrandom/devrandom
nix develop -c just demo-prd03-recorded /Users/joel/Code/devrandom/devrandom/.devrandom/prd03-demo
```

## Optional: inspect the actual campaign without running it

The campaign belongs to the original identity, separate from the presentation
identity above. This single command temporarily selects that original profile
and reads its durable Run state; it does not resume execution or spend model budget.

```zsh
DEVRANDOM_USER_STATE_DIR=/Users/joel/.devrandom devrandom task status cesr-scoped-compat
```

Show the actual state, checkpoint, evidence count, and seal it reports. A blocked
Run is evidence of a recorded stop, not a completed task or a qualified failure.

## Task file setup — only if the prepared file is missing

This prepares a separate Task document from the accepted coding-task contract,
preserving capabilities, budget, expiry, and source. It creates no server record.

```zsh
python3 - <<'PY'
import json
from pathlib import Path

source = Path('/private/tmp/devrandom-fresh-scoped-launch/task.live-submission.json')
task = json.loads(source.read_text())
task['label'] = 'presentation-20260926'
task['title'] = 'CESR receipt compatibility — presentation'
target = Path('/private/tmp/devrandom-presentation-task.json')
target.write_text(json.dumps(task, indent=2) + '\n')
print(target)
PY
```
