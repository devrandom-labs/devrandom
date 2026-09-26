import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PitchTheme } from '../pitch-theme.tsx';

export const metadata: Metadata = {
  title: 'Devrandom — Better agents. Bounded authority.',
  description:
    'An interactive pitch for governed, self-improving agents. Explore identity, evidence, promotion, continuity, and portable behavior.',
};

export default function Layout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PitchTheme>{children}</PitchTheme>
      </body>
    </html>
  );
}
