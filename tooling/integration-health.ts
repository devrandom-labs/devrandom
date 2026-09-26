interface ComposeProcess {
  readonly Health?: unknown;
  readonly Service?: unknown;
  readonly State?: unknown;
}

function composeProcess(value: unknown): ComposeProcess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Compose service status must be an object');
  }

  return value;
}

function processRecords(source: string): readonly ComposeProcess[] {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new Error('Compose returned no service status records');
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed)
      ? parsed.map((value) => composeProcess(value))
      : [composeProcess(parsed)];
  } catch {
    return trimmed.split('\n').map((line) => composeProcess(JSON.parse(line) as unknown));
  }
}

const completeServiceSet = ['keria', 'mongodb', 'server', 'site', 'witnesses'] as const;
type ExpectedService = (typeof completeServiceSet)[number];

function isExpectedService(value: string): value is ExpectedService {
  return completeServiceSet.some((service) => service === value);
}

const requestedServices = process.argv.slice(2);
if (requestedServices.some((service) => !isExpectedService(service))) {
  throw new Error('Compose health service selection contains an unknown service');
}
const expectedServices: readonly ExpectedService[] =
  requestedServices.length === 0 ? completeServiceSet : requestedServices.filter(isExpectedService);
if (new Set(expectedServices).size !== expectedServices.length) {
  throw new Error('Compose health service selection contains a duplicate');
}
process.stdin.setEncoding('utf8');
let source = '';
for await (const chunk of process.stdin) {
  if (typeof chunk !== 'string') {
    throw new Error('Compose status input was not UTF-8 text');
  }
  source += chunk;
}
const records = processRecords(source);
const statusByService = new Map(records.map((record) => [record.Service, record] as const));

for (const service of expectedServices) {
  const status = statusByService.get(service);
  if (status === undefined) {
    throw new Error(`Compose service ${service} has no running container`);
  }

  if (status.State !== 'running' || status.Health !== 'healthy') {
    throw new Error(
      `Compose service ${service} is not ready (state=${String(status.State)}, health=${String(status.Health)})`,
    );
  }
}

process.stdout.write(`healthy: ${expectedServices.join(', ')}\n`);
