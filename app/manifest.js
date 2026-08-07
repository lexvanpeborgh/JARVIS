export default function manifest() {
  return {
    name: 'JARVIS AI',
    short_name: 'JARVIS',
    description: 'Personal AI Core',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#010711',
    theme_color: '#020914',
    orientation: 'portrait-primary',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    ],
  };
}
