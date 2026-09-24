import {
  type Operation,
  randomPasscode,
  ready,
  Saider,
  Serder,
  SignifyClient,
  Tier,
} from 'signify-ts';

import { describe, expect, it } from 'vitest';

const keriaAdminUrl = process.env.DEVRANDOM_KERIA_ADMIN_URL;
const keriaBootUrl = process.env.DEVRANDOM_KERIA_BOOT_URL;
const witnessWanUrl = process.env.DEVRANDOM_WITNESS_WAN_URL;

const witnessWanAid = 'BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha';

const liveKeriaConfigured =
  keriaAdminUrl !== undefined && keriaBootUrl !== undefined && witnessWanUrl !== undefined;
const describeWithKeria = liveKeriaConfigured ? describe : describe.skip;

function operationName(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('name' in value) ||
    typeof value.name !== 'string'
  ) {
    throw new Error('KERIA returned an invalid operation');
  }
  return value.name;
}

describeWithKeria('E0 Signify-TS and KERIA contract', () => {
  it('keeps controller material at the edge and completes witnessed inception and rotation', async () => {
    await ready();

    const client = new SignifyClient(
      keriaAdminUrl ?? 'http://127.0.0.1:3901',
      randomPasscode(),
      Tier.low,
      keriaBootUrl ?? 'http://127.0.0.1:3903',
    );
    const bootResponse = await client.boot();
    expect(bootResponse.ok).toBe(true);
    await client.connect();
    expect(client.agent?.pre).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(client.controller.pre).not.toBe(client.agent?.pre);

    const witnessResolution = await client
      .oobis()
      .resolve(`${witnessWanUrl ?? 'http://127.0.0.1:5642'}/oobi/${witnessWanAid}`, 'wan');
    const resolvedWitness = await client.operations().wait(witnessResolution, {
      signal: AbortSignal.timeout(30_000),
      maxSleep: 1_000,
    });
    await client.operations().delete(resolvedWitness.name);

    const alias = 'devrandom-e0-user';
    const inception = await client.identifiers().create(alias, {
      toad: 1,
      wits: [witnessWanAid],
    });
    expect(inception.sigs).not.toHaveLength(0);
    expect(inception.serder.sad.t).toBe('icp');
    const pendingInception: unknown = await inception.op();
    const inceptionOperationInput = await client.operations().get(operationName(pendingInception));
    let inceptionOperation: Operation;
    try {
      inceptionOperation = await client.operations().wait(inceptionOperationInput, {
        signal: AbortSignal.timeout(30_000),
        maxSleep: 1_000,
      });
    } catch (cause) {
      const lastStatus = await client.operations().get(inceptionOperationInput.name);
      throw new Error(
        `AID inception did not complete: ${lastStatus.name} done=${String(lastStatus.done)}`,
        { cause },
      );
    }
    await client.operations().delete(inceptionOperation.name);

    const rotation = await client.identifiers().rotate(alias);
    expect(rotation.sigs).not.toHaveLength(0);
    expect(rotation.serder.sad.t).toBe('rot');
    const pendingRotation: unknown = await rotation.op();
    const rotationOperationInput = await client.operations().get(operationName(pendingRotation));
    let rotationOperation: Operation;
    try {
      rotationOperation = await client.operations().wait(rotationOperationInput, {
        signal: AbortSignal.timeout(30_000),
        maxSleep: 1_000,
      });
    } catch (cause) {
      const lastStatus = await client.operations().get(rotationOperationInput.name);
      throw new Error(
        `AID rotation did not complete: ${lastStatus.name} done=${String(lastStatus.done)}`,
        { cause },
      );
    }
    await client.operations().delete(rotationOperation.name);

    const identifier = await client.identifiers().get(alias);
    expect(identifier.prefix).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(identifier.state.s).toBe('1');
    expect(identifier.state.b).toEqual([witnessWanAid]);
    expect(identifier.windexes).toEqual([0]);

    const events = await client.keyEvents().get(identifier.prefix);
    expect(events).toHaveLength(2);
    const inceptionEvent = new Serder(events[0]?.ked ?? {});
    const rotationEvent = new Serder(events[1]?.ked ?? {});
    expect(inceptionEvent.pre).toBe(identifier.prefix);
    expect(inceptionEvent.sn).toBe(0);
    expect(inceptionEvent.said).toBe(identifier.prefix);
    expect(inceptionEvent.said).toBe(inception.serder.said);
    expect(rotationEvent.pre).toBe(identifier.prefix);
    expect(rotationEvent.sn).toBe(1);
    expect(new Saider({ qb64: rotationEvent.said }).verify(rotationEvent.sad, true, true)).toBe(
      true,
    );
  }, 180_000);
});
