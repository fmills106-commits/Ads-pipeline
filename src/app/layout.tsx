import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { parseTheme, THEME_COOKIE, themeAttribute } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'AI Advertising Engine',
    template: '%s · AI Advertising Engine',
  },
  description:
    'Understand a business from its website, develop advertising strategy, generate and QA creative, and learn from campaign performance.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /*
   * Read here, in the root layout, so the attribute is in the markup the
   * server sends. Any later — a client effect, a provider — and the first
   * paint uses the device's theme before switching, which is the flash this
   * exists to avoid.
   */
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html lang="en" {...themeAttribute(theme)}>
      <body className="min-h-screen bg-canvas text-ink">{children}</body>
    </html>
  );
}
