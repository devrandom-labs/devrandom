import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';

/** Executes the pinned provider serializer only. onPayload stops before fetch; no
 * credential, provider request, transcript mutation or lossy compaction is involved. */
export async function responsesRequestBytes(
  model: Model<Api>,
  context: TranscriptContext,
  options: Pick<SimpleStreamOptions, 'maxTokens' | 'reasoning'>,
): Promise<number | undefined> {
  if (model.api !== 'openai-responses' || model.provider !== 'concentrate') return undefined;
  let bytes: number | undefined;
  let fetchAttempted = false;
  const networkWasAttempted = () => fetchAttempted;
  const serialized = streamSimple({ ...model, api: 'openai-responses' }, context, {
    ...options,
    apiKey: 'offline-serialization-without-provider-authority',
    maxRetries: 0,
    onPayload: (payload) => {
      bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      throw new Error('Offline request measurement complete.');
    },
    fetch: () => {
      fetchAttempted = true;
      return Promise.reject(new Error('Offline measurement forbids network.'));
    },
  });
  try {
    await serialized.result();
  } catch {
    return undefined;
  }
  return !networkWasAttempted() && bytes !== undefined && Number.isSafeInteger(bytes) && bytes > 0
    ? bytes
    : undefined;
}
