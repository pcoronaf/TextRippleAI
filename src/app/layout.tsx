import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'TextRippleAI',
  description:
    'A change-aware AI writing environment for long-form documents: Word-like editing with structured change provenance.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
