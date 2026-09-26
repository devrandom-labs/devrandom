import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';

import { DockerEvaluationCompartment } from './docker-compartment.js';

const image = process.argv[2] ?? '';
const said = (character: string): string => `E${character.repeat(43)}`;
const prepared = prepareEvaluationExecutionProfile({
  os: 'linux',
  architecture: 'aarch64',
  imageDigest: image,
  runtimeDigest: `sha256:${'1'.repeat(64)}`,
  toolchainDigest: `sha256:${'2'.repeat(64)}`,
  sourceGitCommit: '3'.repeat(40),
  sourceGitTree: '4'.repeat(40),
  h1InstructionSaid: said('i'),
  h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
  effectiveLimitsReceiptSaid: said('l'),
  parentDeathCleanupReceiptSaid: said('p'),
  modelProvider: 'fixture',
  modelId: 'fixture',
  thinkingLevel: 'low',
  maximumOutputTokens: 64,
  limits: {
    cpuCount: 1,
    memoryBytes: 128 * 1024 * 1024,
    processCount: 16,
    scratchBytes: 1024 * 1024,
    outputBytes: 64 * 1024,
    wallTimeSeconds: 60,
  },
  containment: {
    nonRoot: true,
    readOnlyRuntime: true,
    networkDisabled: true,
    privilegesDropped: true,
    restrictedIpc: true,
    parentDeathCleanup: true,
  },
});
if (prepared.kind !== 'Prepared') process.exit(2);
const opened = await DockerEvaluationCompartment.open({
  profile: prepared.profile,
  image,
  mounts: [],
  signal: new AbortController().signal,
});
if (opened.kind !== 'Opened') process.exit(3);
const inspect = JSON.parse(opened.effectiveLimitsReceipt) as [{ Name: string }];
process.stdout.write(`${JSON.stringify({ name: inspect[0].Name.slice(1) })}\n`);
setInterval(() => undefined, 1000);
