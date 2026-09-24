# Registration site application

Owns browser authentication, explicit approval of an AID-bound registration
request, Registration Session presentation, and later read-only demo views. It does
not hold user signing keys, authorize credential issuance, or own task,
harness, evaluation, or promotion state.

Next.js App Router owns browser routing, Material UI owns presentation, and RTK
Query owns browser API access. Site code uses Material UI components and theme
tokens; handwritten CSS files, raw React `style` props, and competing web,
design-system, CSS, routing, or API-client libraries are rejected by the
repository gate.

The site consumes generated RTK Query endpoints from the committed OpenAPI
contract. It never constructs a work Run or Pi Agent Session.
