import './globals.css';

export const metadata = {
  title: 'JARVIS',
  description: 'Personal AI Core',
  applicationName: 'JARVIS',
  appleWebApp: {
    capable: true,
    title: 'JARVIS',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#020914',
};

export default function RootLayout({ children }) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
