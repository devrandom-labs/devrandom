# Devrandom Hackathon Implementation Instructions

These instructions apply to all hackathon design and implementation beneath
this directory. More specific repository instructions may add constraints but
may not weaken this contract.

## Required reading

Before changing hackathon production code, tests, schemas, fixtures, CLI
behavior, or documentation, read these files in order:

1. `docs/hackathon-decision.md`
2. `docs/implementation-hypotheses.md`
3. `docs/execution-contract.md`
4. `docs/harness-demo.md`
5. `docs/hackathon-tech-stack.md`
6. `docs/hackathon-changes.md`
7. `docs/todo.md`

Consult `docs/harness-logic.md` for broader requirements and research rationale.
Material under `docs/future/` is outside the hackathon runtime plan; do not use
it unless the user explicitly opens a future-architecture task.

For the active onboarding slice, also read `docs/identity-initial.md`. For the
first post-identity slice, read `docs/02-authenticated-work-execution.md`; its
implementation is blocked until the identity PRD's live acceptance succeeds.

## Decision lock

`docs/hackathon-decision.md` is the canonical accepted architecture. Do not silently
reinterpret or replace it because a different design is easier to code.

Before each implementation change:

1. name the execution-contract slice and checklist item it advances;
2. identify the domain owner and governing invariant;
3. write a caller-visible regression or acceptance test that fails for the
   intended reason; and
4. verify that the change does not cross a deferred boundary.

Before retaining each implementation loop:

1. run the narrow regression that motivated the change;
2. build every affected application or package;
3. start every affected runnable application and exercise one real public
   boundary through `just smoke` or a stricter slice-specific smoke;
4. run `just check`; and
5. record `NOT RUN` or `BLOCKED` instead of success when an application could
   not actually start.

Compilation, mocks, dependency injection, and in-process unit tests do not by
themselves establish that an application runs. A CLI loop must execute the
real command boundary. A service loop must listen on localhost and answer an
HTTP request. A browser loop must serve the built page and return it over HTTP.

If the requested work conflicts with the canonical decision, stop and report
the conflict. Update the decision document only after explicit user approval.

## Non-negotiable model

- The user, personal agent, and Governor are distinct principals with distinct
  AIDs.
- A harness is a versioned resource, not a principal by default.
- Internal model roles share the personal-agent AID and mandate.
- One Pi executor is active by default. Diagnostic/refiner, candidate-worker,
  and reviewer roles are lazy and evidence-triggered.
- The run supervisor, context index, evidence recorder, Tool Gateway,
  evaluator, tamper audit, and promotion controller have distinct semantic
  responsibilities. Do not collapse them into a generic manager or handler.
- The candidate harness cannot control the Tool Gateway, protected evaluator,
  held-out cases, tamper audit, promotion law, or authority ceiling.
- The protected evaluator, tamper audit, promotion controller, and Governor
  signing key remain in the trusted local CLI control plane. A hosted service
  may verify and durably commit their signed result; it may not select, grade,
  or sign the winner.
- Initial H1 specialization is not evidence-backed evolution.
- Evolution requires evidence, a falsifiable hypothesis, immutable candidate
  branches, repeated evaluation, a locked holdout, tamper audit, and governed
  activation.
- The winning candidate is determined by real evidence. Never hardcode a
  winner or fabricate a metric.
- Safety and authority failures cannot be offset by task-performance gains.
- Jev is optional advisory or shadow triage. It is never authority, correctness
  truth, or a core-path dependency.
- Atlas Vector Search retrieves analogous experience. It does not search code,
  prove provenance, authorize actions, or promote candidates.
- Only the Devrandom server receives the Atlas connection string. The CLI and
  candidate workers use typed server capabilities and never receive database
  credentials, raw MongoDB query authority, or a direct Atlas connection.
- Raw traces remain addressable behind summaries and embeddings.
- KERI/ACDC/CESR/SAIDs establish identity, authorization claims, attribution,
  and content binding; they do not establish semantic correctness.
- Harness publication transfers sanitized behavior, not identity, compute,
  credentials, task authority, secrets, or private memory.
- Optional remote execution uses a node AID and execution lease. Never copy the
  personal-agent private key to the node.

## Domain-driven hexagonal structure

- Organize code by bounded context and semantic owner first. A term has one
  meaning inside its context; crossing a context requires an explicit mapping.
- Keep the domain model independent of frameworks, transport, persistence,
  model SDKs, and deployment machinery. Domain modules own invariants, lawful
  transitions, entities, values, and domain outcomes.
- Put use-case sequencing in an application module owned by the capability
  being performed. Application code may depend on domain code and capability
  ports; it may not depend on concrete external adapters.
- A port names one purposeful conversation at the application boundary. Name
  it by the domain capability it requires or offers, not by its technology and
  not with a generic `Port`, `Service`, `Manager`, or `Handler` suffix.
- An adapter names both the external technology and the role it performs, such
  as `PiToolInterceptor`, `MongoRunRepository`, or
  `FastifyRegistrationRoutes`. Adapters translate; they do not acquire domain
  policy.
- Driving adapters invoke application capabilities. Driven adapters implement
  capabilities the application requires. Dependencies point inward; only a
  composition root may select and wire concrete adapters.
- Do not mirror the same domain type in a CLI, HTTP route, database document,
  Pi event, and domain module. Give each external representation an adapter
  type and map it at the boundary.
- Keep orchestration state, authorization policy, evidence recording, and
  external execution in separate owners even when they run in one process.
- Use the repository's ubiquitous language in directories, files, exported
  symbols, tests, and commands. Prefer whole domain words and established terms
  over abbreviations or architectural filler.
- A name is not justified merely because it appears in a requirements document,
  architecture note, TODO, prior implementation, or external style guide. Treat
  those sources as evidence and candidate vocabulary. Validate the name against
  the concept's actual invariant, lifecycle, authority, and caller-visible
  behavior inside its bounded context. If those do not agree, repair the model
  and vocabulary together rather than preserving the documented noun.
- External naming guides settle mechanical conventions such as casing, filename
  separators, and test suffixes. They cannot select the repository's domain
  nouns or verbs. That choice belongs to the domain model and must be explainable
  without citing a style guide.
- When a domain has an established standard vocabulary, compare the model to
  that vocabulary and adopt it only where the semantics actually match. For
  access control, distinguish the request to access a resource, the component
  that computes an authorization disposition, and the enforcement point that
  prevents an unpermitted effect. A request awaiting human approval is pending;
  it is not an authorization grant.
- Name each pipeline stage for what the value means at that stage. Do not reuse
  one DTO across boundaries or blur distinct meanings into generic names such as
  `Request`, `Data`, or `Result`.
- Name a port method with the domain verb for its purposeful conversation, such
  as `authorize(proposal)`, `record(evidence)`, or `retrieve(query)`. Avoid
  generic verbs such as `handle`, `process`, `manage`, or `execute` when the
  domain action is known.
- Name a closed outcome for the exact question it answers: `Authorization`,
  `Verdict`, `Disposition`, or `Receipt`, not a generic `Decision`, `Response`,
  `Status`, or `Result`. Its alternatives must also be domain terms.
- Use lowercase kebab-case TypeScript filenames. A filename names one logical
  component in the context supplied by its directory; do not repeat the parent
  module name mechanically, and avoid vague barrels such as `helpers.ts`,
  `common.ts`, or `types.ts`.
- Use PascalCase for types and camelCase for values and functions. Do not prefix
  interfaces with `I`; name an interface for the capability or contract it
  expresses.
- Do not add a class where a closed data model plus pure transitions is clearer.
  When lifecycle or identity genuinely requires an object, name it for that
  domain responsibility rather than its implementation pattern.
- Tests follow the same ownership structure as production code. Cross-adapter
  acceptance tests may live at the nearest composition boundary; disposable
  spike machinery must be visibly labeled and must not become a production
  domain abstraction.
- Before retaining a new module, state its bounded context, whether it is
  domain, application, port, adapter, or composition code, and the inward
  dependency it is allowed to have.

Naming and boundary references for these rules:

- These references support the method and mechanical conventions; they do not
  endorse any particular domain name in this repository.

- Alistair Cockburn's original Ports and Adapters article and 2024 “What is a
  port?” clarification: a port is a purposeful application conversation owned
  by the inside; a technology-specific adapter implements or drives it.
  <https://alistair.cockburn.us/hexagonal-architecture>
  <https://alistaircockburn.com/zh3/Articles/What-is-a-port-In-PortsAdapters>
- Eric Evans's DDD reference: modules are part of the model and their names are
  part of the ubiquitous language.
  <https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf>
- NIST SP 800-162 and OASIS XACML supply the access-control distinctions used
  for semantic comparison: request attributes, authorization decisions, and
  separate policy decision and enforcement responsibilities.
  <https://csrc.nist.gov/pubs/sp/800/162/upd1/final>
  <https://docs.oasis-open.org/xacml/3.0/xacml-3.0-core-spec-cos01-en.pdf>
- Microsoft's TypeScript contributor guidance: prefer whole words and one file
  per logical component; do not prefix interfaces with `I`.
  <https://github.com/microsoft/TypeScript/wiki/Coding-guidelines>
- Angular's current TypeScript application style guide supplies the adopted
  file mechanics: hyphen-separated descriptive filenames, colocated `.spec`
  names, feature-first directories, one concept per file, and no vague
  `helpers.ts`, `utils.ts`, or `common.ts` names. Its framework-specific class
  suffixes are not adopted outside Angular components.
  <https://angular.dev/style-guide>

## Hackathon runtime boundary

The core implementation is strict TypeScript with the Pi SDK, XState,
MongoDB Atlas, Signify-TS, and KERIA or valid presentation fixtures.

The repository toolchain is supplied by the committed Nix flake. Run repository
operations through `just` inside `nix develop`; do not use host `npm`, `npx`,
or globally installed JavaScript tools. Dependency changes must update the
single pnpm lockfile deliberately and keep exact versions.

Docker Compose is the selected local integration environment for pinned KERIA,
demo witnesses, the Devrandom server, and test MongoDB. Signify-TS remains an
embedded edge-client library, not a separate server container. Compose MongoDB
proves adapter behavior; Atlas remains required for Atlas Vector Search and the
live demonstration. Pi, XState, the Run Supervisor, candidate workers, and
protected governance remain host-side CLI components and are never Compose
services.

The CLI and registration site are applications. The Devrandom server is one
Fastify deployable containing separate registration/issuance and hosted-work
bounded contexts. The site owns browser interaction; the server owns
registration policy, credential issuance, remote request authorization,
budget enforcement, Atlas persistence and retrieval, signed activation commit,
and publication admission; and the CLI owns local identity custody, live agent
execution, harness evolution, protected evaluation, tamper audit, and Governor
authorization. The server never holds the personal Governor signing key and
does not decide candidate correctness or select a winner. Deployables may not
import one another or redefine shared domain or protocol state.

The current identity E2E slice may retain its existing issuer-only composition
root until that PRD is complete. Post-identity work must compose those proven
issuer capabilities into the Devrandom server without changing the identity
PRD mid-implementation or giving the issuer context task, evaluation, or
promotion law.

The application stack is locked: the site uses Next.js App Router, Material UI,
and RTK Query; HTTP services use Fastify; Fastify route schemas generate the
committed OpenAPI contract. Do not introduce a competing web framework, router,
design system, CSS framework, browser data-fetching layer, or HTTP service
framework. Manifest policy, import restrictions, and CI enforce this rule.
Handwritten site stylesheets and raw React `style` props are prohibited.

Do not add deferred runtime components, marketplace discovery, general P2P
scheduling, or organization-to-organization workflows to the core runtime.

Do not create a second task model, harness model, promotion path, or durable
truth inside the CLI, web view, runtime actors, or adapter code. Interfaces
delegate to the owning domain module.

## Completion standard

A change is complete only when its public behavior, failure path, durable
evidence, and authority boundary are tested. After each retained design step,
inspect the complete diff and remove wrappers, aliases, flags, and forwarding
layers that do not own a distinct semantic responsibility.

`just check` is the minimum retained-loop gate and includes formatting, lint,
strict type checking, tests, builds, workspace boundaries, live smoke checks,
and the Nix flake check. Do not remove or bypass one of those stages to make a
loop pass.
