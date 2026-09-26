/** Editorial pitch content, not product resources, domain state, or runtime evidence. */
export const chapters = [
  {
    label: 'The idea',
    eyebrow: '01 / THE BIG IDEA',
    title: 'Better agents. Bounded authority.',
    description:
      'An agent that learns how to work better—without being allowed to move its own goalposts.',
    takeaway: 'Improve the behavior. Preserve the boundaries.',
    note: 'Open with the tension: a fixed harness cannot fit every task. But an agent that rewrites its own rules can also rewrite what success means. Devrandom separates useful adaptation from authority. This entire browser experience is an illustrative pitch, not a live execution or a benchmark.',
    detail:
      'A harness is the versioned environment around the model: instructions, skills, context, memory, workflow, tools, and model policy. Devrandom evolves that behavior through evidence. Model weights are not being trained.',
  },
  {
    label: 'Identity',
    eyebrow: '02 / TRUST STARTS WITH WHO',
    title: 'One task. Three distinct principals.',
    description:
      'You define the outcome. Your personal agent does the work. A separately authorized Governor can approve a proven improvement.',
    takeaway: 'Knowing who an agent is does not tell you what it may do.',
    note: 'Start after identity admission. A locally controlled user AID and verified credential precede runtime construction. Explain the two mandates: the Task Mandate bounds execution, while the Promotion Mandate delegates a narrow decision to a separate Governor. The harness is a resource, not a fourth principal.',
    detail:
      'KERI AIDs identify the user, personal agent, and Governor. ACDC credentials convey scoped claims. Signify-TS keeps signing at the edge; KERIA supplies protocol infrastructure. SAIDs bind exact content. Signatures establish attribution and integrity, not semantic correctness.',
  },
  {
    label: 'The harness',
    eyebrow: '03 / MORE THAN A PROMPT',
    title: 'Give it a goal. Not a persona.',
    description:
      'A task contract becomes a suitable starting harness. One executor works inside explicit tools, budgets, and completion conditions.',
    takeaway: 'H1 is initial specialization. Learning comes after evidence.',
    note: 'The example task repairs receipt compatibility while preserving tamper rejection. H1 is derived from coding.default, the immutable task, repository evidence, available tools, model compatibility, and mandate. It is not a learned improvement. Specialist roles are lazy and share the personal-agent AID.',
    detail:
      'Pi supplies the embedded model loop. The Run Supervisor owns orchestration; XState realizes the live process. The Context Index chooses bounded context, the Evidence Recorder retains observations, and the Tool Gateway enforces the mandate before effects. These are distinct responsibilities.',
  },
  {
    label: 'Memory',
    eyebrow: '04 / EXPERIENCE THAT COMPOUNDS',
    title: 'Remember the evidence. Focus the context.',
    description:
      'Keep the trail of what actually happened. Bring only relevant experience back into the model’s working context.',
    takeaway: 'A smaller context does not have to mean a shorter memory.',
    note: 'Follow the chain from the bounded local disk outbox through authenticated server ingestion into Atlas. Summaries and vector retrieval point back to immutable raw evidence. Atlas retrieves analogous episodes; deterministic lookup finds exact code and trace records. Similarity cannot authorize or promote anything.',
    detail:
      'Only the Devrandom Server holds Atlas credentials. It enforces access and cost limits, accepts ordered idempotent evidence batches, and returns acknowledgement watermarks. Forbidden secret bytes are withheld before persistence. Required unacknowledged evidence blocks promotion.',
  },
  {
    label: 'Evolution',
    eyebrow: '05 / EARN THE NEXT REVISION',
    title: 'Turn a failure into a testable idea.',
    description:
      'Diagnose a repeatable limitation. Branch a small set of changes. Compare them under the same protected evaluation.',
    takeaway: 'A proposal is a hypothesis. Improvement needs proof.',
    note: 'Do not claim the example failure happened live. The real entry gate needs five sealed calibration attempts with at least four matching confirmations, then a retained blocked Run. A passing H1 is valid runtime evidence, not a failure to manufacture. Candidates must also be compared with extra search alone under matched budgets.',
    detail:
      'C1 changes instructions, C2 a skill or workflow, and C3 context policy. Immutable candidates face repeated comparable trials, a locked candidate-inaccessible holdout, artifact checks, and a seven-obligation tamper audit. Safety and authority failures cannot be traded for higher task performance. No winner is predetermined.',
  },
  {
    label: 'Promotion',
    eyebrow: '06 / THE PROMOTION MANDATE',
    title: 'Permission to improve. Not permission to do anything.',
    description:
      'Delegate improvement without approving every in-scope revision. Evidence, current authority, and durable commitment must all agree before behavior changes.',
    takeaway: 'Passing evidence is necessary. So is lawful authority.',
    note: 'The protected evaluator, tamper audit, promotion controller, and Governor key stay in the trusted local CLI control plane. The Governor signs the exact binding. The server verifies and atomically commits; it never selects the winner. The Run Supervisor switches only after the durable receipt. Explore a failed gate.',
    detail:
      'The Promotion Mandate binds the Governor AID, task and harness lineage, permitted evolution classes, required metrics and protected checks, maximum risk class, validity, revocation reference, and protected evaluation-manifest SAID. It cannot increase the Task Mandate ceiling.',
  },
  {
    label: 'Boundaries',
    eyebrow: '07 / TRY TO BREAK THE DEAL',
    title: 'Smarter does not mean more powerful.',
    description:
      'A candidate may propose a better workflow. It cannot deploy itself, rewrite its evaluator, erase a failure, or expand its mandate.',
    takeaway: 'The agent can change its approach. It cannot change the rules of approval.',
    note: 'Invite a judge to choose an attack. These are authored explanations of the required rejection paths, not calls to the runtime. The real product must reject through general mandate and promotion laws, not a hardcoded malicious candidate name. Rejection preserves the usable incumbent and the attempt evidence.',
    detail:
      'Tool enforcement, protected evaluation, evidence integrity, and promotion authority are independent boundaries. A high task score cannot compensate for breaking any one of them. The candidate cannot access the Governor signing key, protected cases, or Atlas credentials.',
  },
  {
    label: 'Continuity',
    eyebrow: '08 / LONG HORIZON, SHORT CONTEXT',
    title: 'The process can stop. The work can continue.',
    description:
      'A verified checkpoint preserves the task, accepted revision, artifacts, and next lawful step across process loss.',
    takeaway: 'New process. Same task. Current authority.',
    note: 'Use the process-loss illustration, then recovery. The same nonterminal Run continues in a new Run Incarnation. Recheck mandate revocation and reconcile the server-committed harness before Pi starts. Do not restore authority from a stale process snapshot. Submission is still not completion: the final artifact must satisfy the original contract.',
    detail:
      'Recovery uses immutable task intent, verified progress, artifact references, current authority, and bounded relevant context. It does not inject the entire transcript or replay an already completed effect. A corrupt checkpoint or revoked mandate must block continuation.',
  },
  {
    label: 'Sharing',
    eyebrow: '09 / SHARE WHAT WAS LEARNED',
    title: 'Publish the behavior. Keep the private life.',
    description:
      'Derive a sanitized, verifiable harness package. Another person can inspect it and fork a new private lineage under their own authority.',
    takeaway: 'Reusable intelligence without transferable permissions.',
    note: 'Sanitization derives a separate package and leaves private H2 unchanged. Strip private traces, task memory, credentials, mandates, and secrets; parameterize local paths. Run portability checks, content-address and sign, then admit through the server. Fetching, verifying, forking, and activation are separate acts.',
    detail:
      'A package carries behavior, safe provenance, compatibility requirements, a content SAID, and a publisher signature. Required capabilities are declarations, never grants. It transfers no AID, task custody, compute, credentials, private memory, or active mandate. Publication never activates a consumer revision.',
  },
  {
    label: 'What’s next',
    eyebrow: '10 / AN INFRASTRUCTURE TO BUILD ON',
    title: 'Better once. Useful beyond one run.',
    description:
      'Identity, bounded delegation, verifiable experience, and portable behavior create foundations for much more than a coding assistant.',
    takeaway: 'A future where useful behavior compounds—and accountability travels with it.',
    note: 'These are future possibilities, not shipped capabilities or dependencies of the core demo. Start with scoped remote execution using a separate node AID and an expiring lease. Broader discovery, marketplaces, organizational delegation, and scheduling require separate product and security work.',
    detail:
      'The immediate product claim is governed harness evolution. Portable compute, organization workflows, discovery, and marketplaces are deferred. This exhibit explains why the existing separations make those extensions conceivable without claiming that they are implemented.',
  },
] as const;

export const harnessLayers = [
  {
    name: 'Instructions',
    symbol: '01',
    description:
      'Operational rules for the task. One component of a harness, not the whole system.',
  },
  {
    name: 'Skills & workflow',
    symbol: '02',
    description:
      'Reusable recovery procedures and verification steps. A behavior change can go beyond prompt rewriting.',
  },
  {
    name: 'Context & memory',
    symbol: '03',
    description: 'Select relevant experience without losing access to the raw evidence behind it.',
  },
  {
    name: 'Tools & model policy',
    symbol: '04',
    description:
      'Choose only from reviewed implementations and already authorized capabilities. No arbitrary plugin hot loading.',
  },
] as const;

export const futurePossibilities = [
  {
    name: 'Portable compute',
    icon: 'network',
    title: 'Let the work move. Keep identity yours.',
    description:
      'A separately identified node could perform a bounded step under an expiring execution lease and return a signed receipt.',
    foundation: 'Identity + scoped execution leases',
    boundary: 'The node gets a lease. Never the agent’s private key.',
  },
  {
    name: 'A behavior commons',
    icon: 'branch',
    title: 'Share a method, not a black box.',
    description:
      'Verified, sanitized harness packages could become building blocks that others inspect, fork, evaluate, and improve in their own context.',
    foundation: 'Portable packages + provenance',
    boundary: 'Discovery and marketplaces are future work. A download grants no authority.',
  },
  {
    name: 'Accountable teams',
    icon: 'shield',
    title: 'Delegate work with explicit limits.',
    description:
      'Organizations could build workflows around separately accountable principals, revocable scopes, and attributable decisions.',
    foundation: 'Mandates + signed decisions',
    boundary: 'Organization-to-organization workflows are deferred, not part of the core runtime.',
  },
  {
    name: 'Work that lasts',
    icon: 'clock',
    title: 'Build across days, not context windows.',
    description:
      'Long-running research and engineering could retain verified progress, retrieve useful experience, and continue under current authority.',
    foundation: 'Checkpoints + bounded context',
    boundary:
      'Broader domains still need their own completion contracts and independent evaluators.',
  },
] as const;
