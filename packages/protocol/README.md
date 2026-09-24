# Protocol package

Owns versioned wire schemas shared across the CLI, registration site, and
issuer service. It does not own domain decisions or transport implementations.

Wire schemas preserve distinctions such as Registration Session state and
issuer errors but do not become a second Task, Run, credential, or identity
domain model.
