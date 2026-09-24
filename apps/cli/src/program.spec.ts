import { describe, expect, it } from 'vitest';

import type { DemoIssuerCompatibility } from './identity/application/demo-issuer-compatibility.js';
import { createProgram, type CliProcess, type UserIdentityCommands } from './program.js';

function commandFixture(): {
  readonly commands: UserIdentityCommands;
  readonly invocations: string[];
} {
  const invocations: string[] = [];
  const recovery = {
    kind: 'RecoveryRequired',
    reason: 'CustodyUnavailable',
    detail: 'custody file is absent',
  } as const;
  return {
    invocations,
    commands: {
      status: () =>
        Promise.resolve({
          kind: 'IssuerCompatible',
          issuer: {
            service: 'issuer',
            status: 'ready',
            issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
            issuerOobi:
              'http://keria.test/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
            registryId: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
            schemaId: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
          },
        }),
      initialize: (presentation) => {
        invocations.push(`init:${presentation}`);
        return Promise.resolve(recovery);
      },
      whoami: () => {
        invocations.push('whoami');
        return Promise.resolve(recovery);
      },
      rotate: () => {
        invocations.push('rotate');
        return Promise.resolve(recovery);
      },
    },
  };
}

function processFixture(): {
  readonly process: CliProcess;
  readonly output: string[];
  readonly errors: string[];
  readonly exitCodes: number[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  return {
    output,
    errors,
    exitCodes,
    process: {
      write: (value) => output.push(value),
      writeError: (value) => errors.push(value),
      setExitCode: (value) => exitCodes.push(value),
    },
  };
}

describe('devrandom command', () => {
  it('exposes the identity journey without exposing deferred runtime commands', () => {
    const { commands } = commandFixture();
    const runtime = processFixture();
    const help = createProgram(commands, runtime.process).helpInformation();

    expect(help).toContain('init');
    expect(help).toContain('whoami');
    expect(help).toContain('identity');
    expect(help).not.toContain('task');
    expect(help).not.toContain('agent create');
  });

  it('dispatches print-only init, whoami, and explicit rotation independently', async () => {
    const { commands, invocations } = commandFixture();
    const runtime = processFixture();
    const program = createProgram(commands, runtime.process);

    await program.parseAsync(['node', 'devrandom', 'init', '--no-open']);
    await program.parseAsync(['node', 'devrandom', 'whoami']);
    await program.parseAsync(['node', 'devrandom', 'identity', 'rotate']);

    expect(invocations).toEqual(['init:PrintBrowserUrl', 'whoami', 'rotate']);
    expect(runtime.errors).toHaveLength(3);
    expect(runtime.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('custody file is absent')]),
    );
    expect(runtime.exitCodes).toEqual([4, 4, 4]);
  });

  it('reports the closed cryptographic reason for rejected AID proof', async () => {
    const proofRejected = {
      kind: 'RegistrationRejected',
      disposition: 'ProofRejected',
      detail: 'challenge response recipient does not match the Devrandom issuer',
    } as const;
    const commands: UserIdentityCommands = {
      status: () => commandFixture().commands.status(),
      initialize: () => Promise.resolve(proofRejected),
      whoami: () => Promise.resolve(proofRejected),
      rotate: () => Promise.resolve(proofRejected),
    };
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync(['node', 'devrandom', 'init']);

    expect(runtime.errors).toEqual([
      expect.stringContaining(
        'Evidence: challenge response recipient does not match the Devrandom issuer',
      ),
    ]);
    expect(runtime.exitCodes).toEqual([6]);
  });

  it('refuses demo readiness when the live issuer does not match the CLI pins', async () => {
    const incompatibility: DemoIssuerCompatibility = {
      kind: 'IssuerIncompatible',
      field: 'issuerAid',
      expected: 'EPinnedIssuer',
      actual: 'EOtherIssuer',
    };
    const commands = {
      ...commandFixture().commands,
      status: () => Promise.resolve(incompatibility),
    };
    const runtime = processFixture();

    await createProgram(commands, runtime.process).parseAsync(['node', 'devrandom', 'status']);

    expect(runtime.output).toEqual([]);
    expect(runtime.errors).toEqual([
      'Devrandom services are incompatible: issuerAid expected EPinnedIssuer but received EOtherIssuer.\n',
    ]);
    expect(runtime.exitCodes).toEqual([7]);
  });
});
