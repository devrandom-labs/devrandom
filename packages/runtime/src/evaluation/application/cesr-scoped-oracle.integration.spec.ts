import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { EvaluationVerifierBundleInput } from '@devrandom/protocol';
import { AesGcmProtectedCaseCustody } from '../infrastructure/aes-gcm-protected-case-custody.js';
import { cesrPublicConditions } from './cesr-public-contract.js';
import { sealCesrComparisonCases } from './seal-cesr-comparison-cases.js';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const said = (letter: string): string => `E${letter.repeat(43)}`;
type Condition = EvaluationVerifierBundleInput['publicConditions'][number];

function rustTest(condition: Condition, index: number): string {
  const text = Buffer.from(condition.stimulusBase64Url, 'base64url').toString('utf8');
  const invocation = `parse_receipt_stream(r###"${text}"###)`;
  const expected = condition.expected;
  const assertion =
    expected.kind === 'Rejected'
      ? expected.error === 'AnyRejection'
        ? `assert!(${invocation}.is_err());`
        : `assert_eq!(${invocation}, Err(ReceiptError::${expected.error}));`
      : `assert_eq!(${invocation}, Ok(vec![${expected.receipts.map((receipt) => `VerifiedReceipt { version: ReceiptVersion::${receipt.version}, payload: "${receipt.payload}" }`).join(',')}]));`;
  return `#[test]\nfn case_${String(index)}() { ${assertion} }\n`;
}

it('replays every public oracle and independent protected composition through the real Rust API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-scoped-oracle-'));
  try {
    await cp(resolve('fixtures/cesr-scoped-receipt-service'), directory, { recursive: true });
    const publicConditions = cesrPublicConditions('ScopedGroups');
    const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
    const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
    const sealed = await sealCesrComparisonCases(
      {
        evaluationId,
        taskId: 'bbb13317-1c5e-4472-842e-692da01386cf',
        taskRevisionSaid: said('t'),
        ownerAid: said('o'),
        personalAgentAid: said('a'),
        policySaid: said('p'),
        executionProfileSaid: said('e'),
        oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('u'),
        publicConditions,
      },
      { custody, drawPayload: () => randomBytes(32) },
    );
    expect(sealed.kind).toBe('Prepared');
    if (sealed.kind !== 'Prepared') return;
    const conditions: Condition[] = [...publicConditions];
    for (const [segment, spec] of [
      [0, sealed.bundle.protectedCase],
      [1, sealed.bundle.terminalCase],
    ] as const) {
      const stimulus = await custody.open({
        evaluationId,
        objectSaid: spec.objectSaid,
        artifact: spec.stimulus,
        purpose: segment === 0 ? 'TrialHoldout' : 'TerminalCase',
        segment,
      });
      const expected = await custody.open({
        evaluationId,
        objectSaid: spec.objectSaid,
        artifact: spec.expected,
        purpose: 'OracleObservation',
        segment,
      });
      expect(stimulus.kind).toBe('Opened');
      expect(expected.kind).toBe('Opened');
      if (stimulus.kind !== 'Opened' || expected.kind !== 'Opened') return;
      conditions.push({
        id: `protected-${String(segment)}`,
        stimulusBase64Url: Buffer.from(stimulus.plaintext).toString('base64url'),
        expected: JSON.parse(new TextDecoder().decode(expected.plaintext)) as Condition['expected'],
      });
      stimulus.plaintext.fill(0);
      expected.plaintext.fill(0);
    }
    await writeFile(
      join(directory, 'tests/oracle_replay.rs'),
      `use cesr_receipt_service::{parse_receipt_stream, ReceiptError, ReceiptVersion, VerifiedReceipt};\n${conditions.map(rustTest).join('\n')}`,
    );
    const image = process.env.DEVRANDOM_EVAL_IMAGE;
    const run = async () => {
      if (image === undefined)
        return execute('cargo', ['test', '--locked', '--test', 'oracle_replay'], {
          cwd: directory,
          maxBuffer: 1024 * 1024,
        });
      const docker = (args: readonly string[]) =>
        execute('docker', args, { maxBuffer: 1024 * 1024, timeout: 120_000 });
      const started = await docker([
        'run',
        '--detach',
        '--rm',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65532:65532',
        '--cpus=1',
        '--memory=512m',
        '--pids-limit=64',
        '--tmpfs',
        '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
        '--entrypoint',
        '/bin/sleep',
        image,
        '180',
      ]);
      const container = started.stdout.trim();
      expect(container).toMatch(/^[a-f0-9]{64}$/u);
      try {
        // Stream source into the running scratch mount, as native compartments do.
        await docker(['exec', '--user=0:0', container, 'mkdir', '/tmp/source']);
        const archive = await execute('tar', ['-C', directory, '-cf', '-', '.'], {
          encoding: 'buffer',
          maxBuffer: 1024 * 1024,
        });
        const transfer = docker([
          'exec',
          '--interactive',
          '--user=0:0',
          container,
          'tar',
          '--no-same-owner',
          '--no-same-permissions',
          '-C',
          '/tmp/source',
          '-xf',
          '-',
        ]);
        transfer.child.stdin?.end(archive.stdout);
        await transfer;
        await docker(['exec', '--user=0:0', container, 'chmod', '-R', 'a+rX,a-w', '/tmp/source']);
        return await docker([
          'exec',
          '--workdir=/tmp/source',
          container,
          'env',
          'CARGO_NET_OFFLINE=true',
          'CARGO_BUILD_JOBS=1',
          'CARGO_HOME=/tmp/cargo',
          'CARGO_TARGET_DIR=/tmp/target',
          'cargo',
          'test',
          '--offline',
          '--locked',
          '--test',
          'oracle_replay',
        ]);
      } finally {
        await docker(['rm', '--force', container]);
      }
    };
    if (image !== undefined) expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const flatFailure = await run().then(
      () => {
        throw new Error('Flat parser unexpectedly satisfied scoped contract');
      },
      (cause: unknown) => cause as { code: number; stdout: string },
    );
    expect(flatFailure.code).toBe(101);
    expect(flatFailure.stdout).toContain('test case_14 ... FAILED');
    await writeFile(
      join(directory, 'src/lib.rs'),
      await readFile(resolve('tooling/fixtures/cesr-scoped-reference.rs')),
    );
    expect((await run()).stdout).toContain('33 passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
