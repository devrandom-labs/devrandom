# Runtime adapter package

Owns the XState Run Supervisor adapter, Pi integration, context indexing,
evidence capture, and pre-effect tool-access mediation. It does not own Task,
Run, mandate, Harness Revision, evaluation, or promotion truth. The Run domain
owns lawful state and outcomes; XState realizes one Run Incarnation.

Pi supplies the embedded provider/model loop, Pi Agent Session events, and
extension/custom-tool mechanisms. The Run Supervisor is the only application
owner allowed to construct, invoke, continue, or dispose Pi `AgentSession`
instances. Pi's CLI, `InteractiveMode`, RPC, raw consequential built-ins, and
bare default Pi Agent Session configuration are not retained product
boundaries.

## Dependency direction

Tool access is the inner capability. Pi is an external runtime adapter and the
enforcement point. The Pi adapter may depend on tool-access contracts;
tool-access code may not import Pi. The architectural component currently
called the Tool Gateway composes these responsibilities, but that product label
does not name the inner authorization port.

```text
tool-access/
  request.ts                 exact access request and authorization binding
  authorizer.ts              authorization port and closed disposition

evidence/
  tool-access-evidence.ts    recorded dispositions and mediation failures

pi/
  builtin-access-mappings.ts Pi calls to capabilities and resource identities
  tool-interceptor.ts        trusted Pi enforcement adapter and one-time grants

e0/
  *.spec.ts                 disposable external-contract proofs only
```

Approval lifecycle and restart orchestration do not belong to Pi. The E0
approval test proves the required contract without installing a second product
state model; the Run domain will own lawful approval state and the Run
Supervisor will orchestrate the retained lifecycle in E2.
