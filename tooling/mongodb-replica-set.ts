import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const envFile = process.env.DEVRANDOM_ENV_FILE ?? '.env.example';
const project = process.env.DEVRANDOM_ACTIVE_COMPOSE_PROJECT;
const composeArguments = [
  'compose',
  ...(project === undefined ? [] : ['--project-name', project]),
  '--env-file',
  envFile,
];

const initializeReplicaSet = [
  'try {',
  '  const status = db.adminCommand({ replSetGetStatus: 1 });',
  '  if (status.ok !== 1) quit(2);',
  '} catch (error) {',
  "  if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error;",
  "  const initiated = rs.initiate({ _id: 'devrandom-rs', members: [{ _id: 0, host: 'mongodb:27017' }] });",
  '  if (initiated.ok !== 1) quit(2);',
  '}',
].join('\n');

const verifyWritablePrimary = [
  'const hello = db.hello();',
  "if (hello.setName !== 'devrandom-rs' || hello.isWritablePrimary !== true) quit(1);",
].join('\n');

async function mongosh(script: string): Promise<void> {
  await execFileAsync('docker', [
    ...composeArguments,
    'exec',
    '-T',
    'mongodb',
    'mongosh',
    '--quiet',
    '--eval',
    script,
  ]);
}

await mongosh(initializeReplicaSet);

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    await mongosh(verifyWritablePrimary);
    process.stdout.write('MongoDB replica set is writable.\n');
    process.exitCode = 0;
    break;
  } catch (cause) {
    if (attempt === 119) {
      throw new Error('MongoDB replica set did not elect a writable primary', { cause });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}
