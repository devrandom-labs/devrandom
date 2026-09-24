set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

_require-nix:
    @test "${DEVRANDOM_NIX_SHELL:-}" = "1" || { echo "enter with 'nix develop' or enable direnv" >&2; exit 1; }

bootstrap: _require-nix
    pnpm install --frozen-lockfile

format: _require-nix
    pnpm run _format
    nix fmt flake.nix

format-check: _require-nix
    pnpm run _format:check
    nix fmt -- --check flake.nix

lint: _require-nix
    pnpm run _lint

typecheck: _require-nix
    pnpm run _typecheck

version-audit: _require-nix
    pnpm exec tsx tooling/version-audit.ts

integration-runtime-start: _require-nix
    @if command -v colima >/dev/null 2>&1; then colima start --cpu 4 --memory 8 --disk 30; else docker info >/dev/null; fi

integration-up: _require-nix
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" up --detach --build --wait --wait-timeout 180

integration-health: _require-nix
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" ps --format json | pnpm exec tsx tooling/integration-health.ts

integration-logs: _require-nix
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" logs --tail 200

integration-reset: _require-nix
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" down --volumes --remove-orphans
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" up --detach --build --wait --wait-timeout 180

integration-down: _require-nix
    docker compose --env-file "${DEVRANDOM_ENV_FILE:-.env.example}" down --remove-orphans

up: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v colima >/dev/null 2>&1; then
      colima start --cpu 4 --memory 8 --disk 30
    else
      docker info >/dev/null
    fi
    demo_env="${DEVRANDOM_ENV_FILE:-.env}"
    test -f "$demo_env" || { echo "$demo_env is required; it must contain DEVRANDOM_ISSUER_BRAN" >&2; exit 2; }
    permissions="$(stat -c '%a' "$demo_env")"
    (( (8#$permissions & 077) == 0 )) || { echo "$demo_env must not be readable by group or others; run chmod 600 $demo_env" >&2; exit 2; }
    repository_root="$PWD"
    export DEVRANDOM_STATE_DIR="${DEVRANDOM_DEMO_ISSUER_STATE_DIR:-$repository_root/.devrandom/demo-issuer}"
    mkdir -p "$DEVRANDOM_STATE_DIR"
    pnpm install --frozen-lockfile
    pnpm --filter @devrandom/domain run build
    pnpm --filter @devrandom/protocol run build
    pnpm --filter @devrandom/identity run build
    pnpm --filter @devrandom/cli run build
    docker compose --env-file "$demo_env" build issuer
    docker compose --env-file "$demo_env" build site
    docker compose --env-file "$demo_env" up --detach --wait --wait-timeout 180 mongodb keria
    docker compose --env-file "$demo_env" run --rm --no-deps issuer bootstrap
    docker compose --env-file "$demo_env" up --detach --no-deps --wait --wait-timeout 120 issuer
    docker compose --env-file "$demo_env" up --detach --no-deps --wait --wait-timeout 120 site
    docker compose --env-file "$demo_env" ps --format json | pnpm exec tsx tooling/integration-health.ts
    node_modules/.bin/devrandom status
    echo "Devrandom is ready. Run: devrandom init"

down: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    demo_env="${DEVRANDOM_ENV_FILE:-.env}"
    export DEVRANDOM_STATE_DIR="${DEVRANDOM_DEMO_ISSUER_STATE_DIR:-$PWD/.devrandom/demo-issuer}"
    docker compose --env-file "$demo_env" down --remove-orphans

test-mongodb-integration: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    integration_env="${DEVRANDOM_ENV_FILE:-.env.example}"
    project="${DEVRANDOM_MONGODB_COMPOSE_PROJECT:-devrandom-mongodb-e0}"
    cleanup() {
      docker compose --project-name "$project" --env-file "$integration_env" down --volumes --remove-orphans
    }
    trap cleanup EXIT INT TERM
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --wait --wait-timeout 90 mongodb
    mongodb_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port mongodb 27017 | tail -n 1)"
    DEVRANDOM_MONGODB_URI="mongodb://$mongodb_endpoint/?directConnection=true" pnpm exec vitest run \
      packages/storage/src/e0/mongodb.integration.spec.ts \
      services/issuer/src/registration/infrastructure/mongo-registration-sessions.integration.spec.ts

test-identity-integration: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    integration_env="${DEVRANDOM_ENV_FILE:-.env.example}"
    project="${DEVRANDOM_IDENTITY_COMPOSE_PROJECT:-devrandom-identity-e0}"
    export DEVRANDOM_KERIA_ADMIN_PORT=0
    export DEVRANDOM_KERIA_HTTP_PORT=0
    export DEVRANDOM_KERIA_BOOT_PORT=0
    export DEVRANDOM_WITNESS_WAN_PORT=0
    export DEVRANDOM_WITNESS_WIL_PORT=0
    export DEVRANDOM_WITNESS_WES_PORT=0
    cleanup() {
      docker compose --project-name "$project" --env-file "$integration_env" down --volumes --remove-orphans
    }
    trap cleanup EXIT INT TERM
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --wait --wait-timeout 120 keria
    keria_admin="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3901 | tail -n 1)"
    keria_boot="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3903 | tail -n 1)"
    DEVRANDOM_KERIA_ADMIN_URL="http://$keria_admin" \
      DEVRANDOM_KERIA_BOOT_URL="http://$keria_boot" \
      DEVRANDOM_WITNESS_WAN_URL="http://witnesses:5642" \
      pnpm exec vitest run packages/identity/src/e0/keria.integration.spec.ts || test_status=$?
    if [[ "${test_status:-0}" -ne 0 ]]; then
      docker compose --project-name "$project" --env-file "$integration_env" logs --tail 120 keria witnesses >&2
      exit "$test_status"
    fi

test-issuer-bootstrap-integration: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    integration_env="${DEVRANDOM_ENV_FILE:-.env}"
    test -f "$integration_env" || { echo "$integration_env is required for the issuer secret" >&2; exit 2; }
    permissions="$(stat -c '%a' "$integration_env")"
    (( (8#$permissions & 077) == 0 )) || { echo "$integration_env must not be readable by group or others" >&2; exit 2; }

    scenario_root="$PWD/.devrandom"
    mkdir -p "$scenario_root"
    scenario_directory="$(mktemp -d "$scenario_root/issuer-bootstrap.XXXXXX")"
    project="${DEVRANDOM_ISSUER_COMPOSE_PROJECT:-devrandom-issuer-bootstrap-$$}"
    export DEVRANDOM_STATE_DIR="$scenario_directory/state"
    export DEVRANDOM_KERIA_ADMIN_PORT=0
    export DEVRANDOM_KERIA_HTTP_PORT=0
    export DEVRANDOM_KERIA_BOOT_PORT=0
    export DEVRANDOM_ISSUER_PORT=0
    export DEVRANDOM_MONGODB_PORT=0
    export DEVRANDOM_WITNESS_WAN_PORT=0
    export DEVRANDOM_WITNESS_WIL_PORT=0
    export DEVRANDOM_WITNESS_WES_PORT=0

    cleanup() {
      status=$?
      if [[ "$status" -ne 0 ]]; then
        docker compose --project-name "$project" --env-file "$integration_env" logs --tail 160 issuer keria >&2 || true
      fi
      docker compose --project-name "$project" --env-file "$integration_env" down --volumes --remove-orphans || true
      rm -rf "$scenario_directory"
      return "$status"
    }
    assert_issuer_health() {
      for attempt in {1..20}; do
        if DEVRANDOM_ISSUER_HEALTH_URL="http://$issuer_endpoint/health" node -e 'fetch(process.env.DEVRANDOM_ISSUER_HEALTH_URL).then(async response => { const body = await response.json(); process.exit(response.ok && body.service === "issuer" && body.status === "ready" ? 0 : 1); }).catch(() => process.exit(1));'; then
          return 0
        fi
        sleep 0.25
      done
      echo "issuer health route did not return its ready contract" >&2
      return 1
    }
    trap cleanup EXIT INT TERM

    pnpm --filter @devrandom/protocol run build
    pnpm --filter @devrandom/identity run build
    credential_schema_said="$(node --input-type=module -e 'import { credentialSchema } from "./packages/protocol/dist/index.js"; process.stdout.write(credentialSchema.$id);')"
    docker compose --project-name "$project" --env-file "$integration_env" build issuer
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --wait --wait-timeout 120 mongodb keria
    docker compose --project-name "$project" --env-file "$integration_env" run --rm --no-deps issuer bootstrap | tee "$scenario_directory/first-bootstrap.txt"
    cp "$scenario_directory/state/issuer-profile.json" "$scenario_directory/first-profile.json"
    docker compose --project-name "$project" --env-file "$integration_env" run --rm --no-deps issuer bootstrap | tee "$scenario_directory/second-bootstrap.txt"
    cmp "$scenario_directory/first-profile.json" "$scenario_directory/state/issuer-profile.json"
    grep -q '^Devrandom issuer provisioned\.$' "$scenario_directory/first-bootstrap.txt"
    grep -q '^Devrandom issuer verified\.$' "$scenario_directory/second-bootstrap.txt"
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --no-deps --wait --wait-timeout 120 issuer
    issuer_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port issuer 3211 | tail -n 1)"
    assert_issuer_health
    keria_admin="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3901 | tail -n 1)"
    keria_boot="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3903 | tail -n 1)"
    DEVRANDOM_KERIA_ADMIN_URL="http://$keria_admin" \
      DEVRANDOM_KERIA_BOOT_URL="http://$keria_boot" \
      DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL="http://issuer:3211/oobi/$credential_schema_said" \
      node --env-file="$integration_env" -e 'const { spawnSync } = require("node:child_process"); if (!process.env.DEVRANDOM_ISSUER_BRAN) { console.error("DEVRANDOM_ISSUER_BRAN is required"); process.exit(2); } const result = spawnSync("pnpm", ["exec", "vitest", "run", "packages/identity/src/e0/acdc.integration.spec.ts"], { env: process.env, stdio: "inherit" }); process.exit(result.status ?? 1);' || credential_test_status=$?
    if [[ "${credential_test_status:-0}" -ne 0 ]]; then
      docker compose --project-name "$project" --env-file "$integration_env" logs --tail 160 issuer keria >&2
      exit "$credential_test_status"
    fi
    cmp "$scenario_directory/first-profile.json" "$scenario_directory/state/issuer-profile.json" || { echo "issuer profile changed while serving" >&2; exit 1; }
    docker compose --project-name "$project" --env-file "$integration_env" restart issuer
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --no-deps --wait --wait-timeout 120 issuer
    issuer_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port issuer 3211 | tail -n 1)"
    assert_issuer_health
    cmp "$scenario_directory/first-profile.json" "$scenario_directory/state/issuer-profile.json" || { echo "issuer profile changed after restart" >&2; exit 1; }

test-integration: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    integration_env="${DEVRANDOM_ENV_FILE:-.env.example}"
    project="${DEVRANDOM_INTEGRATION_COMPOSE_PROJECT:-devrandom-e0-$$}"
    scenario_root="$PWD/.devrandom"
    mkdir -p "$scenario_root"
    scenario_directory="$(mktemp -d "$scenario_root/integration.XXXXXX")"
    export DEVRANDOM_STATE_DIR="$scenario_directory/state"
    DEVRANDOM_ISSUER_BRAN="$(pnpm --filter @devrandom/identity exec node --input-type=module -e 'import { randomPasscode, ready } from "signify-ts"; await ready(); process.stdout.write(randomPasscode());')"
    export DEVRANDOM_ISSUER_BRAN
    export DEVRANDOM_ISSUER_PORT=0
    export DEVRANDOM_KERIA_ADMIN_PORT=0
    export DEVRANDOM_KERIA_HTTP_PORT=0
    export DEVRANDOM_KERIA_BOOT_PORT=0
    export DEVRANDOM_MONGODB_PORT=0
    export DEVRANDOM_WITNESS_WAN_PORT=0
    export DEVRANDOM_WITNESS_WIL_PORT=0
    export DEVRANDOM_WITNESS_WES_PORT=0
    cleanup() {
      docker compose --project-name "$project" --env-file "$integration_env" down --volumes --remove-orphans
      rm -rf "$scenario_directory"
    }
    trap cleanup EXIT INT TERM
    pnpm --filter @devrandom/protocol run build
    pnpm --filter @devrandom/identity run build
    credential_schema_said="$(node --input-type=module -e 'import { credentialSchema } from "./packages/protocol/dist/index.js"; process.stdout.write(credentialSchema.$id);')"
    docker compose --project-name "$project" --env-file "$integration_env" build issuer
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --wait --wait-timeout 180 mongodb keria
    docker compose --project-name "$project" --env-file "$integration_env" run --rm --no-deps issuer bootstrap
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --no-deps --wait --wait-timeout 120 issuer
    docker compose --project-name "$project" --env-file "$integration_env" ps --format json | pnpm exec tsx tooling/integration-health.ts mongodb witnesses keria issuer
    mongodb_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port mongodb 27017 | tail -n 1)"
    DEVRANDOM_MONGODB_URI="mongodb://$mongodb_endpoint/?directConnection=true" pnpm exec vitest run packages/storage/src/e0/mongodb.integration.spec.ts
    issuer_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port issuer 3211 | tail -n 1)"
    keria_admin="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3901 | tail -n 1)"
    keria_http="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3902 | tail -n 1)"
    keria_boot="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3903 | tail -n 1)"
    witness_wan="$(docker compose --project-name "$project" --env-file "$integration_env" port witnesses 5642 | tail -n 1)"
    DEVRANDOM_KERIA_ADMIN_URL="http://$keria_admin" \
      DEVRANDOM_KERIA_BOOT_URL="http://$keria_boot" \
      DEVRANDOM_WITNESS_WAN_URL="http://witnesses:5642" \
      DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL="http://issuer:3211/oobi/$credential_schema_said" \
      pnpm exec vitest run \
        packages/identity/src/e0/keria.integration.spec.ts \
        packages/identity/src/e0/acdc.integration.spec.ts
    DEVRANDOM_ISSUER_PORT="${issuer_endpoint##*:}" \
      DEVRANDOM_KERIA_HTTP_PORT="${keria_http##*:}" \
      DEVRANDOM_WITNESS_WAN_PORT="${witness_wan##*:}" \
      pnpm exec tsx tooling/integration-smoke.ts mechanism

test-identity-journey: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    integration_env="${DEVRANDOM_ENV_FILE:-.env.example}"
    project="${DEVRANDOM_IDENTITY_JOURNEY_PROJECT:-devrandom-identity-journey-$$}"
    scenario_root="$PWD/.devrandom"
    mkdir -p "$scenario_root"
    scenario_directory="$(mktemp -d "$scenario_root/identity-journey.XXXXXX")"
    export DEVRANDOM_STATE_DIR="$scenario_directory/issuer-state"
    DEVRANDOM_ISSUER_BRAN="$(pnpm --filter @devrandom/identity exec node --input-type=module -e 'import { randomPasscode, ready } from "signify-ts"; await ready(); process.stdout.write(randomPasscode());')"
    export DEVRANDOM_ISSUER_BRAN
    export DEVRANDOM_ISSUER_PORT=0
    export DEVRANDOM_KERIA_ADMIN_PORT=0
    export DEVRANDOM_KERIA_HTTP_PORT=0
    export DEVRANDOM_KERIA_BOOT_PORT=0
    export DEVRANDOM_MONGODB_PORT=0
    DEVRANDOM_SITE_PORT="$(node -e 'const server = require("node:net").createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (typeof address === "string" || address === null) process.exit(1); process.stdout.write(String(address.port)); server.close(); });')"
    export DEVRANDOM_SITE_PORT
    export DEVRANDOM_WITNESS_WAN_PORT=0
    export DEVRANDOM_WITNESS_WIL_PORT=0
    export DEVRANDOM_WITNESS_WES_PORT=0
    cleanup() {
      status=$?
      if [[ "$status" -ne 0 ]]; then
        docker compose --project-name "$project" --env-file "$integration_env" logs --tail 200 issuer site keria mongodb witnesses >&2 || true
      fi
      docker compose --project-name "$project" --env-file "$integration_env" down --volumes --remove-orphans || true
      rm -rf "$scenario_directory"
      return "$status"
    }
    profile_value() {
      PROFILE_PATH="$scenario_directory/issuer-state/issuer-profile.json" PROFILE_FIELD="$1" node -e 'const fs = require("node:fs"); const fields = new Set(["issuerAid", "issuerOobi", "registryId"]); const field = process.env.PROFILE_FIELD; if (!field || !fields.has(field)) process.exit(2); const value = JSON.parse(fs.readFileSync(process.env.PROFILE_PATH, "utf8"))[field]; if (typeof value !== "string" || value.length === 0) process.exit(2); process.stdout.write(value);'
    }
    trap cleanup EXIT INT TERM

    pnpm --filter @devrandom/domain run build
    pnpm --filter @devrandom/protocol run build
    pnpm --filter @devrandom/identity run build
    pnpm --filter @devrandom/cli run build
    pnpm --filter @devrandom/site exec playwright install chromium
    docker compose --project-name "$project" --env-file "$integration_env" build issuer
    docker compose --project-name "$project" --env-file "$integration_env" build site
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --wait --wait-timeout 180 mongodb keria
    docker compose --project-name "$project" --env-file "$integration_env" run --rm --no-deps issuer bootstrap
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --no-deps --wait --wait-timeout 120 issuer
    docker compose --project-name "$project" --env-file "$integration_env" up --detach --no-deps --wait --wait-timeout 120 site
    docker compose --project-name "$project" --env-file "$integration_env" ps --format json | pnpm exec tsx tooling/integration-health.ts

    issuer_endpoint="$(docker compose --project-name "$project" --env-file "$integration_env" port issuer 3211 | tail -n 1)"
    keria_admin="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3901 | tail -n 1)"
    keria_http="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3902 | tail -n 1)"
    keria_boot="$(docker compose --project-name "$project" --env-file "$integration_env" port keria 3903 | tail -n 1)"
    witness_wan="$(docker compose --project-name "$project" --env-file "$integration_env" port witnesses 5642 | tail -n 1)"
    issuer_aid="$(profile_value issuerAid)"
    issuer_oobi="$(profile_value issuerOobi)"
    registry_id="$(profile_value registryId)"
    credential_schema_said="$(node --input-type=module -e 'import { credentialSchema } from "./packages/protocol/dist/index.js"; process.stdout.write(credentialSchema.$id);')"
    DEVRANDOM_USER_STATE_DIR="$scenario_directory/user-state" \
      DEVRANDOM_PLAYWRIGHT_OUTPUT_DIR="$scenario_directory/playwright-artifacts" \
      DEVRANDOM_KERIA_ADMIN_URL="http://$keria_admin" \
      DEVRANDOM_KERIA_BOOT_URL="http://$keria_boot" \
      DEVRANDOM_ISSUER_URL="http://$issuer_endpoint" \
      DEVRANDOM_ISSUER_AID="$issuer_aid" \
      DEVRANDOM_ISSUER_OOBI="$issuer_oobi" \
      DEVRANDOM_CREDENTIAL_REGISTRY_ID="$registry_id" \
      DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL="http://issuer:3211/oobi/$credential_schema_said" \
      DEVRANDOM_REGISTRATION_SITE_URL="http://127.0.0.1:$DEVRANDOM_SITE_PORT" \
      DEVRANDOM_WITNESS_AID="BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha" \
      DEVRANDOM_WITNESS_OOBI="http://witnesses:5642/oobi/BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha" \
      DEVRANDOM_SITE_URL="http://127.0.0.1:$DEVRANDOM_SITE_PORT" \
      pnpm --filter @devrandom/site run e2e
    DEVRANDOM_ISSUER_PORT="${issuer_endpoint##*:}" \
      DEVRANDOM_KERIA_HTTP_PORT="${keria_http##*:}" \
      DEVRANDOM_WITNESS_WAN_PORT="${witness_wan##*:}" \
      pnpm exec tsx tooling/integration-smoke.ts
    compose_logs="$(docker compose --project-name "$project" --env-file "$integration_env" logs --no-color issuer site)"
    user_bran="$(CUSTODY_PATH="$scenario_directory/user-state/signify-custody.json" node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.env.CUSTODY_PATH, "utf8")); if (value.version !== 1 || typeof value.bran !== "string" || !/^[A-Za-z0-9_-]{21}$/.test(value.bran)) process.exit(2); process.stdout.write(value.bran);')"
    ! grep -Fq 'identity-acceptance@example.test' <<<"$compose_logs"
    ! grep -Eq '(cli_|browser_)[A-Za-z0-9_-]{32}' <<<"$compose_logs"
    ! grep -Fq -- "$user_bran" <<<"$compose_logs"

test-atlas-integration: _require-nix
    #!/usr/bin/env bash
    set -euo pipefail
    atlas_env="${DEVRANDOM_ATLAS_ENV_FILE:-.env}"
    if [[ -f "$atlas_env" ]]; then
      permissions="$(stat -c '%a' "$atlas_env")"
      (( (8#$permissions & 077) == 0 )) || { echo "$atlas_env must not be readable by group or others; run chmod 600 $atlas_env" >&2; exit 1; }
      node --env-file="$atlas_env" -e 'const { spawnSync } = require("node:child_process"); if (!process.env.DEVRANDOM_ATLAS_URI) { console.error("DEVRANDOM_ATLAS_URI is required"); process.exit(1); } const result = spawnSync("pnpm", ["exec", "vitest", "run", "packages/storage/src/e0/atlas-vector.integration.spec.ts"], { env: process.env, stdio: "inherit" }); process.exit(result.status ?? 1);'
    else
      test -n "${DEVRANDOM_ATLAS_URI:-}" || { echo "DEVRANDOM_ATLAS_URI is required" >&2; exit 1; }
      pnpm exec vitest run packages/storage/src/e0/atlas-vector.integration.spec.ts
    fi

test: _require-nix
    pnpm run _test

boundaries: _require-nix
    pnpm run _boundaries

openapi: _require-nix
    pnpm --filter @devrandom/issuer run openapi

contracts: _require-nix
    pnpm --filter @devrandom/protocol run build
    pnpm --filter @devrandom/issuer run credential-schema
    pnpm --filter @devrandom/issuer run openapi
    pnpm --filter @devrandom/site run api:generate

build: _require-nix
    pnpm -r --if-present run build

smoke: _require-nix build
    pnpm --filter @devrandom/cli run smoke
    pnpm --filter @devrandom/issuer run smoke
    pnpm --filter @devrandom/site run smoke

run-cli: _require-nix
    pnpm --filter @devrandom/cli run dev -- status

run-issuer: _require-nix
    pnpm --filter @devrandom/issuer run dev

run-site: _require-nix
    pnpm --filter @devrandom/site run dev -- --hostname 127.0.0.1 --port 3210

check: _require-nix format-check lint typecheck test boundaries build smoke
    nix flake check
