import { issuerApi as api } from './issuer-api.ts';
const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    getIssuerHealth: build.query<GetIssuerHealthApiResponse, GetIssuerHealthApiArg>({
      query: () => ({ url: `/health` }),
    }),
    createRegistration: build.mutation<CreateRegistrationApiResponse, CreateRegistrationApiArg>({
      query: (queryArg) => ({
        url: `/registrations`,
        method: 'POST',
        body: queryArg.body,
        headers: {
          'idempotency-key': queryArg['idempotency-key'],
        },
      }),
    }),
    getRegistration: build.query<GetRegistrationApiResponse, GetRegistrationApiArg>({
      query: (queryArg) => ({
        url: `/registrations/${encodeURIComponent(String(queryArg.registrationId))}`,
        headers: {
          'x-devrandom-registration-capability': queryArg['x-devrandom-registration-capability'],
        },
      }),
    }),
    submitAidProof: build.mutation<SubmitAidProofApiResponse, SubmitAidProofApiArg>({
      query: (queryArg) => ({
        url: `/registrations/${encodeURIComponent(String(queryArg.registrationId))}/aid-proof`,
        method: 'POST',
        body: queryArg.body,
        headers: {
          'x-devrandom-registration-capability': queryArg['x-devrandom-registration-capability'],
        },
      }),
    }),
    getRegistrationApproval: build.query<
      GetRegistrationApprovalApiResponse,
      GetRegistrationApprovalApiArg
    >({
      query: (queryArg) => ({
        url: `/registrations/${encodeURIComponent(String(queryArg.registrationId))}/approval`,
        headers: {
          'x-devrandom-registration-capability': queryArg['x-devrandom-registration-capability'],
        },
      }),
    }),
    approveRegistration: build.mutation<ApproveRegistrationApiResponse, ApproveRegistrationApiArg>({
      query: (queryArg) => ({
        url: `/registrations/${encodeURIComponent(String(queryArg.registrationId))}/approval`,
        method: 'POST',
        body: queryArg.body,
        headers: {
          'content-type': queryArg['content-type'],
          'x-devrandom-registration-capability': queryArg['x-devrandom-registration-capability'],
        },
      }),
    }),
    rejectRegistration: build.mutation<RejectRegistrationApiResponse, RejectRegistrationApiArg>({
      query: (queryArg) => ({
        url: `/registrations/${encodeURIComponent(String(queryArg.registrationId))}/rejection`,
        method: 'POST',
        body: queryArg.body,
        headers: {
          'content-type': queryArg['content-type'],
          'x-devrandom-registration-capability': queryArg['x-devrandom-registration-capability'],
        },
      }),
    }),
  }),
  overrideExisting: false,
});
export { injectedRtkApi as issuerApi };
export type GetIssuerHealthApiResponse = /** status 200 Default Response */ {
  service: 'issuer';
  status: 'ready';
  issuerAid: string;
  issuerOobi: string;
  registryId: string;
  schemaId: string;
};
export type GetIssuerHealthApiArg = void;
export type CreateRegistrationApiResponse = /** status 200 Default Response */ {
  registrationId: string;
  cliCapability: string;
  browserUrl: string;
  challengeWords: string[];
  issuerAid: string;
  issuerOobi: string;
  expiresAt: string;
  pollIntervalMs: number;
};
export type CreateRegistrationApiArg = {
  'idempotency-key': string;
  body: {
    protocolVersion: 1;
    userAid: string;
    userAgentOobi: string;
  };
};
export type GetRegistrationApiResponse =
  | /** status 200 Default Response */ {
      kind: 'pending-proof';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      issuerOobi: string;
      challengeWords: string[];
    }
  | {
      kind: 'pending-approval';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'approved';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'issuing';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'issued';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      grantSaid: string;
      credentialSaid: string;
    }
  | {
      kind: 'rejected';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      reason: 'aid-proof-rejected' | 'browser-rejected' | 'issuance-failed';
    }
  | {
      kind: 'expired';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    };
export type GetRegistrationApiArg = {
  registrationId: string;
  'x-devrandom-registration-capability': string;
};
export type SubmitAidProofApiResponse =
  | /** status 200 Default Response */ {
      kind: 'pending-proof';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      issuerOobi: string;
      challengeWords: string[];
    }
  | {
      kind: 'pending-approval';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'approved';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'issuing';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    }
  | {
      kind: 'issued';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      grantSaid: string;
      credentialSaid: string;
    }
  | {
      kind: 'rejected';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      reason: 'aid-proof-rejected' | 'browser-rejected' | 'issuance-failed';
    }
  | {
      kind: 'expired';
      registrationId: string;
      userAid: string;
      expiresAt: string;
    };
export type SubmitAidProofApiArg = {
  registrationId: string;
  'x-devrandom-registration-capability': string;
  body: {
    responseSaid: string;
  };
};
export type GetRegistrationApprovalApiResponse =
  | /** status 200 Default Response */ {
      kind: 'pending-proof';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'pending-approval';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'approved';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issuing';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issued';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'rejected';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'expired';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    };
export type GetRegistrationApprovalApiArg = {
  registrationId: string;
  'x-devrandom-registration-capability': string;
};
export type ApproveRegistrationApiResponse =
  | /** status 200 Default Response */ {
      kind: 'pending-proof';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'pending-approval';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'approved';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issuing';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issued';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'rejected';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'expired';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    };
export type ApproveRegistrationApiArg = {
  registrationId: string;
  'content-type': string;
  'x-devrandom-registration-capability': string;
  body: {
    contactEmail: string;
  };
};
export type RejectRegistrationApiResponse =
  | /** status 200 Default Response */ {
      kind: 'pending-proof';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'pending-approval';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'approved';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issuing';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'issued';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'rejected';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    }
  | {
      kind: 'expired';
      registrationId: string;
      userAid: string;
      expiresAt: string;
      issuerAid: string;
      abbreviatedUserAid: string;
      comparisonCode: string;
      credentialName: 'Devrandom User';
      capabilities: (
        'CreateAgent' | 'CreateTask' | 'RunPrivateTask' | 'PublishHarness' | 'ReceiveTaskResults'
      )[];
      contactEmailAssurance: 'self-asserted-unverified';
    };
export type RejectRegistrationApiArg = {
  registrationId: string;
  'content-type': string;
  'x-devrandom-registration-capability': string;
  body: {
    action: 'reject';
  };
};
export const {
  useGetIssuerHealthQuery,
  useCreateRegistrationMutation,
  useGetRegistrationQuery,
  useSubmitAidProofMutation,
  useGetRegistrationApprovalQuery,
  useApproveRegistrationMutation,
  useRejectRegistrationMutation,
} = injectedRtkApi;
