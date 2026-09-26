# Devrandom presentation

The identity and Task commands below call the product. The walkthrough is an
interactive scenario, not live qualification, evaluation, or promotion evidence.
It announces this once when opened. Nothing automatically starts a paid Run.

## 1. Prepare the Task file — paste into your terminal

This makes a separate presentation Task document from the accepted coding-task
contract. It preserves the capabilities, budget, expiry, and source contract.
It does not change the live campaign or create a server record yet.

```sh
nu -c 'open /private/tmp/devrandom-fresh-scoped-launch/task.live-submission.json
  | update label "presentation-20260926"
  | update title "CESR receipt compatibility — presentation"
  | to json
  | save --force /private/tmp/devrandom-presentation-task.json'
```

The existing contract expires at **6:33 PM Eastern, September 26**. Do not use
this document after that expiry. If this presentation Task already exists,
skip its creation and inspect it instead.

## 2. Launch — works from Nushell or zsh

The command explicitly invokes Nushell because entering a Nix shell can leave
your current prompt running zsh. This avoids `zsh: parse error near '}'`.

```sh
cd /Users/joel/Code/devrandom/devrandom-prd03-interactive-demo

nu -c 'with-env {
  DEVRANDOM_DEMO_REPOSITORY_ROOT: "/Users/joel/Code/devrandom/devrandom"
  DEVRANDOM_DEMO_WORKING_DIRECTORY: "/Users/joel/Code/devrandom/devrandom/.devrandom/prd03-cesr-scoped-20260926a"
  DEVRANDOM_DEMO_ENV_FILE: "/Users/joel/Code/devrandom/devrandom/.env.cli"
  FORCE_COLOR: "1"
} {
  ^env -u NO_COLOR nix develop -c just demo-prd03
}'
```

You should see the cyan Devrandom heading and a `devrandom ❯` prompt. Paste
the remaining blocks **inside that prompt**, not into your normal shell.
Results reveal line by line in an interactive terminal. Add
`DEVRANDOM_DEMO_NO_ANIMATION: "1"` to the `with-env` record to disable the effect.

## 3. Identity — product command

```text
whoami
```

Shows the actual locally controlled identity and credential verification.
For an onboarding explanation: “Identity admission comes before execution.”
If recovery is needed, this invokes the real identity command after confirmation:

```text
init
RUN
```

## 4. Create and inspect the Task — product commands

The next block really creates the separate presentation Task. It does not start
a model or alter the existing `cesr-scoped-compat` campaign.

```text
task create
/private/tmp/devrandom-presentation-task.json
RUN
```

Expected: a Task ID and immutable Task Revision SAID. If the CLI reports an
error, that is the actual result; do not describe it as successful creation.

```text
task list
task inspect
presentation-20260926
```

Explain: “The Task binds the repository, outcome, permitted actions, budget,
and expiry. The agent does not get to rewrite this contract.”

To inspect the existing live campaign instead:

```text
task inspect
cesr-scoped-compat
```

## 5. Complete interactive walkthrough

Open the scenario once:

```text
walkthrough
```

Then paste one command at a time to narrate, or paste the whole block to reveal
all stages in order:

```text
task
baseline
compare workflow
approve agent
approve
network
crash
resume
publish
fork
inspect
```

| Command | What to point out |
| --- | --- |
| `task` | Explicit deliverable, verification, and capability boundaries. |
| `baseline` | The repeatable-failure qualification required before evolution. |
| `compare workflow` | H1, three candidate changes, and a matched search control. |
| `approve agent` | The personal agent cannot sign as Governor. |
| `approve` | Activation requires the separate Governor's exact decision. |
| `network` | Improvement grants no additional authority. |
| `crash` / `resume` | Same Run, new process incarnation, preserved authority. |
| `publish` / `fork` | Behavior transfers; keys, identity, and mandates do not. |

The comparison scores and identifiers in this section are scenario values.
They are not results from the live campaign.

## 6. Show an alternative outcome

```text
reset
task
baseline
compare none
approve
```

Expected: H1 remains active because no candidate is eligible. The system does
not require a winner.

## 7. Return to product commands or finish

```text
product
whoami
exit
```

`actions` lists available product commands. `proofs` checks the retained
independent fixture reports; those reports are not one complete live campaign.

Do not run `task run`, `task resume`, or promotion commands against the live
campaign as part of this backup presentation: that campaign is still being
recovered and qualified under its existing allowance.
