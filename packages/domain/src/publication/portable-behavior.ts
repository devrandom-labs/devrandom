export type PortableBehavior =
  | { readonly kind: 'Instruction'; readonly text: string }
  | {
      readonly kind: 'RecoveryWorkflow';
      readonly trigger: 'QualifiedRetainedFailure';
      readonly steps: readonly [
        'RetrieveExperience',
        'ReadExactSource',
        'Replan',
        'FreshPublicVerify',
      ];
    }
  | {
      readonly kind: 'VersionedFormatContextSelection';
      readonly algorithm: 'ExactPublicHistoryV1';
      readonly formatMarker: { readonly parameter: 'formatMarker' };
      readonly triggerPaths: { readonly parameter: 'formatPaths' };
      readonly priority: readonly ('Failure' | 'Contract' | 'Edit')[];
      readonly maximumItems: number;
      readonly maximumContextBytes: number;
    };

function object(
  value: unknown,
  keys: string,
): value is {
  readonly version?: unknown;
  readonly arm?: unknown;
  readonly instructionText?: unknown;
  readonly kind?: unknown;
  readonly trigger?: unknown;
  readonly steps?: unknown;
  readonly formatMarker?: unknown;
  readonly triggerPaths?: unknown;
  readonly priority?: unknown;
  readonly maximumItems?: unknown;
  readonly maximumContextBytes?: unknown;
  readonly algorithm?: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys
  );
}

/** Reject rather than redact arbitrary instruction meaning. Structured C3 bindings become parameters. */
export function derivePortableBehavior(
  configuration: unknown,
  implementation: unknown,
  privateValues: readonly string[],
):
  | { readonly kind: 'Portable'; readonly behavior: PortableBehavior }
  | { readonly kind: 'Rejected' } {
  if (
    object(configuration, 'arm,instructionText,version') &&
    configuration.version === 1 &&
    configuration.arm === 'C1' &&
    implementation === undefined &&
    typeof configuration.instructionText === 'string'
  ) {
    const text = configuration.instructionText;
    if (!safePortableInstruction(text, privateValues)) return { kind: 'Rejected' };
    return { kind: 'Portable', behavior: { kind: 'Instruction', text } };
  }
  if (
    object(configuration, 'arm,version') &&
    configuration.version === 1 &&
    configuration.arm === 'C2' &&
    object(implementation, 'kind,steps,trigger,version') &&
    implementation.version === 1 &&
    implementation.kind === 'RecoveryWorkflow' &&
    implementation.trigger === 'QualifiedRetainedFailure' &&
    JSON.stringify(implementation.steps) ===
      JSON.stringify(['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'])
  )
    return {
      kind: 'Portable',
      behavior: {
        kind: 'RecoveryWorkflow',
        trigger: 'QualifiedRetainedFailure',
        steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
      },
    };
  if (
    object(
      configuration,
      'arm,formatMarker,maximumContextBytes,maximumItems,priority,triggerPaths,version',
    ) &&
    configuration.version === 1 &&
    configuration.arm === 'C3' &&
    typeof configuration.formatMarker === 'string' &&
    configuration.formatMarker.length > 0 &&
    configuration.formatMarker.length <= 64 &&
    Array.isArray(configuration.triggerPaths) &&
    configuration.triggerPaths.length > 0 &&
    configuration.triggerPaths.length <= 8 &&
    configuration.triggerPaths.every(
      (path: unknown) => typeof path === 'string' && path.length > 0 && path.length <= 512,
    ) &&
    Array.isArray(configuration.priority) &&
    configuration.priority.length === 3 &&
    new Set(configuration.priority).size === 3 &&
    configuration.priority.every(
      (kind: unknown) => kind === 'Failure' || kind === 'Contract' || kind === 'Edit',
    ) &&
    typeof configuration.maximumItems === 'number' &&
    Number.isSafeInteger(configuration.maximumItems) &&
    configuration.maximumItems >= 1 &&
    configuration.maximumItems <= 8 &&
    typeof configuration.maximumContextBytes === 'number' &&
    Number.isSafeInteger(configuration.maximumContextBytes) &&
    configuration.maximumContextBytes >= 128 &&
    configuration.maximumContextBytes <= 32768 &&
    object(implementation, 'algorithm,kind,version') &&
    implementation.version === 1 &&
    implementation.kind === 'VersionedFormatContextSelection' &&
    implementation.algorithm === 'ExactPublicHistoryV1'
  ) {
    const priority = [...configuration.priority];
    return {
      kind: 'Portable',
      behavior: {
        kind: 'VersionedFormatContextSelection',
        algorithm: 'ExactPublicHistoryV1',
        formatMarker: { parameter: 'formatMarker' },
        triggerPaths: { parameter: 'formatPaths' },
        priority,
        maximumItems: configuration.maximumItems,
        maximumContextBytes: configuration.maximumContextBytes,
      },
    };
  }
  return { kind: 'Rejected' };
}

/** Portable C1 supports reviewed public verification instructions, never arbitrary natural-language policy. */
export function safePortableInstruction(text: string, privateValues: readonly string[]): boolean {
  const reviewed = new Set([
    'Run public verification before completion.',
    'Run the public compatibility verifier before completion.',
    'Inspect the public contract before editing and run public verification before completion.',
    'Verify the expected public behavior after each change.',
  ]);
  if (!reviewed.has(text)) return false;
  const normalized = text.toLowerCase();
  return privateValues
    .filter((value) => value.length >= 4)
    .every((value) => !normalized.includes(value.toLowerCase()));
}

export function portableCapabilities(behavior: PortableBehavior): readonly string[] {
  return behavior.kind === 'Instruction'
    ? ['PublicVerification']
    : behavior.kind === 'RecoveryWorkflow'
      ? ['ExperienceRetrieval', 'ExactSourceRead', 'PublicVerification']
      : ['PublicHistoryRead'];
}
