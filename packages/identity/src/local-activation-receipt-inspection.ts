import type { AgentAid, ControllerAid } from './keri-identifier.js';
import {
  signifyIssuerActivationReceiptExchange,
  type IssuerActivationReceiptExchange,
} from './activation-receipt-exchange.js';
import { IdentityFailure } from './identity-error.js';
import {
  connectSignifyController,
  type ConnectedSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';

export interface LocalActivationReceiptInspectionConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
}

/** The recovered local controller receives issuer EXNs; it never signs issuer receipts. */
export async function connectLocalActivationReceiptInspection(
  input: LocalActivationReceiptInspectionConnection,
  connectController: (
    configuration: SignifyControllerConfiguration,
  ) => Promise<ConnectedSignifyController> = connectSignifyController,
): Promise<Pick<IssuerActivationReceiptExchange, 'inspect'>> {
  const connected = await connectController(input);
  if (
    connected.controllerAid !== input.expectedControllerAid ||
    connected.agentAid !== input.expectedAgentAid
  )
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'Activation receipt inspection',
      reason: 'recovered local controller or KERIA agent differs from custody',
    });
  const inspector = signifyIssuerActivationReceiptExchange(connected.client);
  return { inspect: (expected) => inspector.inspect(expected) };
}
