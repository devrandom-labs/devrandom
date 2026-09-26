import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const parent = Number(process.argv[2]);
const name = process.argv[3];
const deadline = Number(process.argv[4]);

if (
  !Number.isSafeInteger(parent) ||
  parent < 1 ||
  name === undefined ||
  !/^devrandom-evaluation-[0-9a-f-]{36}$/u.test(name) ||
  !Number.isSafeInteger(deadline) ||
  deadline <= Date.now()
)
  process.exit(2);

function parentAlive(): boolean {
  try {
    process.kill(parent, 0);
    return true;
  } catch {
    return false;
  }
}

while (parentAlive() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}

try {
  await runFile('docker', ['rm', '-f', name], { timeout: 15_000, maxBuffer: 4096 });
} catch {
  // The parent may already have removed it. A surviving container is checked externally.
}
