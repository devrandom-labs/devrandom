'use client';

import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  cssVariables: true,
  palette: {
    mode: 'dark',
    background: {
      default: '#090d14',
      paper: '#101722',
    },
    primary: {
      main: '#7dd3fc',
    },
    success: {
      main: '#4ade80',
    },
  },
  shape: {
    borderRadius: 12,
  },
  typography: {
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: {
      fontSize: 'clamp(2.5rem, 8vw, 5rem)',
      fontWeight: 700,
      letterSpacing: '-0.06em',
      lineHeight: 0.95,
    },
  },
});
