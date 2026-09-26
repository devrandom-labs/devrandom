import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedCredentials } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessToolCommand,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';
import {
  DockerEvaluationCompartment,
  DockerTaskArtifactConstruction,
  DockerReceiptObservation,
  ExecutableCustody,
  observeContainedCommand,
  type AuthorizedToolEffect,
  type EvaluationRawArtifacts,
  type ToolGatewayProposal,
} from '@devrandom/runtime';
import { describe, expect, it } from 'vitest';
import {
  nativeComparisonFixture,
  nativeAllowance,
} from '../../../test/locked-comparison-native-fixture.js';
import { ManagedWorktreeResources } from '../../run/infrastructure/managed-worktree-tools.js';
import { DockerEvaluationToolEffects } from './docker-evaluation-tool-effects.js';

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'real Docker evaluation effects (synthetic enforcement fixture)',
  () => {
    it('excludes protected descendants from directory and search results', async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'independent-evaluation-tools-'));
      let worker: DockerEvaluationCompartment | undefined;
      try {
        const fixture = await nativeComparisonFixture(root, process.env.DEVRANDOM_EVAL_IMAGE ?? '');
        const opened = await DockerEvaluationCompartment.open({
          ...fixture,
          mounts: [],
          signal: new AbortController().signal,
        });
        expect(opened.kind).toBe('Opened');
        if (opened.kind !== 'Opened') throw new Error('Docker unavailable');
        worker = opened.compartment;
        await worker.copyInto(fixture.sourceDirectory, '/work/source');
        const rules = { protectedPaths: ['src/private'], completionCommands: [], toolCommands: [] };
        const resources = new ManagedWorktreeResources({
          ...rules,
          worktree: fixture.sourceDirectory,
        });
        const artifacts: EvaluationRawArtifacts = {
          record: (input) => {
            const raw = prepareEvidenceArtifact(input.bytes, input.mediaType);
            if (raw.kind !== 'Prepared') return Promise.resolve({ kind: 'Rejected' });
            return Promise.resolve({ kind: 'Stored', artifact: raw.artifact });
          },
        };
        const executables = new ExecutableCustody(join(root, 'executables'));
        const construction = new DockerTaskArtifactConstruction({
          ...fixture,
          executables,
          recipeSaid: fixture.verifier.reviewedRecipeSaid,
          toolchainSaid: fixture.verifier.toolchainSaid,
          artifacts,
        });
        const observation = new DockerReceiptObservation({ ...fixture, executables, artifacts });
        const effects = new DockerEvaluationToolEffects({
          ...fixture,
          worker,
          resources,
          resourceRules: rules,
          budget: nativeAllowance,
          credentials: new ProtectedCredentials(),
          construction,
          observation,
          artifacts,
        });
        const enact = (input: ToolGatewayProposal['input']) => {
          const proposal = {
            piSessionId: 'fixture-pi',
            modelTurnId: 'fixture-turn',
            toolCallId: input.kind,
            proposalIndex: 0,
            input,
          };
          const resolved = resources.resolve(proposal);
          if (resolved.kind !== 'Resolved') throw new Error('fixture scope');
          return effects.enact(
            {
              proposal,
              resource: resolved.resource,
              tool: input.kind === 'ListFiles' ? 'list_files' : 'search_repository',
              requiredCapability: 'ReadRepository',
            },
            new AbortController().signal,
          );
        };
        const listed = await enact({ kind: 'ListFiles', path: 'src' });
        expect(listed).toMatchObject({ kind: 'Completed' });
        expect('summary' in listed ? listed.summary : '').toContain('src/lib.rs');
        expect('summary' in listed ? listed.summary : '').not.toContain('private');
        const searched = await enact({
          kind: 'SearchRepository',
          path: 'src',
          query: 'fixture-private-canary',
        });
        expect(searched).toMatchObject({ kind: 'Completed', summary: '' });
      } finally {
        if (worker !== undefined) expect(await worker.close()).toBe(true);
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it('edits, formats, runs exact commands and verifies actual CESR source in separate native compartments', async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'independent-evaluation-tools-'));
      let worker: DockerEvaluationCompartment | undefined;
      try {
        const fixture = await nativeComparisonFixture(root, process.env.DEVRANDOM_EVAL_IMAGE ?? '');
        const signal = new AbortController().signal;
        const opened = await DockerEvaluationCompartment.open({ ...fixture, mounts: [], signal });
        expect(opened.kind).toBe('Opened');
        if (opened.kind !== 'Opened') throw new Error('Docker unavailable');
        worker = opened.compartment;
        await worker.copyInto(fixture.sourceDirectory, '/work/source');
        const executable = await observeContainedCommand(
          worker.execute(['node', '-p', 'process.execPath']),
          new Uint8Array(),
          4096,
          signal,
        );
        if (executable?.code !== 0) throw new Error('native Node missing');
        const formatter = identifyHarnessToolCommand(
          {
            id: 'fixture-format',
            capability: 'RunFormatter',
            argv: ['node', '-e', 'require("node:fs").writeFileSync("src/note.txt","formatted\\n")'],
            timeoutSeconds: 10,
            expected: { kind: 'exitCode', code: 0 },
          },
          executable.output.trim(),
        );
        const command = identifyHarnessCompletionCommand(
          {
            id: 'fixture-native-check',
            argv: [
              'node',
              '-e',
              'const fs=require("node:fs");if(fs.readFileSync("src/note.txt","utf8")!=="formatted\\n")process.exit(7);if(fs.existsSync(process.argv[1])||fs.existsSync("/app"))process.exit(8);console.log("fixture native check")',
              root,
            ],
            timeoutSeconds: 10,
            expected: { kind: 'exitCode', code: 0 },
          },
          executable.output.trim(),
        );
        if (formatter.kind !== 'Identified' || command.kind !== 'Identified')
          throw new Error('fixture commands');
        const rules = {
          protectedPaths: ['src/private'],
          readOnlyPaths: ['tests', 'Cargo.toml', 'Cargo.lock'],
          completionCommands: [{ ...command.command, argv: [...command.command.argv] }],
          toolCommands: [formatter.command],
        };
        const resources = new ManagedWorktreeResources({
          ...rules,
          worktree: fixture.sourceDirectory,
        });
        const raws: unknown[] = [];
        const artifacts: EvaluationRawArtifacts = {
          record: (input) => {
            const raw = prepareEvidenceArtifact(input.bytes, input.mediaType);
            if (raw.kind !== 'Prepared') return Promise.resolve({ kind: 'Rejected' });
            if (input.mediaType === 'application/json')
              raws.push(JSON.parse(Buffer.from(input.bytes).toString()));
            return Promise.resolve({ kind: 'Stored', artifact: raw.artifact });
          },
        };
        const executables = new ExecutableCustody(join(root, 'executables'));
        const construction = new DockerTaskArtifactConstruction({
          ...fixture,
          executables,
          recipeSaid: fixture.verifier.reviewedRecipeSaid,
          toolchainSaid: fixture.verifier.toolchainSaid,
          artifacts,
        });
        const observation = new DockerReceiptObservation({ ...fixture, executables, artifacts });
        const effects = new DockerEvaluationToolEffects({
          ...fixture,
          worker,
          resources,
          resourceRules: rules,
          budget: nativeAllowance,
          credentials: new ProtectedCredentials(),
          construction,
          observation,
          artifacts,
        });
        let ordinal = 0;
        const enact = (
          input: ToolGatewayProposal['input'],
          tool: AuthorizedToolEffect['tool'],
          requiredCapability: AuthorizedToolEffect['requiredCapability'],
        ) => {
          const proposal = {
            piSessionId: 'fixture-pi',
            modelTurnId: 'fixture-turn',
            toolCallId: `fixture-${String(++ordinal)}`,
            proposalIndex: 0,
            input,
          };
          const resolved = resources.resolve(proposal);
          if (resolved.kind !== 'Resolved') throw new Error('fixture scope');
          return effects.enact(
            { proposal, resource: resolved.resource, tool, requiredCapability },
            signal,
          );
        };
        expect(
          await enact(
            { kind: 'WriteFile', path: 'src/note.txt', content: 'before\n' },
            'write_file',
            'EditRepository',
          ),
        ).toMatchObject({ kind: 'Completed' });
        expect(
          await enact(
            {
              kind: 'ReplaceText',
              path: 'src/note.txt',
              oldText: 'before',
              newText: 'after',
              expectedOccurrences: 1,
            },
            'replace_text',
            'EditRepository',
          ),
        ).toMatchObject({ kind: 'Completed' });
        expect(
          await enact({ kind: 'ReadFile', path: 'src/note.txt' }, 'read_file', 'ReadRepository'),
        ).toMatchObject({ kind: 'Completed', summary: 'after\n' });
        expect(
          await enact(
            { kind: 'RunFormatter', commandId: formatter.command.identity },
            'run_formatter',
            'RunFormatter',
          ),
        ).toMatchObject({ kind: 'Completed' });
        expect(
          await enact(
            { kind: 'RunTests', commandId: command.command.identity },
            'run_tests',
            'RunTests',
          ),
        ).toMatchObject({
          kind: 'Completed',
          summary: expect.stringContaining('fixture native check') as unknown,
        });
        const submitted = await enact(
          { kind: 'SubmitResult', artifactSaids: [] },
          'submit_result',
          'SubmitResult',
        );
        expect(submitted).toMatchObject({ kind: 'SubmissionVerified', disposition: 'Rejected' });
        expect(raws).toContainEqual(
          expect.objectContaining({
            kind: 'EvaluationRepositoryEffect',
            inputKind: 'SubmitResult',
            publicConditions: expect.arrayContaining([
              expect.objectContaining({ id: 'cesr-current', verdict: 'Pass' }),
              expect.objectContaining({ id: 'cesr-legacy', verdict: 'Fail' }),
              expect.objectContaining({ id: 'cesr-tamper', verdict: 'Pass' }),
            ]) as unknown,
          }),
        );
        expect(raws).toContainEqual(
          expect.objectContaining({
            kind: 'EvaluationRepositoryEffect',
            inputKind: 'RunTests',
            command: expect.objectContaining({ exitCode: 0, cleanupConfirmed: true }) as unknown,
          }),
        );
        expect(await readFile(join(fixture.sourceDirectory, 'src/lib.rs'), 'utf8')).toContain(
          'parse_receipt_stream',
        );
        const changed = await observeContainedCommand(
          worker.execute([
            'node',
            '-e',
            'require("node:fs").writeFileSync("/work/source/src/private/canary.txt","tampered")',
          ]),
          new Uint8Array(),
          4096,
          signal,
        );
        expect(changed?.code).toBe(0);
        expect(
          await enact({ kind: 'ReadFile', path: 'src/lib.rs' }, 'read_file', 'ReadRepository'),
        ).toEqual({ kind: 'EvidenceIntegrityFailure' });
      } finally {
        if (worker !== undefined) expect(await worker.close()).toBe(true);
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
