'use client';

import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import type { ReactNode } from 'react';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#283c27', contrastText: '#f4ffac' },
    secondary: { main: '#d7ef75', contrastText: '#18211c' },
    background: { default: '#f5f5ee', paper: '#ffffff' },
    text: { primary: '#202923', secondary: '#667165' },
    divider: '#dce0d4',
    error: { main: '#ad4137' },
    success: { main: '#426b3d' },
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: '"Avenir Next", "Segoe UI", Arial, sans-serif',
    h1: { fontSize: 'clamp(3.1rem, 5.5vw, 5.7rem)', fontWeight: 600, letterSpacing: '-0.075em', lineHeight: 1.04 },
    h2: { fontSize: 'clamp(2.5rem, 4.3vw, 4.5rem)', fontWeight: 600, letterSpacing: '-0.065em', lineHeight: 1.08 },
    h3: { fontSize: '1.6rem', fontWeight: 600, letterSpacing: '-0.04em' },
    h4: { fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.02em' },
    body1: { lineHeight: 1.7 },
    body2: { lineHeight: 1.6 },
    button: { textTransform: 'none', fontWeight: 600 },
    overline: { fontSize: '0.65rem', letterSpacing: '0.16em', fontWeight: 600 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 50, padding: '10px 20px', minHeight: 44 } } },
    MuiButtonBase: { styleOverrides: { root: { '&.Mui-focusVisible': { outline: '3px solid #789132', outlineOffset: 4 } } } },
    MuiChip: { styleOverrides: { root: { fontSize: 11, fontWeight: 600 } } },
    MuiCssBaseline: { styleOverrides: {
      'html': { scrollBehavior: 'smooth' },
      'body': { margin: 0 },
      '::selection': { background: '#d7ef75', color: '#18211c' },
      '@keyframes arrive': { from: { opacity: 0, transform: 'translateY(16px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
      '@keyframes orbit': { to: { transform: 'rotate(360deg)' } },
      '@keyframes breathe': { '0%, 100%': { transform: 'scale(1)', opacity: 0.7 }, '50%': { transform: 'scale(1.035)', opacity: 1 } },
      '@keyframes travel': { from: { strokeDashoffset: 48 }, to: { strokeDashoffset: 0 } },
      '[data-motion="still"] *, [data-motion="still"] *::before, [data-motion="still"] *::after': { animation: 'none !important', transition: 'none !important', scrollBehavior: 'auto !important' },
      '@media (prefers-reduced-motion: reduce)': { '*, *::before, *::after': { animation: 'none !important', transition: 'none !important', scrollBehavior: 'auto !important' } },
    } },
  },
});

export function PitchTheme({ children }: { readonly children: ReactNode }) {
  return <AppRouterCacheProvider><ThemeProvider theme={theme}><CssBaseline />{children}</ThemeProvider></AppRouterCacheProvider>;
}
