export type IdentityError =
  | {
      readonly kind: 'signify-initialization-failed';
      readonly reason: string;
    }
  | {
      readonly kind: 'keria-unavailable';
      readonly stage: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'controller-boot-rejected';
      readonly status: number;
    }
  | {
      readonly kind: 'controller-state-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'keria-response-invalid';
      readonly stage: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'identifier-conflict';
      readonly alias: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'registry-conflict';
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'end-role-conflict';
      readonly reason: string;
    }
  | {
      readonly kind: 'issuer-oobi-unavailable';
      readonly alias: string;
    }
  | {
      readonly kind: 'issuer-oobi-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'credential-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'credential-delivery-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'challenge-response-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'ipex-evidence-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'user-identifier-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'user-oobi-invalid';
      readonly reason: string;
    }
  | {
      readonly kind: 'keria-operation-failed';
      readonly operationName: string;
      readonly stage: string;
      readonly status: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'keria-operation-timeout';
      readonly operationName: string;
      readonly stage: string;
    };

export class IdentityFailure extends Error {
  readonly detail: IdentityError;

  constructor(detail: IdentityError, cause?: unknown) {
    super(identityErrorMessage(detail), cause === undefined ? undefined : { cause });
    this.name = 'IdentityFailure';
    this.detail = detail;
  }
}

export function identityErrorMessage(error: IdentityError): string {
  switch (error.kind) {
    case 'signify-initialization-failed':
      return `Signify initialization failed: ${error.reason}`;
    case 'keria-unavailable':
      return `KERIA is unavailable during ${error.stage}: ${error.reason}`;
    case 'controller-boot-rejected':
      return `KERIA rejected controller boot with HTTP ${String(error.status)}`;
    case 'controller-state-invalid':
      return `KERIA controller state is invalid: ${error.reason}`;
    case 'keria-response-invalid':
      return `KERIA returned an invalid ${error.stage} response: ${error.reason}`;
    case 'identifier-conflict':
      return `Identifier ${error.alias} conflicts with expected state: ${error.reason}`;
    case 'registry-conflict':
      return `Registry ${error.name} conflicts with expected state: ${error.reason}`;
    case 'end-role-conflict':
      return `Issuer agent end role conflicts with expected state: ${error.reason}`;
    case 'issuer-oobi-unavailable':
      return `Issuer OOBI for ${error.alias} did not become available`;
    case 'issuer-oobi-invalid':
      return `Issuer OOBI is invalid: ${error.reason}`;
    case 'credential-invalid':
      return `Credential is invalid: ${error.reason}`;
    case 'credential-delivery-invalid':
      return `Credential delivery is invalid: ${error.reason}`;
    case 'challenge-response-invalid':
      return `Signify challenge response is invalid: ${error.reason}`;
    case 'ipex-evidence-invalid':
      return `IPEX evidence is invalid: ${error.reason}`;
    case 'user-identifier-invalid':
      return `User identifier is invalid: ${error.reason}`;
    case 'user-oobi-invalid':
      return `User OOBI is invalid: ${error.reason}`;
    case 'keria-operation-failed':
      return `${error.stage} failed in ${error.operationName} with status ${String(error.status)}: ${error.reason}`;
    case 'keria-operation-timeout':
      return `${error.stage} did not complete before its deadline (${error.operationName})`;
  }
}

export function reasonFromUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return 'unknown external failure';
}
