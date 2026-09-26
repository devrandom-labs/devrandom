import Type from 'typebox';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const sha256FingerprintSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const workAccessScopes = Object.freeze([
  'evaluation:admit',
  'evaluation:append',
  'evaluation:close',
  'evaluation:prepare',
  'evaluation:renew',
  'evidence:append',
  'evidence:read',
  'evidence:seal',
  'experience:retrieve',
  'run:create',
  'run:execute',
  'run:prepare',
  'run:read',
  'task:create',
  'task:read',
  'activation:commit',
] as const);

export const workAccessScopeSchema = Type.Union([
  Type.Literal(workAccessScopes[0]),
  Type.Literal(workAccessScopes[1]),
  Type.Literal(workAccessScopes[2]),
  Type.Literal(workAccessScopes[3]),
  Type.Literal(workAccessScopes[4]),
  Type.Literal(workAccessScopes[5]),
  Type.Literal(workAccessScopes[6]),
  Type.Literal(workAccessScopes[7]),
  Type.Literal(workAccessScopes[8]),
  Type.Literal(workAccessScopes[9]),
  Type.Literal(workAccessScopes[10]),
  Type.Literal(workAccessScopes[11]),
  Type.Literal(workAccessScopes[12]),
  Type.Literal(workAccessScopes[13]),
  Type.Literal(workAccessScopes[14]),
  Type.Literal(workAccessScopes[15]),
]);

export type WorkAccessScope = Type.Static<typeof workAccessScopeSchema>;

export const createWorkAccessAttemptBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuidV4Schema,
    clientInstanceId: uuidV4Schema,
    userAid: keriIdentifierSchema,
    credentialSaid: keriIdentifierSchema,
    grantSecretHash: sha256FingerprintSchema,
  },
  { additionalProperties: false },
);

export type CreateWorkAccessAttemptBody = Type.Static<typeof createWorkAccessAttemptBodySchema>;

export const workAccessAttemptParametersSchema = Type.Object(
  { attemptId: uuidV4Schema },
  { additionalProperties: false },
);

export type WorkAccessAttemptParameters = Type.Static<typeof workAccessAttemptParametersSchema>;

export const workAccessAuthorizationHeadersSchema = Type.Object(
  {
    authorization: Type.String({ pattern: '^Bearer [A-Za-z0-9_-]{43}$' }),
  },
  { additionalProperties: true },
);

export type WorkAccessAuthorizationHeaders = Type.Static<
  typeof workAccessAuthorizationHeadersSchema
>;

export const submitWorkAccessProofBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    responseSaid: keriIdentifierSchema,
  },
  { additionalProperties: false },
);

export type SubmitWorkAccessProofBody = Type.Static<typeof submitWorkAccessProofBodySchema>;

const workAccessAttemptBindingProperties = {
  version: Type.Literal(1),
  attemptId: uuidV4Schema,
  userAid: keriIdentifierSchema,
  credentialSaid: keriIdentifierSchema,
  issuerRecipientAid: keriIdentifierSchema,
  clientInstanceId: uuidV4Schema,
  commandId: uuidV4Schema,
  grantSecretHash: sha256FingerprintSchema,
  attemptExpiresAt: timestampSchema,
} as const;

const challengeWordsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
  minItems: 24,
  maxItems: 24,
});

export const activeWorkAccessGrantSchema = Type.Object(
  {
    kind: Type.Literal('Active'),
    expiresAt: timestampSchema,
    remainingRequests: Type.Integer({ minimum: 0, maximum: 2_000 }),
  },
  { additionalProperties: false },
);

export const workAccessGrantDispositionSchema = Type.Union([
  activeWorkAccessGrantSchema,
  Type.Object({ kind: Type.Literal('Expired') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Exhausted') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('Released'), releasedAt: timestampSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Revoked'), reason: Type.Literal('SecurityIncident') },
    { additionalProperties: false },
  ),
]);

export type WorkAccessGrantDisposition = Type.Static<typeof workAccessGrantDispositionSchema>;

const awaitingProofProjectionSchema = Type.Object(
  {
    ...workAccessAttemptBindingProperties,
    kind: Type.Literal('AwaitingProof'),
    challengeWords: challengeWordsSchema,
  },
  { additionalProperties: false },
);

const verifyingProofProjectionSchema = Type.Object(
  {
    ...workAccessAttemptBindingProperties,
    kind: Type.Literal('VerifyingProof'),
    responseSaid: keriIdentifierSchema,
  },
  { additionalProperties: false },
);

const grantedProjectionSchema = Type.Object(
  {
    ...workAccessAttemptBindingProperties,
    kind: Type.Literal('Granted'),
    verifiedResponseSaid: keriIdentifierSchema,
    scopes: Type.Array(workAccessScopeSchema, {
      minItems: 1,
      maxItems: workAccessScopes.length,
      uniqueItems: true,
    }),
    policyFingerprint: sha256FingerprintSchema,
    disposition: workAccessGrantDispositionSchema,
  },
  { additionalProperties: false },
);

export const workAccessRejectionReasonSchema = Type.Union([
  Type.Literal('ChallengeRecipientMismatch'),
  Type.Literal('ChallengeProofInvalid'),
  Type.Literal('ChallengeOperationFailed'),
  Type.Literal('ChallengeAcknowledgementRejected'),
  Type.Literal('CredentialNotCurrent'),
]);

const rejectedProjectionSchema = Type.Object(
  {
    ...workAccessAttemptBindingProperties,
    kind: Type.Literal('Rejected'),
    reason: workAccessRejectionReasonSchema,
  },
  { additionalProperties: false },
);

export type WorkAccessRejectionReason = Type.Static<
  (typeof rejectedProjectionSchema)['properties']['reason']
>;

const expiredProjectionSchema = Type.Object(
  {
    ...workAccessAttemptBindingProperties,
    kind: Type.Literal('Expired'),
  },
  { additionalProperties: false },
);

export const workAccessAttemptProjectionSchema = Type.Union([
  awaitingProofProjectionSchema,
  verifyingProofProjectionSchema,
  grantedProjectionSchema,
  rejectedProjectionSchema,
  expiredProjectionSchema,
]);

export type WorkAccessAttemptProjection = Type.Static<typeof workAccessAttemptProjectionSchema>;

const correlationId = uuidV4Schema;

function problem<
  Code extends string,
  Status extends number,
  Title extends string,
  Path extends string,
>(code: Code, status: Status, title: Title, path: Path) {
  return Type.Object(
    {
      type: Type.Literal(`https://devrandom.example/problems/${path}`),
      title: Type.Literal(title),
      status: Type.Literal(status),
      code: Type.Literal(code),
      correlationId,
    },
    { additionalProperties: false },
  );
}

export const workAccessCapabilityInvalidProblemSchema = problem(
  'WorkAccessCapabilityInvalid',
  401,
  'Work Access capability is invalid',
  'work-access-capability-invalid',
);
export const workAccessGrantExpiredProblemSchema = problem(
  'WorkAccessGrantExpired',
  401,
  'Work Access Grant expired',
  'work-access-grant-expired',
);
export const workAccessGrantRevokedProblemSchema = Type.Object(
  {
    type: Type.Literal('https://devrandom.example/problems/work-access-grant-revoked'),
    title: Type.Literal('Work Access Grant was revoked'),
    status: Type.Literal(403),
    code: Type.Literal('WorkAccessGrantRevoked'),
    correlationId,
    reason: Type.Literal('SecurityIncident'),
  },
  { additionalProperties: false },
);
export const workAccessGrantScopeRejectedProblemSchema = Type.Object(
  {
    type: Type.Literal('https://devrandom.example/problems/work-access-grant-scope-rejected'),
    title: Type.Literal('Work Access Grant scope was rejected'),
    status: Type.Literal(403),
    code: Type.Literal('WorkAccessGrantScopeRejected'),
    correlationId,
    requiredScope: workAccessScopeSchema,
  },
  { additionalProperties: false },
);
export const workAccessGrantConcurrentUpdateProblemSchema = problem(
  'WorkAccessGrantConcurrentUpdate',
  409,
  'Work Access Grant changed concurrently',
  'work-access-grant-concurrent-update',
);
export const workAccessGrantExhaustedProblemSchema = problem(
  'WorkAccessGrantExhausted',
  429,
  'Work Access Grant request budget is exhausted',
  'work-access-grant-exhausted',
);
export const workAccessGrantReleasedProblemSchema = problem(
  'WorkAccessGrantReleased',
  401,
  'Work Access Grant was released',
  'work-access-grant-released',
);
export const workAccessGrantReleaseConflictProblemSchema = problem(
  'WorkAccessGrantReleaseConflict',
  409,
  'Work Access Grant cannot be released',
  'work-access-grant-release-conflict',
);
export const workAccessRequestInvalidProblemSchema = problem(
  'WorkAccessRequestInvalid',
  400,
  'Work Access request is invalid',
  'work-access-request-invalid',
);
export const workAccessCredentialRejectedProblemSchema = problem(
  'WorkAccessCredentialRejected',
  403,
  'User credential is not current',
  'work-access-credential-rejected',
);
export const workAccessProofRejectedProblemSchema = Type.Object(
  {
    type: Type.Literal('https://devrandom.example/problems/work-access-proof-rejected'),
    title: Type.Literal('Work Access proof was rejected'),
    status: Type.Literal(403),
    code: Type.Literal('WorkAccessProofRejected'),
    correlationId,
    reason: workAccessRejectionReasonSchema,
  },
  { additionalProperties: false },
);
export const workAccessAttemptNotFoundProblemSchema = problem(
  'WorkAccessAttemptNotFound',
  404,
  'Work Access Attempt was not found',
  'work-access-attempt-not-found',
);
export const workAccessCommandConflictProblemSchema = problem(
  'WorkAccessCommandConflict',
  409,
  'Work Access command conflict',
  'work-access-command-conflict',
);
export const workAccessProofConflictProblemSchema = problem(
  'WorkAccessProofConflict',
  409,
  'Work Access proof conflict',
  'work-access-proof-conflict',
);
export const workAccessProofReplayedProblemSchema = problem(
  'WorkAccessProofReplayed',
  409,
  'Work Access proof was already used',
  'work-access-proof-replayed',
);
export const workAccessConcurrentUpdateProblemSchema = problem(
  'WorkAccessConcurrentUpdate',
  409,
  'Work Access Attempt changed concurrently',
  'work-access-concurrent-update',
);
export const workAccessAttemptExpiredProblemSchema = problem(
  'WorkAccessAttemptExpired',
  410,
  'Work Access Attempt expired',
  'work-access-attempt-expired',
);
export const workAccessBodyTooLargeProblemSchema = problem(
  'WorkAccessBodyTooLarge',
  413,
  'Work Access request body is too large',
  'work-access-body-too-large',
);
export const workAccessCapacityProblemSchema = problem(
  'WorkAccessCapacityExceeded',
  429,
  'Work Access capacity exceeded',
  'work-access-capacity-exceeded',
);
export const workAccessUnavailableProblemSchema = problem(
  'WorkAccessUnavailable',
  503,
  'Work Access dependency is unavailable',
  'work-access-unavailable',
);

export const workAccessProblemSchema = Type.Union([
  workAccessRequestInvalidProblemSchema,
  workAccessCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantReleaseConflictProblemSchema,
  workAccessCredentialRejectedProblemSchema,
  workAccessProofRejectedProblemSchema,
  workAccessAttemptNotFoundProblemSchema,
  workAccessCommandConflictProblemSchema,
  workAccessProofConflictProblemSchema,
  workAccessProofReplayedProblemSchema,
  workAccessConcurrentUpdateProblemSchema,
  workAccessAttemptExpiredProblemSchema,
  workAccessBodyTooLargeProblemSchema,
  workAccessCapacityProblemSchema,
  workAccessUnavailableProblemSchema,
]);

export type WorkAccessProblem = Type.Static<typeof workAccessProblemSchema>;
