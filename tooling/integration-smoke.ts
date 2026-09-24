function localPort(name: string, fallback: number): number {
  const source = process.env[name];
  if (source === undefined) {
    return fallback;
  }

  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return port;
}

type IntegrationSmokeScope = 'mechanism' | 'complete';

function integrationSmokeScope(argumentsAfterCommand: readonly string[]): IntegrationSmokeScope {
  if (argumentsAfterCommand.length === 0) {
    return 'complete';
  }
  if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === 'mechanism') {
    return 'mechanism';
  }
  if (argumentsAfterCommand.length === 1 && argumentsAfterCommand[0] === 'complete') {
    return 'complete';
  }
  throw new Error('usage: integration-smoke.ts [mechanism|complete]');
}

async function expectResponse(url: string, expectedText?: string): Promise<void> {
  const response = await fetch(url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} returned ${String(response.status)}`);
  }

  if (expectedText !== undefined && !body.includes(expectedText)) {
    throw new Error(`${url} did not contain ${expectedText}`);
  }
}

const scope = integrationSmokeScope(process.argv.slice(2));
const probes = [
  expectResponse(
    `http://127.0.0.1:${String(localPort('DEVRANDOM_ISSUER_PORT', 3211))}/health`,
    '"status":"ready"',
  ),
  expectResponse(
    `http://127.0.0.1:${String(localPort('DEVRANDOM_KERIA_HTTP_PORT', 3902))}/spec.yaml`,
    'openapi:',
  ),
  expectResponse(`http://127.0.0.1:${String(localPort('DEVRANDOM_WITNESS_WAN_PORT', 5642))}/oobi`),
] as Promise<void>[];
if (scope === 'complete') {
  probes.push(
    expectResponse(
      `http://127.0.0.1:${String(localPort('DEVRANDOM_SITE_PORT', 3210))}/`,
      'Devrandom',
    ),
  );
}
await Promise.all(probes);

process.stdout.write(
  scope === 'complete'
    ? 'integration smoke passed: site, issuer, KERIA, witnesses\n'
    : 'integration smoke passed: issuer, KERIA, witnesses\n',
);
