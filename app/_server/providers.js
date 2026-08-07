const CHAT_MODEL = 'gemini-3.5-flash-lite';

export async function callGemini(apiKey, payload, model = CHAT_MODEL) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: { message: text } }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function geminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .filter(part => typeof part.text === 'string' && !part.thought)
    .map(part => part.text)
    .join('')
    .trim();
}

export async function searchWeb(apiKey, query) {
  if (!apiKey) throw new Error('Geen gratis Tavily-key ingesteld. Open Instellingen → Live web search.');
  const cleanQuery = String(query || '').trim().slice(0, 500);
  if (!cleanQuery) throw new Error('Een zoekvraag is vereist.');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: cleanQuery,
      search_depth: 'basic',
      max_results: 6,
      include_answer: 'basic',
      include_raw_content: false,
    }),
    cache: 'no-store',
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!response.ok) {
    const detail = Array.isArray(data?.detail) ? data.detail.map(item => item.msg).join(', ') : data?.detail;
    const error = new Error(detail || data?.error || `Tavily HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return {
    ok: true,
    answer: String(data.answer || '').slice(0, 4000),
    results: (data.results || []).slice(0, 6).map(result => ({
      title: String(result.title || result.url || '').slice(0, 240),
      url: String(result.url || ''),
      content: String(result.content || '').slice(0, 1600),
      published_date: result.published_date || null,
    })).filter(result => /^https?:\/\//.test(result.url)),
  };
}

function weatherLabel(code) {
  const value = Number(code);
  if (value === 0) return 'heldere hemel';
  if ([1, 2].includes(value)) return 'licht tot gedeeltelijk bewolkt';
  if (value === 3) return 'bewolkt';
  if ([45, 48].includes(value)) return 'mist';
  if ([51, 53, 55, 56, 57].includes(value)) return 'motregen';
  if ([61, 63, 65, 66, 67].includes(value)) return 'regen';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'sneeuw';
  if ([80, 81, 82].includes(value)) return 'regenbuien';
  if ([95, 96, 99].includes(value)) return 'onweer';
  return 'wisselvallig';
}

export async function getWeather(input) {
  let latitude = Number(input?.latitude);
  let longitude = Number(input?.longitude);
  let label = 'Jouw locatie';

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const location = String(input?.location || '').trim().slice(0, 200);
    if (!location) throw Object.assign(new Error('Noem een plaats of geef locatietoegang.'), { status: 400 });
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=nl&format=json`, { cache: 'no-store' });
    const data = await response.json();
    const place = data?.results?.[0];
    if (!response.ok || !place) throw Object.assign(new Error(`Ik kon deze plaats niet vinden: ${location}`), { status: 404 });
    latitude = Number(place.latitude);
    longitude = Number(place.longitude);
    label = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('Ongeldige locatiecoördinaten.'), { status: 400 });
  }

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone: 'auto',
    forecast_days: '3',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data?.error) throw Object.assign(new Error(data?.reason || 'Live weer is tijdelijk niet beschikbaar.'), { status: 502 });

  const current = data.current || {};
  const daily = data.daily || {};
  return {
    ok: true,
    source: 'Open-Meteo',
    location: label,
    latitude,
    longitude,
    observed_at: current.time,
    timezone: data.timezone,
    current: {
      condition: weatherLabel(current.weather_code),
      temperature_c: current.temperature_2m,
      feels_like_c: current.apparent_temperature,
      humidity_percent: current.relative_humidity_2m,
      precipitation_mm: current.precipitation,
      cloud_cover_percent: current.cloud_cover,
      wind_kmh: current.wind_speed_10m,
      gust_kmh: current.wind_gusts_10m,
    },
    forecast: (daily.time || []).slice(0, 3).map((date, index) => ({
      date,
      condition: weatherLabel(daily.weather_code?.[index]),
      max_c: daily.temperature_2m_max?.[index],
      min_c: daily.temperature_2m_min?.[index],
      precipitation_probability_max: daily.precipitation_probability_max?.[index],
      precipitation_mm: daily.precipitation_sum?.[index],
      max_wind_kmh: daily.wind_speed_10m_max?.[index],
    })),
  };
}

export function friendlyProviderError(error, fallback) {
  if (error?.status === 429) return 'Je gratis daglimiet is bereikt. Probeer later opnieuw; er wordt niets aangerekend.';
  if (error?.status === 403) return 'Deze gratis API-key heeft geen toegang tot het gekozen model of de regio.';
  if (error?.status === 401 || error?.status === 400 && /api key/i.test(error?.message || '')) return 'De API-key is ongeldig of niet actief.';
  return error?.message || fallback;
}
