export default function manifest() {
  return {
    id: '/',
    name: 'JARVIS Personal Intelligence',
    short_name: 'JARVIS',
    description: 'Persoonlijke assistent met stem, geheugen, planning en live informatie.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    background_color: '#02070c',
    theme_color: '#02070c',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    categories: ['productivity', 'utilities'],
    shortcuts: [
      { name: 'Praat met JARVIS', short_name: 'Live', url: '/?action=live', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      { name: 'Nieuwe vraag', short_name: 'Chat', url: '/?action=chat', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
