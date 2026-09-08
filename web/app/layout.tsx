import type { Metadata } from 'next';
import './globals.css';
import { env } from 'cloudflare:workers';

export const metadata: Metadata = {
  metadataBase: new URL(
    (env as unknown as { SITE_URL?: string }).SITE_URL ||
      'http://localhost:3001',
  ),
  title: 'Bi’ Plan — İstanbul’da sana göre bir şey var',
  icons: { icon: '/favicon.svg' },
  description:
    'Ne yapmak istediğini anlat. İstanbul’daki gerçek etkinlikler arasından sana uygun bir plan bul.',
  openGraph: {
    title: 'Bi’ Plan',
    description: 'İstanbul’da sana göre bir şey var.',
    locale: 'tr_TR',
    type: 'website',
    images: [{ url: '/og.png', width: 1731, height: 909 }],
  },
  twitter: {
    card: 'summary_large_image',
    images: ['/og.png'],
    title: 'Bi’ Plan',
    description: 'İstanbul’da sana göre bir şey var.',
  },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
