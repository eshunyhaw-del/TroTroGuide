import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import './globals.css';

// Aspekta — self-hosted variable font (weights 100–900), exposed as a CSS variable so globals.css's
// `--font` can pick it up as the primary family.
const aspekta = localFont({
  src: './fonts/AspektaVF.woff2',
  variable: '--font-aspekta',
  display: 'swap',
  weight: '100 900',
});

export const metadata = {
  title: 'Trotro Guide',
  description: 'Navigate Accra trotros by local name — works offline.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={aspekta.variable}>
      <body>{children}</body>
    </html>
  );
}
