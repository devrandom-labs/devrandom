'use client';

import { CssBaseline, ThemeProvider } from '@mui/material';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import { ApiProvider } from '@reduxjs/toolkit/query/react';
import type { ReactNode } from 'react';

import { issuerApi } from './api/issuer-endpoints.ts';
import { theme } from './theme.ts';

interface ProvidersProps {
  readonly children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <ApiProvider api={issuerApi}>{children}</ApiProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
