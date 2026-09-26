import { normalizeContext, type TranscriptContext } from '@earendil-works/pi-ai';
/** Pinned Pi normalization keeps the parent research prompt outside untrusted public evidence. */
export function piResearchContext(
  systemPrompt: string,
  publicEvidencePrompt: string,
): TranscriptContext {
  return normalizeContext({
    systemPrompt,
    messages: [{ role: 'user', content: publicEvidencePrompt, timestamp: 0 }],
  });
}
