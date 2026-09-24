import type { AdmittedUser } from '@devrandom/domain';
import { Command } from 'commander';
import Type from 'typebox';
import Value from 'typebox/value';

import type { DemoIssuerCompatibility } from './identity/application/demo-issuer-compatibility.js';
import type { UserIdentityOutcome } from './identity/application/user-identity.js';

export type BrowserPresentation = 'OpenSystemBrowser' | 'PrintBrowserUrl';

export interface UserIdentityCommands {
  status(): Promise<DemoIssuerCompatibility>;
  initialize(presentation: BrowserPresentation): Promise<UserIdentityOutcome>;
  whoami(): Promise<UserIdentityOutcome>;
  rotate(): Promise<UserIdentityOutcome>;
}

export interface CliProcess {
  write(value: string): void;
  writeError(value: string): void;
  setExitCode(value: number): void;
}

const initOptionsSchema = Type.Object({ open: Type.Boolean() }, { additionalProperties: false });

interface RenderedIdentityOutcome {
  readonly destination: 'stdout' | 'stderr';
  readonly exitCode: number;
  readonly text: string;
}

export function createProgram(commands: UserIdentityCommands, cliProcess: CliProcess): Command {
  const program = new Command()
    .name('devrandom')
    .description('Devrandom governed harness evolution')
    .version('0.0.0');

  program
    .command('status')
    .description('Verify the live services match the CLI demonstration identity')
    .action(async () => runStatusCommand(commands.status(), cliProcess));

  program
    .command('init')
    .description('Create or recover and verify the local Devrandom user identity')
    .option('--no-open', 'print the registration URL instead of opening a browser')
    .action(async (options: unknown) => {
      if (!Value.Check(initOptionsSchema, options)) {
        throw new Error('Commander produced invalid init options');
      }
      await runIdentityCommand(
        commands.initialize(options.open ? 'OpenSystemBrowser' : 'PrintBrowserUrl'),
        cliProcess,
      );
    });

  program
    .command('whoami')
    .description('Re-verify and report the current Devrandom user identity')
    .action(async () => runIdentityCommand(commands.whoami(), cliProcess));

  const identity = program.command('identity').description('Operate on the local user identity');
  identity
    .command('rotate')
    .description('Explicitly rotate user-AID keys while preserving the user AID')
    .action(async () => runIdentityCommand(commands.rotate(), cliProcess));

  return program;
}

async function runStatusCommand(
  pending: Promise<DemoIssuerCompatibility>,
  cliProcess: CliProcess,
): Promise<void> {
  const compatibility = await pending;
  switch (compatibility.kind) {
    case 'IssuerCompatible':
      cliProcess.write(
        [
          'Devrandom services are ready.',
          `Issuer AID: ${compatibility.issuer.issuerAid}`,
          `Registry ID: ${compatibility.issuer.registryId}`,
          `Schema SAID: ${compatibility.issuer.schemaId}`,
        ].join('\n') + '\n',
      );
      cliProcess.setExitCode(0);
      return;
    case 'IssuerIncompatible':
      cliProcess.writeError(
        `Devrandom services are incompatible: ${compatibility.field} expected ${compatibility.expected} but received ${compatibility.actual}.\n`,
      );
      cliProcess.setExitCode(7);
      return;
    case 'IssuerUnavailable':
      cliProcess.writeError('Devrandom issuer health is unavailable or invalid.\n');
      cliProcess.setExitCode(5);
  }
}

async function runIdentityCommand(
  pending: Promise<UserIdentityOutcome>,
  cliProcess: CliProcess,
): Promise<void> {
  const rendered = renderIdentityOutcome(await pending);
  if (rendered.destination === 'stdout') {
    cliProcess.write(`${rendered.text}\n`);
  } else {
    cliProcess.writeError(`${rendered.text}\n`);
  }
  cliProcess.setExitCode(rendered.exitCode);
}

function renderIdentityOutcome(outcome: UserIdentityOutcome): RenderedIdentityOutcome {
  switch (outcome.kind) {
    case 'Ready':
      return {
        destination: 'stdout',
        exitCode: 0,
        text: readyIdentity(outcome.user, outcome.profile.provenance.kind, outcome.recovery),
      };
    case 'RegistrationRequired':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Registration remains pending for user AID ${outcome.profile.userAid}.`,
      };
    case 'InvalidCredential':
      return {
        destination: 'stderr',
        exitCode: 3,
        text:
          outcome.evidence.kind === 'PolicyInvalidity'
            ? `Credential is invalid: ${outcome.evidence.invalidity.kind}.`
            : `Credential cryptographic evidence is invalid: ${outcome.evidence.reason}`,
      };
    case 'RecoveryRequired':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: [
          `Identity recovery is required: ${outcome.reason}. No replacement was created.`,
          ...(outcome.detail === undefined ? [] : [`Evidence: ${outcome.detail}`]),
        ].join('\n'),
      };
    case 'InfrastructureUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: `Identity infrastructure is unavailable: ${outcome.dependency}.`,
      };
    case 'RegistrationRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: [
          `Registration did not complete: ${outcome.disposition}.`,
          ...(outcome.detail === undefined ? [] : [`Evidence: ${outcome.detail}`]),
        ].join('\n'),
      };
  }
}

function readyIdentity(
  user: AdmittedUser,
  provenance: 'live',
  recovery: 'NewIdentity' | 'ExistingIdentity',
): string {
  const witnessAids = user.custody.witnessAids.join(', ');
  const receiptIndexes = user.custody.witnessReceiptIndexes.join(', ');
  const claims = user.credential.eligibilityClaims.map((claim) => `  - ${claim}`).join('\n');
  return [
    'Identity Ready',
    `User AID: ${user.principal.aid}`,
    `Controller AID: ${user.custody.controllerAid}`,
    `KERIA agent AID: ${user.custody.keriaAgentAid}`,
    `KEL sequence: ${String(user.custody.kelSequence)}`,
    `Witness threshold: ${String(user.custody.witnessThreshold)}`,
    `Witness AIDs: ${witnessAids}`,
    `Witness receipt indexes: ${receiptIndexes}`,
    `Credential SAID: ${user.credential.credentialSaid}`,
    `Credential attribute SAID: ${user.credential.attributeSaid}`,
    `Issuer AID: ${user.credential.issuerAid}`,
    `Issuee AID: ${user.credential.issueeAid}`,
    `Schema SAID: ${user.credential.schemaSaid}`,
    `Registry ID: ${user.credential.registryId}`,
    'TEL status: Issued',
    `Issuer anchor event SAID: ${user.credential.issuerAnchorEventSaid}`,
    'Eligibility claims:',
    claims,
    `Provenance: ${provenance}`,
    `Recovery disposition: ${recovery}`,
  ].join('\n');
}
