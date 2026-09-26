import { describe, expect, it, vi } from 'vitest';
import { derivePortableBehavior } from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareHarnessPackage,
  prepareSuccessorHarnessRevision,
  type ActiveHarnessPointer,
  type PublishHarnessCommand,
} from '@devrandom/protocol';
import { publishHarness, type PublicationAdmissionDependencies } from './publish-harness.js';
const said = `E${'a'.repeat(43)}`;
function fixture() {
  const configuration = { version: 1, arm: 'C2' };
  const implementation = {
    version: 1,
    kind: 'RecoveryWorkflow',
    trigger: 'QualifiedRetainedFailure',
    steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
  };
  const config = prepareEvidenceArtifact(
    Buffer.from(JSON.stringify(configuration)),
    'application/json',
  );
  const impl = prepareEvidenceArtifact(
    Buffer.from(JSON.stringify(implementation)),
    'application/octet-stream',
  );
  if (config.kind !== 'Prepared' || impl.kind !== 'Prepared') throw new Error('artifact');
  const revision = prepareSuccessorHarnessRevision({
    parentRevisionSaid: said,
    h0Said: said,
    taskRevisionSaid: said,
    sourceInventorySaid: said,
    executionProfileSaid: said,
    configurationArtifactSaid: config.artifact.d,
    arm: 'C2',
    treatment: {
      kind: 'ReviewedWorkflow',
      reviewedImplementationSaid: impl.artifact.d,
      publicReplayReceiptSaid: said,
    },
  });
  const behavior = derivePortableBehavior(configuration, implementation, []);
  if (revision.kind !== 'Prepared' || behavior.kind !== 'Portable') throw new Error('revision');
  const prepared = prepareHarnessPackage({
    publisherAid: said,
    sourceRevisionSaid: revision.revision.d,
    behavior: behavior.behavior,
  });
  if (prepared.kind !== 'Prepared') throw new Error('package');
  const command: PublishHarnessCommand = {
    version: 1,
    commandId: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002',
    activationReceiptSaid: said,
    sourceRevision: revision.revision,
    configurationBase64: Buffer.from(JSON.stringify(configuration)).toString('base64'),
    implementationBase64: Buffer.from(JSON.stringify(implementation)).toString('base64'),
    published: {
      package: prepared.package,
      signature: { exchange: {}, signatures: ['A'.repeat(88)], keyStateSaid: said },
    },
  };
  const pointer: ActiveHarnessPointer = {
    version: 1,
    kind: 'Committed',
    taskId: command.taskId,
    taskRevisionSaid: said,
    harnessLineageId: '00000000-0000-4000-8000-000000000003',
    activeRevisionSaid: revision.revision.d,
    pointerVersion: 2,
    commandId: command.commandId,
    decisionReceiptSaid: said,
    disposition: 'Activated',
  };
  const store = vi
    .fn<PublicationAdmissionDependencies['storage']['publish']>()
    .mockResolvedValue({ kind: 'Published', packageSaid: prepared.package.d });
  const dependencies: PublicationAdmissionDependencies = {
    activation: { readCurrent: vi.fn().mockResolvedValue({ kind: 'Read', pointer }) },
    signatures: { verify: vi.fn().mockResolvedValue('Verified') },
    storage: { publish: store, read: vi.fn().mockResolvedValue({ kind: 'Absent' }) },
    fingerprint: () => 'stable-private-command-fingerprint',
  };
  return { command, pointer, dependencies, store };
}
describe('hosted publication admission', () => {
  it('accepts only exact committed behavior with native publisher verification and stores no source custody', async () => {
    const f = fixture();
    expect(await publishHarness({ ownerAid: said, command: f.command }, f.dependencies)).toEqual({
      kind: 'Published',
      packageSaid: f.command.published.package.d,
    });
    expect(f.store).toHaveBeenCalledWith({
      ownerAid: said,
      commandId: f.command.commandId,
      fingerprint: 'stable-private-command-fingerprint',
      published: f.command.published,
    });
  });
  it.each(['owner', 'receipt', 'source', 'signature', 'changed-pointer'] as const)(
    'rejects %s without publication effects',
    async (failure) => {
      const f = fixture();
      let ownerAid = said;
      if (failure === 'owner') ownerAid = `E${'b'.repeat(43)}`;
      if (failure === 'receipt')
        f.command = { ...f.command, activationReceiptSaid: `E${'b'.repeat(43)}` };
      if (failure === 'source')
        f.command = {
          ...f.command,
          configurationBase64: Buffer.from('{"version":1,"arm":"C1"}').toString('base64'),
        };
      if (failure === 'signature')
        f.dependencies.signatures.verify = vi.fn().mockResolvedValue('Rejected');
      if (failure === 'changed-pointer')
        f.dependencies.activation.readCurrent = vi
          .fn()
          .mockResolvedValueOnce({ kind: 'Read', pointer: f.pointer })
          .mockResolvedValueOnce({ kind: 'Read', pointer: { ...f.pointer, pointerVersion: 3 } });
      expect((await publishHarness({ ownerAid, command: f.command }, f.dependencies)).kind).toBe(
        failure === 'changed-pointer' ? 'Conflict' : 'Rejected',
      );
      expect(f.store).not.toHaveBeenCalled();
    },
  );
});
