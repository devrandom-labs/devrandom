# Identity adapter package

Owns Signify-TS and KERIA adapters behind domain-defined identity and
credential ports. It does not decide registration eligibility or interpret a
credential as platform authority.

The CLI and issuer compose these shared mechanisms with different locally
controlled identities. Signify-TS is an embedded edge library, not a Compose
service. KERIA protocol availability is not proof of identity admission or
authorization.
