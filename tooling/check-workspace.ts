import { findWorkspaceBoundaryViolations, loadWorkspace } from './workspace-boundaries.js';
import { findHandwrittenStyleSheets } from './design-system-boundary.js';
import { inspectWorkspaceStack } from './stack-policy.js';

const workspace = await loadWorkspace(process.cwd());
const violations = findWorkspaceBoundaryViolations(workspace);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.kind}: ${violation.source} -> ${violation.target}`);
  }
  process.exitCode = 1;
}

const handwrittenStyleSheets = await findHandwrittenStyleSheets(process.cwd());
for (const path of handwrittenStyleSheets) {
  console.error(`handwritten-site-stylesheet: ${path}`);
  process.exitCode = 1;
}

const stackViolations = await inspectWorkspaceStack(process.cwd());
for (const violation of stackViolations) {
  console.error(`${violation.kind}: ${violation.manifest} -> ${violation.packageName}`);
  process.exitCode = 1;
}
