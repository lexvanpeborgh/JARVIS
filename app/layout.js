import './globals.css';

export const metadata = {
  title: 'JARVIS · Personal Intelligence',
  description: 'Jouw persoonlijke, mobiele AI-assistent met stem, geheugen en acties.',
  applicationName: 'JARVIS',
  manifest: '/manifest.webmanifest',
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    title: 'JARVIS',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#02070c',
};

export default function RootLayout({ children }) {
  return (
    <html lang="nl-BE">
      <body>{children}</body>
    </html>
  );
}
