import { resolve } from 'node:path';

import { generateEndpoints } from '@rtk-query/codegen-openapi';

const siteRoot = import.meta.dirname;

export const issuerEndpointGeneration = {
  apiFile: './issuer-api.ts',
  apiImport: 'issuerApi',
  encodePathParams: true,
  exportName: 'issuerApi',
  filterEndpoints: [
    'getIssuerHealth',
    'createRegistration',
    'getRegistration',
    'submitAidProof',
    'getRegistrationApproval',
    'approveRegistration',
    'rejectRegistration',
  ],
  hooks: true,
  isDataResponse: (statusCode: string) => statusCode === '200',
  prettierConfigFile: resolve(siteRoot, '../../.prettierrc.json'),
  schemaFile: resolve(siteRoot, '../../services/server/openapi.json'),
  useUnknown: true,
};

export async function generateIssuerEndpoints(): Promise<string> {
  const generated = await generateEndpoints(issuerEndpointGeneration);
  if (generated === undefined) {
    throw new Error('RTK Query code generation returned no source');
  }
  const generatedImport = "from './issuer-api';";
  if (generated.split(generatedImport).length !== 2) {
    throw new Error('RTK Query code generation returned an unexpected base API import');
  }
  return generated.replace(generatedImport, "from './issuer-api.ts';");
}
