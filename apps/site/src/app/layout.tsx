import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '../providers.tsx';

export const metadata: Metadata = {
  title: 'Devrandom',
  description: 'Governed, self-evolving agent harnesses.',
};

interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
