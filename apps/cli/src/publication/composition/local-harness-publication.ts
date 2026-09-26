import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { derivePortableBehavior } from '@devrandom/domain';
import {
  connectSignifyController,
  signifyHarnessPublicationSignatures,
  signifyIssuerUserOobiResolution,
  userAid,
} from '@devrandom/identity';
import {
  decodeHarnessPackage,
  prepareHarnessPackage,
  type TaskProjection,
  type PublicationAdmission,
  type PublishHarnessCommand,
  type PrivateHarnessFork,
} from '@devrandom/protocol';
import {
  devrandomUserAlias,
  type UserIdentityConfiguration,
} from '../../identity/domain/user-configuration.js';
import type { SignifyCustody } from '../../identity/domain/user-profile.js';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';
import type { DevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { FileSuccessorTreatmentCustody } from '../../evolution/infrastructure/file-successor-treatment-custody.js';
import { EvaluationManifestCommandFile } from '../../harness/infrastructure/evaluation-manifest-command-file.js';
import { evaluatePortableBehavior } from '../application/evaluate-portable-behavior.js';
import { PrivatePublicationFiles } from '../infrastructure/private-publication-files.js';
import { ServerPublicationHttp } from '../infrastructure/server-publication-http.js';
interface LocalPublicationIdentity {
  readonly identity: UserIdentityConfiguration;
  readonly custodyFiles: { readCustody(): Promise<SignifyCustody | undefined> };
  readonly signal: AbortSignal;
}
async function connect(input: LocalPublicationIdentity) {
  if (input.signal.aborted) return undefined;
  const custody = await input.custodyFiles.readCustody();
  if (custody === undefined) return undefined;
  return connectSignifyController({
    adminUrl: input.identity.keriaAdminUrl,
    bootUrl: input.identity.keriaBootUrl,
    bran: custody.bran,
    securityTier: 'low',
  });
}
function parse(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}
export interface PublishLocalHarnessInput extends LocalPublicationIdentity {
  readonly stateRoot: string;
  readonly evaluationId: string;
  readonly commandId: string;
  readonly task: TaskProjection;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
}
export async function publishLocalHarness(
  input: PublishLocalHarnessInput,
): Promise<PublicationAdmission> {
  try {
    if (input.signal.aborted || input.task.ownerAid !== input.hosted.user.principal.aid)
      return { kind: 'Rejected' };
    const observed = await input.hosted.activationPointer().inspect(input.task.taskId);
    if (
      observed.kind !== 'Observed' ||
      observed.pointer.kind !== 'Committed' ||
      observed.pointer.disposition !== 'Activated' ||
      observed.pointer.taskRevisionSaid !== input.task.revisionSaid ||
      observed.pointer.harnessLineageId !== input.task.harnessLineageId
    )
      return { kind: 'Rejected' };
    const pointer = observed.pointer;
    const manifest = await new EvaluationManifestCommandFile(
      join(input.stateRoot, 'evaluation-manifests'),
      randomUUID,
    ).inspect(input.evaluationId);
    if (
      manifest.kind !== 'Staged' ||
      manifest.command.manifest.taskId !== input.task.taskId ||
      manifest.command.manifest.taskRevisionSaid !== input.task.revisionSaid ||
      ![
        manifest.command.manifest.revisions.C1,
        manifest.command.manifest.revisions.C2,
        manifest.command.manifest.revisions.C3,
      ].includes(pointer.activeRevisionSaid)
    )
      return { kind: 'Rejected' };
    const treatment = await new FileSuccessorTreatmentCustody(input.stateRoot).read(
      input.evaluationId,
      pointer.activeRevisionSaid,
    );
    if (treatment.kind !== 'Read') return { kind: 'Rejected' };
    const portable = derivePortableBehavior(
      parse(treatment.candidate.configuration.bytes),
      treatment.candidate.implementation === undefined
        ? undefined
        : parse(treatment.candidate.implementation.bytes),
      [
        input.task.taskId,
        input.task.revisionSaid,
        input.task.harnessLineageId,
        input.task.revision.repository.commit,
        input.task.revision.repository.tree,
      ],
    );
    if (portable.kind !== 'Portable') return { kind: 'Rejected' };
    const prepared = prepareHarnessPackage({
      publisherAid: input.task.ownerAid,
      sourceRevisionSaid: pointer.activeRevisionSaid,
      behavior: portable.behavior,
    });
    if (
      prepared.kind !== 'Prepared' ||
      (await evaluatePortableBehavior(prepared.package)) !== 'Passed'
    )
      return { kind: 'Rejected' };
    const connected = await connect(input);
    if (
      connected === undefined ||
      connected.controllerAid !== input.hosted.user.custody.controllerAid ||
      connected.agentAid !== input.hosted.user.custody.keriaAgentAid
    )
      return { kind: 'Rejected' };
    const signatures = signifyHarnessPublicationSignatures(connected.client);
    const files = new PrivatePublicationFiles(input.stateRoot);
    let command = await files.command(input.commandId);
    if (command !== undefined) {
      if (
        command.taskId !== input.task.taskId ||
        command.activationReceiptSaid !== pointer.decisionReceiptSaid ||
        JSON.stringify(command.published.package) !== JSON.stringify(prepared.package) ||
        (await signatures.verify(command.published)) !== 'Verified'
      )
        return { kind: 'Conflict' };
    } else {
      const signed = await signatures.sign({
        package: prepared.package,
        senderAlias: devrandomUserAlias,
        recipientAid: input.identity.issuerAid,
        preparedAt: Date.now(),
      });
      if (signed.kind !== 'Signed') return { kind: 'Rejected' };
      const next: PublishHarnessCommand = {
        version: 1,
        commandId: input.commandId,
        taskId: input.task.taskId,
        activationReceiptSaid: pointer.decisionReceiptSaid,
        sourceRevision: treatment.candidate.revision,
        configurationBase64: Buffer.from(treatment.candidate.configuration.bytes).toString(
          'base64',
        ),
        ...(treatment.candidate.implementation === undefined
          ? {}
          : {
              implementationBase64: Buffer.from(treatment.candidate.implementation.bytes).toString(
                'base64',
              ),
            }),
        published: { package: prepared.package, signature: signed.signature },
      };
      if ((await files.stage(next)) !== 'Staged') return { kind: 'Conflict' };
      command = next;
    }
    input.signal.throwIfAborted();
    const admission = await input.hosted.publication().publish(command);
    if (admission.kind !== 'Published' && admission.kind !== 'AlreadyPublished') return admission;
    const retrieved = await input.hosted.publication().fetch(prepared.package.d);
    if (
      retrieved.kind !== 'Fetched' ||
      JSON.stringify(retrieved.published) !== JSON.stringify(command.published) ||
      (await signatures.verify(retrieved.published)) !== 'Verified' ||
      (await files.retainVerified(retrieved.published)) !== 'Retained'
    )
      return { kind: 'Unavailable' };
    return admission;
  } catch {
    return { kind: 'Unavailable' };
  }
}
export interface FetchPublishedHarnessInput extends LocalPublicationIdentity {
  readonly stateRoot: string;
  readonly serverOrigin: DevrandomServerOrigin;
  readonly packageSaid: string;
  readonly publisherOobi: string;
}
export async function fetchPublishedHarness(
  input: FetchPublishedHarnessInput,
): Promise<
  | { readonly kind: 'Fetched'; readonly packageSaid: string }
  | { readonly kind: 'Rejected' | 'Unavailable' }
> {
  try {
    if (input.signal.aborted) return { kind: 'Unavailable' };
    const fetched = await new ServerPublicationHttp(input.serverOrigin, fetch).fetch(
      input.packageSaid,
    );
    if (fetched.kind !== 'Fetched') return fetched;
    const connected = await connect(input);
    if (connected === undefined) return { kind: 'Unavailable' };
    await signifyIssuerUserOobiResolution(
      connected.client,
      input.identity.operationTimeoutMs,
    ).resolve({
      userAid: userAid(fetched.published.package.publisherAid),
      userAgentOobi: input.publisherOobi,
    });
    if (
      decodeHarnessPackage(fetched.published.package).kind !== 'Accepted' ||
      (await signifyHarnessPublicationSignatures(connected.client).verify(fetched.published)) !==
        'Verified' ||
      (await evaluatePortableBehavior(fetched.published.package)) !== 'Passed'
    )
      return { kind: 'Rejected' };
    return (await new PrivatePublicationFiles(input.stateRoot).retainVerified(
      fetched.published,
    )) === 'Retained'
      ? { kind: 'Fetched', packageSaid: input.packageSaid }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Unavailable' };
  }
}
export async function forkPublishedHarness(
  input: FetchPublishedHarnessInput & { readonly commandId: string },
): Promise<
  | { readonly kind: 'Forked'; readonly fork: PrivateHarnessFork }
  | { readonly kind: 'Rejected' | 'Unavailable' }
> {
  const fetched = await fetchPublishedHarness(input);
  if (fetched.kind !== 'Fetched') return fetched;
  try {
    return await new PrivatePublicationFiles(input.stateRoot).fork(
      input.packageSaid,
      input.commandId,
    );
  } catch {
    return { kind: 'Unavailable' };
  }
}
