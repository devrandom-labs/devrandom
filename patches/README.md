# Signify HTTP transport

`signify-ts@0.4.0.patch` adds an optional sixth `SignifyClient` constructor
argument with the standard `fetch` signature. It routes the client's seven
HTTP call sites through that transport. Existing callers retain global-fetch
behavior; request signing, response verification, serialization, and key
management are unchanged.

The identity adapter supplies native fetch with a ten-second abort deadline.
The signal remains attached while the SDK consumes the response body. This
avoids returning a timeout while leaving the underlying request running.
No global fetch replacement is installed.

The exact patch is recorded in `pnpm-workspace.yaml` and hashed in the single
pnpm lockfile. Frozen installs, including Compose builds, apply it. Regression
coverage lives in `packages/identity/src/signify-controller.spec.ts`; native
identity and Work Access acceptance uses `just test-identity-journey`.
