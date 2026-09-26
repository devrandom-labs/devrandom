import { isDeepStrictEqual } from 'node:util';
import {
  decodeHarnessPackage,
  decodePortableHarnessVerification,
  type PortableHarnessVerification,
  publicationExchangeRoute,
  publicationSignatureSchema,
  type HarnessPackage,
  type PublicationSignature,
} from '@devrandom/protocol';
import { Saider, Serder, Siger, Verfer, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const exchange = Type.Object(
  {
    v: Type.String(),
    t: Type.Literal('exn'),
    d: said,
    i: said,
    rp: said,
    p: Type.String(),
    dt: Type.String(),
    r: Type.Literal(publicationExchangeRoute),
    q: Type.Object({}, { additionalProperties: false }),
    a: Type.Object(
      {
        i: said,
        version: Type.Literal(1),
        kind: Type.Literal('HarnessPublication'),
        packageSaid: said,
        verificationSaid: said,
        keyStateSaid: said,
      },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export interface HarnessPublicationSignatures {
  sign(input: {
    readonly package: HarnessPackage;
    readonly verification: PortableHarnessVerification;
    readonly senderAlias: string;
    readonly recipientAid: string;
    readonly preparedAt: number;
  }): Promise<
    | { readonly kind: 'Signed'; readonly signature: PublicationSignature }
    | { readonly kind: 'Rejected' }
  >;
  verify(input: {
    readonly package: HarnessPackage;
    readonly verification: PortableHarnessVerification;
    readonly signature: PublicationSignature;
  }): Promise<'Verified' | 'Rejected' | 'Unavailable'>;
}
/** Verify indexed native EXN signatures against KERIA-authenticated current publisher key state. No key is accepted from the package. */
export function signifyHarnessPublicationSignatures(
  client: SignifyClient,
): HarnessPublicationSignatures {
  const verify: HarnessPublicationSignatures['verify'] = async (input) => {
    if (
      decodeHarnessPackage(input.package).kind !== 'Accepted' ||
      decodePortableHarnessVerification(input.verification, input.package.d).kind !== 'Accepted' ||
      !Value.Check(publicationSignatureSchema, input.signature) ||
      !Value.Check(exchange, input.signature.exchange)
    )
      return 'Rejected';
    const native = input.signature.exchange;
    if (
      native.i !== input.package.publisherAid ||
      native.a.i !== native.rp ||
      native.a.packageSaid !== input.package.d ||
      native.a.verificationSaid !== input.verification.d ||
      native.a.keyStateSaid !== input.signature.keyStateSaid ||
      native.p !== ''
    )
      return 'Rejected';
    try {
      if (!new Saider({ qb64: native.d }).verify(native, true, true)) return 'Rejected';
      const states = await client.keyStates().get(input.package.publisherAid);
      const state = states[0];
      if (
        states.length !== 1 ||
        state === undefined ||
        state.i !== input.package.publisherAid ||
        state.ee.d !== input.signature.keyStateSaid ||
        state.kt !== '1' ||
        state.k.length !== 1
      )
        return 'Rejected';
      const key = state.k[0];
      const signature = input.signature.signatures[0];
      if (key === undefined || signature === undefined) return 'Rejected';
      const indexed = new Siger({ qb64: signature });
      if (indexed.index !== 0) return 'Rejected';
      return new Verfer({ qb64: key }).verify(indexed.raw, new Serder(native).raw)
        ? 'Verified'
        : 'Rejected';
    } catch {
      return 'Unavailable';
    }
  };
  return {
    verify,
    async sign(input) {
      if (
        decodeHarnessPackage(input.package).kind !== 'Accepted' ||
        decodePortableHarnessVerification(input.verification, input.package.d).kind !==
          'Accepted' ||
        !Number.isSafeInteger(input.preparedAt) ||
        input.preparedAt < 0
      )
        return { kind: 'Rejected' };
      const sender = await client.identifiers().get(input.senderAlias);
      if (sender.prefix !== input.package.publisherAid) return { kind: 'Rejected' };
      const [native, signatures] = await client.exchanges().createExchangeMessage(
        sender,
        publicationExchangeRoute,
        {
          version: 1,
          kind: 'HarnessPublication',
          packageSaid: input.package.d,
          verificationSaid: input.verification.d,
          keyStateSaid: sender.state.ee.d,
        },
        {},
        input.recipientAid,
        new Date(input.preparedAt).toISOString().replace('Z', '000+00:00'),
      );
      const signature = { exchange: native.sad, signatures, keyStateSaid: sender.state.ee.d };
      if (
        !Value.Check(publicationSignatureSchema, signature) ||
        !isDeepStrictEqual(signature.exchange, native.sad) ||
        (await verify({ package: input.package, verification: input.verification, signature })) !==
          'Verified'
      )
        return { kind: 'Rejected' };
      return { kind: 'Signed', signature };
    },
  };
}
