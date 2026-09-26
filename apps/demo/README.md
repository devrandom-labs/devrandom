# Devrandom interactive pitch

A standalone browser exhibit explaining the intended system. No backend,
database, identity setup, credentials, or model provider is needed. All
interactions are editorial illustrations, not runtime commands or measurements.

```sh
nix develop -c just bootstrap
nix develop -c just run-demo
```

Open **http://127.0.0.1:3212**. For a production presentation:

```sh
nix develop -c just build-package @devrandom/demo
nix develop -c just start-demo
```

Use the chapter rail or arrow keys to navigate. Autoplay advances every 14
seconds and pauses on interaction. Presenter notes provide a talk track for
each chapter; the fullscreen button helps on a projector. Animation can be
paused and respects the operating system's reduced-motion preference.

## Pitch route

1. **The idea:** an adaptable harness with independently bounded authority.
2. **Identity:** user, agent, Governor; two different mandates.
3. **The harness:** task-first specialization and more than a prompt.
4. **Memory:** complete addressable evidence and bounded working context.
5. **Evolution:** hypotheses, immutable candidates, protected evaluation.
6. **Promotion:** evidence, Governor signature, server commit, local activation.
7. **Boundaries:** explain four rejected attacks.
8. **Continuity:** process loss, recovery, and current authority.
9. **Sharing:** sanitize behavior without transferring private authority.
10. **What's next:** clearly deferred infrastructure possibilities.

The core narrative does not report a measured winner or invent benchmark
scores. Future capabilities are labeled as future. The decision exception was
explicitly approved by the user on 2026-09-26 and recorded in
`docs/hackathon-decision.md` (the repository ignores the local `docs/` tree).

## Ownership and validation

This advances the approved standalone-pitch exception and the presentation
portion of demo hardening, explaining E1–E6 without claiming their acceptance.
The bounded context is pitch presentation. `pitch-chapters.ts` owns editorial
copy; `pitch-artwork.tsx` and `pitch-stage.tsx` are browser presentation adapters;
`pitch-experience.tsx` owns navigation and ephemeral illustration controls.
`app/` and `pitch-theme.tsx` compose Next.js and Material UI. Dependencies stay
inside this app and its UI libraries; there is no product domain model or
cross-application import. There is no browser API client because no API is used.

The smoke starts the production Next.js server, retrieves the page over HTTP,
and exercises the actual Chromium UI, including blocked promotion explanations,
recovery, sharing, mobile navigation, reduced motion, and network isolation.
It runs as part of `just check`.

For first-time browser setup use `nix develop -c just demo-install`; then run
`nix develop -c just smoke-demo` after building. Linux CI may additionally need
Playwright's Chromium system libraries supplied by its runner/environment.

## Verified on 2026-09-26

`nix develop -c just check` passed on aarch64-darwin: formatting, lint,
strict types, 2,408 passing tests (145 skipped), workspace boundaries, every
application build and live smoke, all four Chromium pitch checks, and the
local Nix flake check. Linux execution was not run locally.

The pitch was also served on `127.0.0.1:3212` with HTTP 200. Desktop, evolution,
and reduced-motion mobile screenshots were inspected. Generated screenshots
and failure traces are written under the ignored `apps/demo/test-results/`.
