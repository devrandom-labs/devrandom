import { derivePortableBehavior } from '@devrandom/domain';
import {
  decodeHarnessPackage,
  decodePortableHarnessVerification,
  decodeSuccessorHarnessRevision,
  prepareEvidenceArtifact,
  prepareHarnessPackage,
  type ActiveHarnessPointer,
  type PublishHarnessCommand,
  type PublicationAdmission,
  type PublishedHarness,
} from '@devrandom/protocol';
export interface HarnessPublicationStorage {
  publish(input: {
    readonly ownerAid: string;
    readonly commandId: string;
    readonly fingerprint: string;
    readonly published: PublishedHarness;
  }): Promise<PublicationAdmission>;
  read(
    packageSaid: string,
  ): Promise<
    | { readonly kind: 'Read'; readonly published: PublishedHarness }
    | { readonly kind: 'Absent' | 'Unavailable' }
  >;
}
export interface PublicationAdmissionDependencies {
  readonly activation: {
    readCurrent(input: {
      readonly ownerAid: string;
      readonly taskId: string;
    }): Promise<
      | { readonly kind: 'Read'; readonly pointer: ActiveHarnessPointer }
      | { readonly kind: 'Absent' | 'Conflict' | 'Unavailable' }
    >;
  };
  readonly signatures: {
    verify(input: PublishedHarness): Promise<'Verified' | 'Rejected' | 'Unavailable'>;
  };
  readonly storage: HarnessPublicationStorage;
  fingerprint(command: PublishHarnessCommand): string;
}
function sourceDocument(
  encoded: string,
  expectedSaid: string,
  mediaType: 'application/json' | 'application/octet-stream',
): unknown {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return undefined;
  const artifact = prepareEvidenceArtifact(bytes, mediaType);
  if (artifact.kind !== 'Prepared' || artifact.artifact.d !== expectedSaid) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(text);
    return JSON.stringify(document) === text ? document : undefined;
  } catch {
    return undefined;
  }
}
/** Admission checks ownership, current committed provenance, content and native publisher signature; it never grades or activates a harness. */
export async function publishHarness(
  input: { readonly ownerAid: string; readonly command: PublishHarnessCommand },
  dependencies: PublicationAdmissionDependencies,
): Promise<PublicationAdmission> {
  const { command, ownerAid } = input;
  if (
    decodeHarnessPackage(command.published.package).kind !== 'Accepted' ||
    decodePortableHarnessVerification(command.published.verification, command.published.package.d)
      .kind !== 'Accepted' ||
    decodeSuccessorHarnessRevision(command.sourceRevision).kind !== 'Accepted' ||
    command.published.package.publisherAid !== ownerAid ||
    command.published.package.sourceRevisionSaid !== command.sourceRevision.d ||
    Buffer.byteLength(JSON.stringify(command.published), 'utf8') > 96 * 1024
  )
    return { kind: 'Rejected' };
  const current = await dependencies.activation.readCurrent({ ownerAid, taskId: command.taskId });
  if (current.kind !== 'Read')
    return { kind: current.kind === 'Unavailable' ? 'Unavailable' : 'Rejected' };
  if (
    current.pointer.kind !== 'Committed' ||
    current.pointer.disposition !== 'Activated' ||
    current.pointer.decisionReceiptSaid !== command.activationReceiptSaid ||
    current.pointer.activeRevisionSaid !== command.sourceRevision.d ||
    current.pointer.taskRevisionSaid !== command.sourceRevision.taskRevisionSaid
  )
    return { kind: 'Rejected' };
  const configuration = sourceDocument(
    command.configurationBase64,
    command.sourceRevision.configurationArtifactSaid,
    'application/json',
  );
  const implementation =
    command.sourceRevision.treatment.kind === 'Instruction'
      ? undefined
      : command.implementationBase64 === undefined
        ? undefined
        : sourceDocument(
            command.implementationBase64,
            command.sourceRevision.treatment.reviewedImplementationSaid,
            'application/octet-stream',
          );
  if (
    configuration === undefined ||
    (command.sourceRevision.arm === 'C1' && command.implementationBase64 !== undefined)
  )
    return { kind: 'Rejected' };
  const portable = derivePortableBehavior(configuration, implementation, [
    command.taskId,
    command.sourceRevision.taskRevisionSaid,
    current.pointer.harnessLineageId,
  ]);
  if (portable.kind !== 'Portable') return { kind: 'Rejected' };
  const expected = prepareHarnessPackage({
    publisherAid: ownerAid,
    sourceRevisionSaid: command.sourceRevision.d,
    behavior: portable.behavior,
  });
  if (
    expected.kind !== 'Prepared' ||
    JSON.stringify(expected.package) !== JSON.stringify(command.published.package)
  )
    return { kind: 'Rejected' };
  const signature = await dependencies.signatures.verify(command.published);
  if (signature !== 'Verified')
    return { kind: signature === 'Unavailable' ? 'Unavailable' : 'Rejected' };
  // Re-read current authority-facing activation after potentially slow signature verification.
  const latest = await dependencies.activation.readCurrent({ ownerAid, taskId: command.taskId });
  if (latest.kind !== 'Read' || JSON.stringify(latest.pointer) !== JSON.stringify(current.pointer))
    return { kind: 'Conflict' };
  return dependencies.storage.publish({
    ownerAid,
    commandId: command.commandId,
    fingerprint: dependencies.fingerprint(command),
    published: command.published,
  });
}
