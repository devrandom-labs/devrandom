# Issuer service

Owns short-lived Registration Sessions, proof-of-control verification,
registration policy, and the call to the Signify-TS/KERIA issuance boundary.
It never receives the user's private signing keys and does not own Task, Run,
Harness Revision, evaluation, or promotion law.

`devrandom-issuer bootstrap` establishes the one persistent Devrandom issuer;
`devrandom-issuer serve` verifies that exact issuer before binding Fastify.
Bootstrap, serve, live issuance/IPEX, and local verification have E0 mechanism
proofs. The Registration Session and CLI/browser admission journey remain
product work.

Fastify is the service framework. Route schemas are the source for the
committed `openapi.json`; run `just openapi` after changing a public route.
Competing HTTP frameworks are rejected by the repository gate.
