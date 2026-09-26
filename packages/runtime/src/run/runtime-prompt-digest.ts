import { createHash } from 'node:crypto';

/** Length framing binds exact UTF-8 system and Task prompt bytes without ambiguity. */
export function digestRunRuntimePrompt(systemPrompt: string, taskPrompt: string): string {
  const hash = createHash('sha256');
  for (const value of [systemPrompt, taskPrompt]) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(`${String(bytes.length)}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}
