# JARVIS Personal Core v4

Een gratis installeerbare persoonlijke assistent voor telefoon en computer.

Live: https://jarvis-v2-delta.vercel.app/

## Wat JARVIS kan

- Typen, dicteren en live praten met een audioantwoord
- Uitleg geven, bestanden en afbeeldingen analyseren en actuele informatie opzoeken
- Weer tonen zonder API-key
- Taken, afspraken, notities en een lokaal Memory Core beheren
- Agenda-afspraken als `.ics` naar de telefoonagenda exporteren
- Eenvoudige vectorvisuals maken zonder betaalde beeldgenerator
- Als PWA op iPhone, Android en desktop installeren
- Lokale gegevens exporteren en herstellen

## Gratis opzet

Chat en bestandsanalyse gebruiken `gemini-3.5-flash-lite`. Live audio gebruikt
`gemini-3.1-flash-live-preview`. De gebruiker vult een eigen Gemini Free Tier-key
in bij Instellingen. Actuele webresultaten gebruiken optioneel een gratis
Tavily-key; het weer gebruikt Open-Meteo en heeft geen key nodig.

Keys blijven in de lokale browseropslag van het toestel. Ze staan niet in deze
repository, niet in een JARVIS-back-up en niet in Vercel-omgevingsvariabelen. Voor
Live krijgt de browser via de backend een kortlevend Gemini-token, zodat de
langlevende key niet in de Live-WebSocket terechtkomt.

De gratis Gemini-laag kan ingestuurde inhoud gebruiken om Google-producten te
verbeteren. Stuur daarom geen wachtwoorden of zeer vertrouwelijke documenten.

## Installeren op iPhone

Open de live link in Safari, tik op Delen, kies `Zet op beginscherm` en voeg de app
toe. Open daarna JARVIS, ga naar Instellingen en vul de gratis Gemini-key in.

## Lokaal ontwikkelen

```bash
pnpm install
pnpm dev
```

Voor een productiecontrole:

```bash
pnpm build
```

JARVIS gebruikt Next.js 16, React 19 en de App Router.
