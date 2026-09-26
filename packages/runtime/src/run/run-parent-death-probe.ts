import { prepareEvaluationExecutionProfile } from '@devrandom/protocol';

import { DockerEvaluationCompartment } from '../evaluation/infrastructure/docker-compartment.js';

const [image, runtimeDigest, runtimeHostPath, worktreeDirectory] = process.argv.slice(2);
if (
  image === undefined ||
  runtimeDigest === undefined ||
  runtimeHostPath === undefined ||
  worktreeDirectory === undefined
)
  process.exit(2);
const said = (character: string): string => `E${character.repeat(43)}`;
const prepared = prepareEvaluationExecutionProfile({
  os: 'linux',
  architecture: 'aarch64',
  imageDigest: image,
  runtimeDigest,
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
const mounts = [{ hostPath: runtimeHostPath, containerPath: '/app/runtime', writable: false }];
const worker = await DockerEvaluationCompartment.open({
  profile: prepared.profile,
  image,
  mounts: [
    ...mounts,
    { hostPath: worktreeDirectory, containerPath: '/work/source', writable: false },
  ],
  signal: new AbortController().signal,
});
if (worker.kind !== 'Opened') process.exit(3);
const native = await DockerEvaluationCompartment.open({
  profile: prepared.profile,
  image,
  mounts: [
    ...mounts,
    { hostPath: worktreeDirectory, containerPath: '/work/source', writable: true },
  ],
  signal: new AbortController().signal,
});
if (native.kind !== 'Opened') {
  await worker.compartment.close();
  process.exit(4);
}
const workerInspect = JSON.parse(worker.effectiveLimitsReceipt) as [{ Name: string }];
const nativeInspect = JSON.parse(native.effectiveLimitsReceipt) as [{ Name: string }];
process.stdout.write(
  `${JSON.stringify({
    worker: workerInspect[0].Name.slice(1),
    native: nativeInspect[0].Name.slice(1),
  })}\n`,
);
setInterval(() => undefined, 1000);
