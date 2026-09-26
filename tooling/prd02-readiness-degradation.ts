const serverOrigin = process.env.DEVRANDOM_SERVER_URL;
const siteOrigin = process.env.DEVRANDOM_SITE_URL;

type ProbeBody = {
  readonly service?: unknown;
  readonly status?: unknown;
  readonly issuerAid?: unknown;
  readonly code?: unknown;
  readonly dependency?: unknown;
};

if (serverOrigin === undefined || siteOrigin === undefined) {
  throw new Error('The server and site URLs are required');
}

async function json(path: string): Promise<{ status: number; body: ProbeBody }> {
  const response = await fetch(new URL(path, serverOrigin), {
    headers: path === '/api/tasks' ? { authorization: `Bearer ${'s'.repeat(43)}` } : {},
  });
  return { status: response.status, body: (await response.json()) as ProbeBody };
}

function assertResponse(
  label: string,
  actual: { status: number; body: ProbeBody },
  status: number,
  fields: ProbeBody,
): void {
  if (
    actual.status !== status ||
    Object.entries(fields).some(([key, value]) => actual.body[key as keyof ProbeBody] !== value)
  ) {
    throw new Error(`${label}: unexpected response ${JSON.stringify(actual)}`);
  }
}

const live = await json('/health/live');
const identity = await json('/ready/identity');
const health = await json('/health');
const work = await json('/ready/work');
const tasks = await json('/api/tasks');
assertResponse('server liveness', live, 200, { service: 'devrandom-server', status: 'live' });
assertResponse('identity readiness', identity, 200, { service: 'issuer', status: 'ready' });
assertResponse('retained health', health, 200, { service: 'issuer', status: 'ready' });
assertResponse('work readiness', work, 503, { service: 'hosted-work', status: 'unavailable' });
assertResponse('Task failure', tasks, 503, {
  status: 503,
  code: 'TaskUnavailable',
  dependency: 'HostedMongoDB',
});
if (health.body.issuerAid !== identity.body.issuerAid) {
  throw new Error('Health and identity readiness disagree on the issuer');
}

const registration = await fetch(siteOrigin);
const registrationHtml = await registration.text();
if (
  registration.status !== 200 ||
  !registrationHtml.includes('Devrandom Labs') ||
  !registrationHtml.includes('registration')
) {
  throw new Error('The served registration page is unavailable');
}
const proxiedHealth = await fetch(new URL('/api/issuer/health', siteOrigin));
const proxiedBody = (await proxiedHealth.json()) as ProbeBody;
assertResponse('site identity proxy', { status: proxiedHealth.status, body: proxiedBody }, 200, {
  service: 'issuer',
  status: 'ready',
  issuerAid: identity.body.issuerAid,
});

process.stdout.write('A06 live degradation: site and identity ready; work and Task unavailable.\n');
