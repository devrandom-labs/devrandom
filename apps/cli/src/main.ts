#!/usr/bin/env node

import {
  UserIdentityApplication,
  userIdentityDefaults,
} from './identity/application/user-identity.js';
import { verifyDemoIssuer } from './identity/application/demo-issuer-compatibility.js';
import { IdentityFiles } from './identity/infrastructure/identity-files.js';
import { IssuerHealthHttp } from './identity/infrastructure/issuer-health-http.js';
import { IssuerRegistrationHttp } from './identity/infrastructure/issuer-registration-http.js';
import { openSystemBrowser } from './identity/infrastructure/system-browser.js';
import {
  loadUserIdentityConfiguration,
  userIdentityEnvironment,
} from './identity/infrastructure/user-environment.js';
import {
  createProgram,
  type BrowserPresentation,
  type CliProcess,
  type UserIdentityCommands,
} from './program.js';

const cliProcess: CliProcess = {
  write: (value) => process.stdout.write(value),
  writeError: (value) => process.stderr.write(value),
  setExitCode: (value) => {
    process.exitCode = value;
  },
};

function identityApplication(presentation: BrowserPresentation): UserIdentityApplication {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const presentBrowserUrl = async (url: string): Promise<void> => {
    if (presentation === 'PrintBrowserUrl') {
      cliProcess.write(`Registration URL: ${url}\n`);
      return;
    }
    try {
      await openSystemBrowser(url);
    } catch {
      cliProcess.writeError('The system browser could not be opened.\n');
      cliProcess.write(`Registration URL: ${url}\n`);
    }
  };
  return new UserIdentityApplication(
    configuration,
    new IdentityFiles(configuration.stateDirectory),
    new IssuerRegistrationHttp(configuration.issuerUrl),
    { ...userIdentityDefaults, presentBrowserUrl },
  );
}

const commands: UserIdentityCommands = {
  status: async () => {
    const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
    const health = new IssuerHealthHttp(configuration.issuerUrl);
    return verifyDemoIssuer(configuration, () => health.observe());
  },
  initialize: (presentation) => identityApplication(presentation).initialize(),
  whoami: () => identityApplication('PrintBrowserUrl').whoami(),
  rotate: () => identityApplication('PrintBrowserUrl').rotate(),
};

try {
  await createProgram(commands, cliProcess).parseAsync(process.argv);
} catch (cause) {
  cliProcess.writeError(
    cause instanceof Error ? `devrandom: ${cause.message}\n` : 'devrandom: command failed\n',
  );
  cliProcess.setExitCode(1);
}
