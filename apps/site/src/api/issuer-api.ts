import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';

export const issuerApi = createApi({
  reducerPath: 'issuerApi',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api/issuer/',
  }),
  endpoints: () => ({}),
});
