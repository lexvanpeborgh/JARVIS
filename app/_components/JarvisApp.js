'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import JarvisOrb from './JarvisOrb';
import useLiveVoice from '../_hooks/useLiveVoice';
import {
  APP_STORAGE_KEY,
  GEMINI_KEY_STORAGE,
  TAVILY_KEY_STORAGE,
  createInitialState,
  downloadIcs,
  downloadJson,
  formatLocalDate,
  normalizeState,
  relevantHistory,
  relevantMemories,
  uid,
} from '../_lib/jarvis-data';

const navItems = [
  ['core', 'core', 'Core'],
  ['chat', 'chat', 'Chat'],
  ['organize', 'organize', 'Planning'],
  ['memory', 'memory', 'Geheugen'],
  ['settings', 'settings', 'Instellingen'],
];

const quickPrompts = [
  ['Maak mijn dagplanning', 'Plan mijn dag op basis van mijn taken, agenda en doelen.'],
  ['Plan mijn looptraining', 'Help me mijn volgende loop- of marathontraining slim te plannen.'],
  ['Live wielernieuws', 'Zoek het belangrijkste actuele wielernieuws en geef bronnen.'],
  ['Leg iets helder uit', 'Ik wil iets laten uitleggen in duidelijke, praktische stappen.'],
];

function greeting(hour) {
  if (hour < 6) return 'Goedenacht';
  if (hour < 12) return 'Goedemorgen';
  if (hour < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Bestand kon niet worden gelezen.'));
    reader.readAsDataURL(file);
  });
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function RichText({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <div className="richText">
      {lines.map((line, lineIndex) => {
        const parts = line.split(/(https?:\/\/[^\s)]+)/g);
        return (
          <span className="richLine" key={`${lineIndex}-${line.slice(0, 12)}`}>
            {parts.map((part, partIndex) => {
              const link = safeLink(part);
              return link
                ? <a href={link} key={`${partIndex}-${part}`} target="_blank" rel="noreferrer">{part}</a>
                : <span key={`${partIndex}-${part}`}>{part}</span>;
            })}
          </span>
        );
      })}
    </div>
  );
}

function Panel({ title, eyebrow, action, className = '', children }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panelHeader">
        <div>
          {eyebrow && <small>{eyebrow}</small>}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function EmptyState({ icon, title, text }) {
  return (
    <div className="emptyState">
      <Icon name={icon} size={25} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

export default function JarvisApp() {
  const [state, setState] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState('core');
  const [organizePane, setOrganizePane] = useState('tasks');
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [geminiKey, setGeminiKey] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [keyStatus, setKeyStatus] = useState('');
  const [searchKeyStatus, setSearchKeyStatus] = useState('');
  const [toast, setToast] = useState('');
  const [clock, setClock] = useState(null);
  const [online, setOnline] = useState(true);
  const [weather, setWeather] = useState(null);
  const [weatherError, setWeatherError] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [eventTitle, setEventTitle] = useState('');
  const [eventWhen, setEventWhen] = useState('');
  const [memoryText, setMemoryText] = useState('');
  const [memorySearch, setMemorySearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const handledActionRef = useRef(false);

  const safeState = state || {
    profile: { name: '', homeLocation: 'Mortsel', responseStyle: 'duidelijk en praktisch', autoSpeak: false },
    messages: [], conversations: [], voiceArchive: [], memories: [], tasks: [], events: [], notes: '',
  };

  const flash = useCallback(message => {
    setToast(String(message || ''));
    window.clearTimeout(flash.timer);
    flash.timer = window.setTimeout(() => setToast(''), 3000);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(APP_STORAGE_KEY);
      setState(saved ? normalizeState(JSON.parse(saved)) : createInitialState());
      setGeminiKey(localStorage.getItem(GEMINI_KEY_STORAGE) || '');
      setTavilyKey(localStorage.getItem(TAVILY_KEY_STORAGE) || '');
    } catch {
      setState(createInitialState());
    }
    setClock(new Date());
    setOnline(navigator.onLine);
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone));
    setHydrated(true);

    const clockTimer = window.setInterval(() => setClock(new Date()), 30000);
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    const installHandler = event => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    window.addEventListener('beforeinstallprompt', installHandler);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => {
      window.clearInterval(clockTimer);
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
      window.removeEventListener('beforeinstallprompt', installHandler);
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !state) return;
    try { localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({ ...state, updatedAt: new Date().toISOString() })); } catch {}
  }, [hydrated, state]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (geminiKey) localStorage.setItem(GEMINI_KEY_STORAGE, geminiKey);
      else localStorage.removeItem(GEMINI_KEY_STORAGE);
    } catch {}
  }, [geminiKey, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (tavilyKey) localStorage.setItem(TAVILY_KEY_STORAGE, tavilyKey);
      else localStorage.removeItem(TAVILY_KEY_STORAGE);
    } catch {}
  }, [tavilyKey, hydrated]);

  useEffect(() => {
    if (tab === 'chat') messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [safeState.messages, tab]);

  const applyActions = useCallback(actions => {
    if (!Array.isArray(actions) || !actions.length) return;
    setState(previous => {
      if (!previous) return previous;
      let next = { ...previous };
      for (const action of actions) {
        if (action.type === 'save_memory' && action.text) {
          const exists = next.memories.some(item => item.text.toLocaleLowerCase('nl-BE') === String(action.text).toLocaleLowerCase('nl-BE'));
          if (!exists) next.memories = [...next.memories, { id: uid('mem'), text: String(action.text), category: action.category || 'general', source: 'JARVIS', createdAt: new Date().toISOString() }];
        }
        if (action.type === 'add_task' && action.title) {
          next.tasks = [...next.tasks, { id: uid('task'), title: String(action.title), due: action.due || '', done: false, createdAt: new Date().toISOString() }];
        }
        if (action.type === 'add_event' && action.title && action.when) {
          next.events = [...next.events, { id: uid('event'), title: String(action.title), when: String(action.when), createdAt: new Date().toISOString() }];
        }
        if (action.type === 'save_note' && action.text) {
          next.notes = `${next.notes || ''}${next.notes ? '\n\n' : ''}${String(action.text)}`.slice(0, 200000);
        }
        if (action.type === 'open_url' && action.url) {
          const url = safeLink(action.url);
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        }
      }
      return next;
    });
    flash(actions.length === 1 ? 'Actie opgeslagen op dit toestel' : `${actions.length} acties opgeslagen`);
  }, [flash]);

  const archiveVoice = useCallback(messages => {
    setState(previous => previous ? {
      ...previous,
      voiceArchive: [...previous.voiceArchive, { id: uid('voice-session'), createdAt: new Date().toISOString(), messages }].slice(-80),
    } : previous);
  }, []);

  const openSettings = useCallback(() => {
    setTab('settings');
    flash('Voeg eerst je gratis Gemini-key toe');
  }, [flash]);

  const live = useLiveVoice({ geminiKey, tavilyKey, state: safeState, applyActions, archiveVoice, openSettings });

  useEffect(() => {
    if (!hydrated || handledActionRef.current) return;
    handledActionRef.current = true;
    const action = new URLSearchParams(window.location.search).get('action');
    if (action === 'chat') setTab('chat');
    if (action === 'live') void live.start();
  }, [hydrated, live]);

  const loadWeather = useCallback(async useDevice => {
    setWeatherError('');
    try {
      let body = { location: safeState.profile.homeLocation || 'Mortsel' };
      if (useDevice) {
        if (!navigator.geolocation) throw new Error('Locatie is niet beschikbaar.');
        const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, maximumAge: 300000 }));
        body = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      }
      const response = await fetch('/api/weather', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Weer kon niet worden geladen.');
      setWeather(data);
    } catch (weatherFailure) {
      setWeatherError(weatherFailure?.message || 'Weer kon niet worden geladen.');
    }
  }, [safeState.profile.homeLocation]);

  useEffect(() => {
    if (hydrated && online) void loadWeather(false);
  }, [hydrated, loadWeather, online]);

  const speak = useCallback(text => {
    if (!safeState.profile.autoSpeak || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
    utterance.lang = 'nl-BE';
    utterance.rate = 0.96;
    window.speechSynthesis.speak(utterance);
  }, [safeState.profile.autoSpeak]);

  const sendMessage = useCallback(async override => {
    const message = String(override ?? draft).trim();
    if ((!message && !attachment) || busy) return;
    if (!geminiKey.trim()) {
      openSettings();
      return;
    }
    const userMessage = { id: uid('msg'), role: 'user', text: message || `Analyseer ${attachment?.filename || 'dit bestand'}.`, createdAt: new Date().toISOString(), attachmentName: attachment?.filename || '' };
    setState(previous => previous ? { ...previous, messages: [...previous.messages, userMessage] } : previous);
    setDraft('');
    setBusy(true);
    const usedAttachment = attachment;
    setAttachment(null);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gemini-key': geminiKey.trim(),
          ...(tavilyKey.trim() ? { 'x-tavily-key': tavilyKey.trim() } : {}),
        },
        body: JSON.stringify({
          message: userMessage.text,
          attachment: usedAttachment ? { filename: usedAttachment.filename, mimeType: usedAttachment.mimeType, base64: usedAttachment.base64 } : null,
          userName: safeState.profile.name,
          homeLocation: safeState.profile.homeLocation,
          responseStyle: safeState.profile.responseStyle,
          localTime: new Date().toISOString(),
          memoryContext: relevantMemories(safeState, userMessage.text, 14),
          historyMatches: relevantHistory(safeState, userMessage.text, 8).map(item => ({ role: item.role, text: item.text, createdAt: item.createdAt })),
          recentMessages: safeState.messages.slice(-14).map(item => ({ role: item.role, text: item.text })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `AI HTTP ${response.status}`);
      applyActions(data.actions || []);
      const assistantMessage = {
        id: uid('msg'),
        role: 'assistant',
        text: data.text || 'Geen antwoord ontvangen.',
        createdAt: new Date().toISOString(),
        sources: data.sources || [],
      };
      setState(previous => previous ? { ...previous, messages: [...previous.messages, assistantMessage] } : previous);
      speak(assistantMessage.text);
    } catch (sendError) {
      setState(previous => previous ? {
        ...previous,
        messages: [...previous.messages, { id: uid('msg'), role: 'assistant', text: `Ik kon dit niet afronden: ${sendError?.message || sendError}`, error: true, createdAt: new Date().toISOString() }],
      } : previous);
    } finally {
      setBusy(false);
    }
  }, [applyActions, attachment, busy, draft, geminiKey, openSettings, safeState, speak, tavilyKey]);

  const generateVisual = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || busy) {
      flash('Beschrijf eerst welke visual je wilt.');
      return;
    }
    if (!geminiKey.trim()) {
      openSettings();
      return;
    }
    const userMessage = { id: uid('msg'), role: 'user', text: `Maak een visual: ${prompt}`, createdAt: new Date().toISOString() };
    const pendingId = uid('msg');
    setState(previous => previous ? { ...previous, messages: [...previous.messages, userMessage, { id: pendingId, role: 'assistant', text: 'Visual wordt opgebouwd…', pending: true, createdAt: new Date().toISOString() }] } : previous);
    setDraft('');
    setBusy(true);
    try {
      const response = await fetch('/api/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gemini-key': geminiKey.trim() },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Visual HTTP ${response.status}`);
      setState(previous => previous ? {
        ...previous,
        messages: previous.messages.map(item => item.id === pendingId ? { ...item, text: 'Gratis vectorvisual gegenereerd.', pending: false, image: `data:${data.mediaType};base64,${data.base64}` } : item),
      } : previous);
    } catch (visualError) {
      setState(previous => previous ? {
        ...previous,
        messages: previous.messages.map(item => item.id === pendingId ? { ...item, text: `Visual mislukt: ${visualError?.message || visualError}`, pending: false, error: true } : item),
      } : previous);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, flash, geminiKey, openSettings]);

  const chooseFile = useCallback(async file => {
    if (!file) return;
    if (file.size > 2.5 * 1024 * 1024) {
      flash('Maximaal 2,5 MB per bestand voor betrouwbare mobiele uploads.');
      return;
    }
    try {
      const base64 = await readFileAsBase64(file);
      setAttachment({ filename: file.name, mimeType: file.type || 'application/octet-stream', base64, size: file.size });
      flash(`${file.name} toegevoegd`);
    } catch (fileError) {
      flash(fileError?.message || 'Bestand kon niet worden gelezen.');
    }
  }, [flash]);

  const startDictation = useCallback(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      void live.start();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'nl-BE';
    recognition.interimResults = true;
    recognition.continuous = false;
    setListening(true);
    let finalText = '';
    recognition.onresult = event => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const value = event.results[index][0].transcript;
        if (event.results[index].isFinal) finalText += value;
        else interim += value;
      }
      setDraft(`${finalText}${interim}`.trim());
    };
    recognition.onerror = event => flash(`Spraakherkenning: ${event.error}`);
    recognition.onend = () => setListening(false);
    recognition.start();
  }, [flash, live]);

  const newConversation = useCallback(() => {
    setState(previous => {
      if (!previous) return previous;
      const archive = previous.messages.length > 1 ? [...previous.conversations, { id: uid('conversation'), createdAt: new Date().toISOString(), title: previous.messages.find(item => item.role === 'user')?.text?.slice(0, 70) || 'Gesprek', messages: previous.messages }].slice(-80) : previous.conversations;
      return {
        ...previous,
        conversations: archive,
        messages: [{ id: uid('msg'), role: 'assistant', text: 'Nieuw gesprek gestart. Mijn Memory Core blijft actief.', createdAt: new Date().toISOString() }],
      };
    });
    flash('Nieuw gesprek gestart');
  }, [flash]);

  const addTask = useCallback(() => {
    if (!taskTitle.trim()) return;
    applyActions([{ type: 'add_task', title: taskTitle.trim(), due: taskDue }]);
    setTaskTitle('');
    setTaskDue('');
  }, [applyActions, taskDue, taskTitle]);

  const addEvent = useCallback(() => {
    if (!eventTitle.trim() || !eventWhen) return;
    applyActions([{ type: 'add_event', title: eventTitle.trim(), when: eventWhen }]);
    setEventTitle('');
    setEventWhen('');
  }, [applyActions, eventTitle, eventWhen]);

  const addMemory = useCallback(() => {
    if (!memoryText.trim()) return;
    applyActions([{ type: 'save_memory', text: memoryText.trim(), category: 'general' }]);
    setMemoryText('');
  }, [applyActions, memoryText]);

  const testGeminiKey = useCallback(async () => {
    if (!geminiKey.trim()) {
      setKeyStatus('Voeg eerst een key toe.');
      return;
    }
    setKeyStatus('Verbinding testen…');
    try {
      const response = await fetch('/api/key-test', { method: 'POST', headers: { 'x-gemini-key': geminiKey.trim() } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setKeyStatus('✓ Gratis Gemini-verbinding werkt');
    } catch (keyError) {
      setKeyStatus(`✕ ${keyError?.message || keyError}`);
    }
  }, [geminiKey]);

  const testSearchKey = useCallback(async () => {
    if (!tavilyKey.trim()) {
      setSearchKeyStatus('Voeg eerst een key toe.');
      return;
    }
    setSearchKeyStatus('Zoekfunctie testen…');
    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tavily-key': tavilyKey.trim() },
        body: JSON.stringify({ query: 'België vandaag' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setSearchKeyStatus('✓ Gratis live web search werkt');
    } catch (keyError) {
      setSearchKeyStatus(`✕ ${keyError?.message || keyError}`);
    }
  }, [tavilyKey]);

  const installApp = useCallback(async () => {
    if (isStandalone) {
      flash('JARVIS is al als app geïnstalleerd.');
      return;
    }
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
      return;
    }
    setInstallHelp(true);
  }, [flash, installPrompt, isStandalone]);

  const importBackup = useCallback(async file => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      setState(normalizeState(value));
      flash('JARVIS-back-up hersteld');
    } catch {
      flash('Dit is geen geldige JARVIS-back-up.');
    }
  }, [flash]);

  const resetData = useCallback(() => {
    if (!window.confirm('Alle lokale gesprekken, herinneringen, taken, agenda en notities wissen?')) return;
    setState(createInitialState());
    flash('Lokale JARVIS-data is opnieuw gestart');
  }, [flash]);

  const upcomingEvents = useMemo(() => [...safeState.events]
    .filter(event => !Number.isNaN(new Date(event.when).getTime()) && new Date(event.when).getTime() >= Date.now() - 3600000)
    .sort((a, b) => new Date(a.when) - new Date(b.when)), [safeState.events, clock]);

  const openTasks = useMemo(() => safeState.tasks.filter(task => !task.done), [safeState.tasks]);
  const filteredMemories = useMemo(() => safeState.memories.filter(item => !memorySearch || `${item.text} ${item.category}`.toLocaleLowerCase('nl-BE').includes(memorySearch.toLocaleLowerCase('nl-BE'))), [memorySearch, safeState.memories]);
  const historyResults = useMemo(() => historySearch.trim() ? relevantHistory(safeState, historySearch, 20) : [], [historySearch, safeState]);

  const selectPrompt = useCallback(prompt => {
    setDraft(prompt);
    setTab('chat');
  }, []);

  if (!hydrated || !state || !clock) {
    return (
      <div className="bootScreen">
        <JarvisOrb active compact status="BOOT" />
        <div><strong>JARVIS</strong><span>PERSONAL CORE INITIALIZING</span></div>
      </div>
    );
  }

  return (
    <div className="appShell">
      <aside className="sideRail">
        <div className="brandMark"><span>J</span><div><strong>JARVIS</strong><small>PERSONAL INTELLIGENCE</small></div></div>
        <nav aria-label="Hoofdnavigatie">
          {navItems.map(([id, icon, label]) => (
            <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)} type="button">
              <Icon name={icon} /><span>{label}</span>{id === 'organize' && openTasks.length > 0 && <b>{openTasks.length}</b>}
            </button>
          ))}
        </nav>
        <div className="railStatus">
          <span className={online ? 'online' : 'offline'} />
          <div><strong>{online ? 'SYSTEM ONLINE' : 'OFFLINE MODE'}</strong><small>{geminiKey ? 'AI core configured' : 'AI setup required'}</small></div>
        </div>
      </aside>

      <main className={`mainStage tab-${tab}`}>
        <header className="mobileHeader">
          <div className="brandMark"><span>J</span><div><strong>JARVIS</strong><small>PERSONAL INTELLIGENCE</small></div></div>
          <div className="mobileStatus"><span className={online ? 'online' : 'offline'} />{online ? 'ONLINE' : 'OFFLINE'}</div>
        </header>

        {tab === 'core' && (
          <div className="page corePage">
            <section className="coreHero">
              <div className="heroCopy">
                <span className="eyebrow">{clock.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                <h1>{greeting(clock.getHours())}{safeState.profile.name ? `, ${safeState.profile.name}` : ''}.</h1>
                <p>{geminiKey ? 'Alle persoonlijke systemen zijn beschikbaar.' : 'De interface is klaar. Koppel je gratis AI-core om gesprekken te starten.'}</p>
              </div>
              <div className="clockReadout"><strong>{clock.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' })}</strong><span>EUROPE / BRUSSELS</span></div>
            </section>

            <div className="coreGrid">
              <section className="orbStage">
                <div className="hudCorners" />
                <JarvisOrb active={live.status === 'listening'} status={geminiKey ? 'TAP TO SPEAK' : 'SETUP REQUIRED'} onClick={live.start} />
                <div className="orbCaption"><span /><div><strong>VOICE LINK</strong><small>{geminiKey ? 'Gemini Live · ready' : 'Gratis Gemini-key vereist'}</small></div><span /></div>
              </section>

              <div className="coreSide">
                <Panel title="Live omgeving" eyebrow="SITUATIONAL DATA" action={<button className="iconButton" onClick={() => loadWeather(true)} aria-label="Gebruik huidige locatie"><Icon name="refresh" /></button>}>
                  {weather ? (
                    <div className="weatherCard">
                      <Icon name="weather" size={32} />
                      <div><strong>{Math.round(weather.current.temperature_c)}°</strong><span>{weather.current.condition}</span></div>
                      <div className="weatherMeta"><b>{weather.location}</b><span>Voelt als {Math.round(weather.current.feels_like_c)}° · wind {Math.round(weather.current.wind_kmh)} km/u</span><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weerdata: Open-Meteo</a></div>
                    </div>
                  ) : <div className="inlineLoader">{weatherError || 'Live weer wordt geladen…'}</div>}
                </Panel>
                <Panel title="Volgende stap" eyebrow="YOUR DAY">
                  <div className="nextItems">
                    {upcomingEvents[0] && <button onClick={() => { setTab('organize'); setOrganizePane('calendar'); }}><Icon name="calendar" /><span><small>AGENDA</small><strong>{upcomingEvents[0].title}</strong><em>{formatLocalDate(upcomingEvents[0].when)}</em></span></button>}
                    {openTasks[0] && <button onClick={() => { setTab('organize'); setOrganizePane('tasks'); }}><Icon name="task" /><span><small>OPEN TAAK</small><strong>{openTasks[0].title}</strong><em>{openTasks[0].due ? formatLocalDate(openTasks[0].due) : 'Geen deadline'}</em></span></button>}
                    {!upcomingEvents[0] && !openTasks[0] && <EmptyState icon="check" title="Alles rustig" text="Geen open taken of komende afspraken." />}
                  </div>
                </Panel>
              </div>
            </div>

            <Panel title="Snelle opdrachten" eyebrow="PERSONAL SHORTCUTS" className="quickPanel">
              <div className="quickGrid">
                {quickPrompts.map(([label, prompt], index) => (
                  <button key={label} onClick={() => selectPrompt(prompt)} type="button"><span>0{index + 1}</span><strong>{label}</strong><Icon name="send" size={17} /></button>
                ))}
              </div>
            </Panel>

            <div className="systemStrip">
              <div><span className={geminiKey ? 'ok' : ''} /><b>AI CORE</b><em>{geminiKey ? 'READY' : 'SETUP'}</em></div>
              <div><span className="ok" /><b>MEMORY</b><em>{safeState.memories.length} ITEMS</em></div>
              <div><span className="ok" /><b>WEATHER</b><em>LIVE</em></div>
              <div><span className={tavilyKey ? 'ok' : ''} /><b>WEB LINK</b><em>{tavilyKey ? 'READY' : 'OPTIONAL'}</em></div>
            </div>
          </div>
        )}

        {tab === 'chat' && (
          <div className="page chatPage">
            <div className="pageTitle chatTitle">
              <div><span className="eyebrow">CONVERSATION LINK</span><h1>Chat met JARVIS</h1><p>Context, geheugen en lokale acties blijven gekoppeld.</p></div>
              <button className="secondaryButton" onClick={newConversation}><Icon name="plus" />Nieuw gesprek</button>
            </div>
            <div className="messageStream">
              {safeState.messages.map(message => (
                <article className={`message ${message.role} ${message.error ? 'messageError' : ''}`} key={message.id}>
                  <div className="messageIdentity">{message.role === 'assistant' ? <span className="miniCore">J</span> : <span className="userDot">U</span>}</div>
                  <div className="messageBody">
                    <header><strong>{message.role === 'assistant' ? 'JARVIS' : (safeState.profile.name || 'JIJ')}</strong><time>{formatLocalDate(message.createdAt, { day: undefined, month: undefined })}</time></header>
                    {message.attachmentName && <div className="attachmentTag"><Icon name="attachment" size={14} />{message.attachmentName}</div>}
                    <RichText text={message.text} />
                    {message.pending && <div className="thinkingDots"><i /><i /><i /></div>}
                    {message.image && <img className="generatedVisual" src={message.image} alt="Door JARVIS gegenereerde vectorvisual" />}
                    {message.sources?.length > 0 && <div className="sources"><small>BRONNEN</small>{message.sources.map(source => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><Icon name="external" size={13} />{source.title || new URL(source.url).hostname}</a>)}</div>}
                    <footer><button onClick={() => { navigator.clipboard?.writeText(message.text); flash('Gekopieerd'); }}><Icon name="copy" size={14} />Kopieer</button>{message.role === 'assistant' && <button onClick={() => { const utterance = new SpeechSynthesisUtterance(message.text); utterance.lang = 'nl-BE'; window.speechSynthesis?.speak(utterance); }}><Icon name="volume" size={14} />Lees voor</button>}</footer>
                  </div>
                </article>
              ))}
              {busy && <article className="message assistant"><div className="messageIdentity"><span className="miniCore">J</span></div><div className="messageBody"><header><strong>JARVIS</strong></header><div className="thinkingDots"><i /><i /><i /></div></div></article>}
              <div ref={messagesEndRef} />
            </div>
            <div className="composerWrap">
              {attachment && <div className="selectedAttachment"><Icon name="attachment" /><div><strong>{attachment.filename}</strong><small>{Math.round(attachment.size / 1024)} KB</small></div><button onClick={() => setAttachment(null)} aria-label="Bijlage verwijderen"><Icon name="close" /></button></div>}
              <div className="composer">
                <button className="composerButton" onClick={() => fileInputRef.current?.click()} aria-label="Bestand toevoegen"><Icon name="attachment" /></button>
                <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Vraag alles, of geef JARVIS een opdracht…" rows={1} />
                <button className={`composerButton ${listening ? 'active' : ''}`} onClick={startDictation} aria-label="Dicteren"><Icon name="mic" /></button>
                <button className="sendButton" onClick={() => sendMessage()} disabled={busy || (!draft.trim() && !attachment)} aria-label="Verstuur"><Icon name="send" /></button>
              </div>
              <div className="composerTools"><button onClick={generateVisual}><Icon name="image" size={15} />Maak gratis visual</button><span>Enter om te versturen · Shift+Enter voor nieuwe regel</span></div>
              <input ref={fileInputRef} type="file" hidden accept="image/*,.pdf,.txt,.md,.csv,.json" onChange={event => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
            </div>
          </div>
        )}

        {tab === 'organize' && (
          <div className="page organizePage">
            <div className="pageTitle"><div><span className="eyebrow">PERSONAL OPERATIONS</span><h1>Planning</h1><p>Taken, afspraken en notities blijven lokaal op dit toestel.</p></div></div>
            <div className="segmented">
              {[['tasks', 'task', 'Taken'], ['calendar', 'calendar', 'Agenda'], ['notes', 'note', 'Notities']].map(([id, icon, label]) => <button className={organizePane === id ? 'active' : ''} key={id} onClick={() => setOrganizePane(id)}><Icon name={icon} />{label}</button>)}
            </div>
            {organizePane === 'tasks' && <div className="organizeGrid"><Panel title="Nieuwe taak" eyebrow="CAPTURE"><div className="formStack"><label>Taak<input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} placeholder="Wat moet er gebeuren?" /></label><label>Deadline (optioneel)<input type="datetime-local" value={taskDue} onChange={event => setTaskDue(event.target.value)} /></label><button className="primaryButton" onClick={addTask}><Icon name="plus" />Taak toevoegen</button></div></Panel><Panel title={`${openTasks.length} open taken`} eyebrow="TASK QUEUE" className="widePanel"><div className="itemList">{safeState.tasks.length ? safeState.tasks.map(task => <div className={`listItem ${task.done ? 'done' : ''}`} key={task.id}><button className="checkButton" onClick={() => setState(previous => ({ ...previous, tasks: previous.tasks.map(item => item.id === task.id ? { ...item, done: !item.done } : item) }))}><Icon name={task.done ? 'check' : 'plus'} size={16} /></button><div><strong>{task.title}</strong><small>{task.due ? formatLocalDate(task.due) : 'Geen deadline'}</small></div><button className="ghostDanger" onClick={() => setState(previous => ({ ...previous, tasks: previous.tasks.filter(item => item.id !== task.id) }))}><Icon name="trash" size={16} /></button></div>) : <EmptyState icon="task" title="Geen taken" text="Voeg zelf iets toe of zeg tegen JARVIS: ‘zet dit in mijn taken’." />}</div></Panel></div>}
            {organizePane === 'calendar' && <div className="organizeGrid"><Panel title="Nieuwe afspraak" eyebrow="SCHEDULE"><div className="formStack"><label>Titel<input value={eventTitle} onChange={event => setEventTitle(event.target.value)} placeholder="Training, afspraak, deadline…" /></label><label>Datum en uur<input type="datetime-local" value={eventWhen} onChange={event => setEventWhen(event.target.value)} /></label><button className="primaryButton" onClick={addEvent}><Icon name="plus" />In agenda zetten</button></div></Panel><Panel title="Komende afspraken" eyebrow="TIMELINE" className="widePanel"><div className="timeline">{upcomingEvents.length ? upcomingEvents.map(event => <div className="timelineItem" key={event.id}><div className="timelineDate"><strong>{new Date(event.when).getDate()}</strong><small>{new Date(event.when).toLocaleDateString('nl-BE', { month: 'short' })}</small></div><div><strong>{event.title}</strong><small>{formatLocalDate(event.when, { weekday: 'long' })}</small></div><button onClick={() => { downloadIcs(event); flash('Agenda-bestand gemaakt'); }} title="Zet in telefoonagenda"><Icon name="download" /></button><button className="ghostDanger" onClick={() => setState(previous => ({ ...previous, events: previous.events.filter(item => item.id !== event.id) }))}><Icon name="trash" /></button></div>) : <EmptyState icon="calendar" title="Agenda is leeg" text="Voeg hier iets toe of laat JARVIS het voor je plannen." />}</div></Panel></div>}
            {organizePane === 'notes' && <Panel title="Doorlopende notities" eyebrow="LOCAL NOTEBOOK" className="notesPanel"><textarea className="notesArea" value={safeState.notes} onChange={event => setState(previous => ({ ...previous, notes: event.target.value }))} placeholder="Schrijf hier. Alles wordt automatisch lokaal bewaard…" /><div className="notesMeta"><span>{safeState.notes.length.toLocaleString('nl-BE')} tekens</span><button onClick={() => navigator.clipboard?.writeText(safeState.notes)}><Icon name="copy" />Kopieer alles</button></div></Panel>}
          </div>
        )}

        {tab === 'memory' && (
          <div className="page memoryPage">
            <div className="pageTitle"><div><span className="eyebrow">LONG-TERM CONTEXT</span><h1>Memory Core</h1><p>Jij bepaalt wat JARVIS duurzaam onthoudt.</p></div><div className="memoryCounter"><strong>{safeState.memories.length}</strong><span>MEMORIES</span></div></div>
            <div className="memoryGrid">
              <Panel title="Nieuwe herinnering" eyebrow="TEACH JARVIS"><div className="inlineForm"><input value={memoryText} onChange={event => setMemoryText(event.target.value)} onKeyDown={event => event.key === 'Enter' && addMemory()} placeholder="Onthoud dat…" /><button onClick={addMemory}><Icon name="plus" /></button></div><p className="helperText">Gebruik dit voor voorkeuren, doelen, routines en feiten die later nuttig blijven.</p></Panel>
              <Panel title="Zoek oude gesprekken" eyebrow="HISTORY RETRIEVAL"><div className="searchField"><Icon name="search" /><input value={historySearch} onChange={event => setHistorySearch(event.target.value)} placeholder="Waar hadden we het over?" /></div>{historySearch && <div className="historyResults">{historyResults.length ? historyResults.map(item => <div key={item.id || `${item.createdAt}-${item.text}`}><small>{item.role === 'assistant' ? 'JARVIS' : 'JIJ'} · {formatLocalDate(item.createdAt)}</small><p>{item.text}</p></div>) : <span>Geen relevante gesprekken gevonden.</span>}</div>}</Panel>
            </div>
            <Panel title="Opgeslagen context" eyebrow="MEMORY INDEX" action={<div className="searchField compact"><Icon name="search" /><input value={memorySearch} onChange={event => setMemorySearch(event.target.value)} placeholder="Filter" /></div>}>
              <div className="memoryList">{filteredMemories.map(memory => <article key={memory.id}><div className="memoryIcon"><Icon name="memory" /></div><div><small>{memory.category || 'general'} · {memory.source || 'JARVIS'}</small><p>{memory.text}</p></div><button className="ghostDanger" onClick={() => setState(previous => ({ ...previous, memories: previous.memories.filter(item => item.id !== memory.id) }))}><Icon name="trash" /></button></article>)}</div>
            </Panel>
          </div>
        )}

        {tab === 'settings' && (
          <div className="page settingsPage">
            <div className="pageTitle"><div><span className="eyebrow">SYSTEM CONTROL</span><h1>Instellingen</h1><p>Gratis AI, persoonlijk profiel, privacy en installatie.</p></div></div>
            <div className="settingsGrid">
              <Panel title="Persoonlijk profiel" eyebrow="BEHAVIOUR"><div className="formStack"><label>Jouw naam<input value={safeState.profile.name} onChange={event => setState(previous => ({ ...previous, profile: { ...previous.profile, name: event.target.value } }))} placeholder="Hoe mag JARVIS je noemen?" /></label><label>Thuislocatie voor weer<input value={safeState.profile.homeLocation} onChange={event => setState(previous => ({ ...previous, profile: { ...previous.profile, homeLocation: event.target.value } }))} placeholder="Bijvoorbeeld Mortsel" /></label><label>Antwoordstijl<select value={safeState.profile.responseStyle} onChange={event => setState(previous => ({ ...previous, profile: { ...previous.profile, responseStyle: event.target.value } }))}><option>duidelijk en praktisch</option><option>kort en direct</option><option>uitgebreid en didactisch</option><option>rustig en coachend</option></select></label><label className="toggleRow"><span><strong>Chatantwoorden voorlezen</strong><small>Gebruikt de stem van je toestel.</small></span><input type="checkbox" checked={safeState.profile.autoSpeak} onChange={event => setState(previous => ({ ...previous, profile: { ...previous.profile, autoSpeak: event.target.checked } }))} /></label></div></Panel>

              <Panel title="Gratis AI-core" eyebrow="REQUIRED"><p className="panelIntro">Gemini 3.5 Flash-Lite verzorgt chat en analyse via de gratis laag. Je key blijft in lokale browseropslag en staat niet in GitHub of je back-up.</p><div className="formStack"><label>Gemini API-key<input type="password" autoComplete="off" value={geminiKey} onChange={event => { setGeminiKey(event.target.value.trim()); setKeyStatus(''); }} placeholder="AIza…" /></label><a className="primaryButton linkButton" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer"><Icon name="external" />Maak gratis Gemini-key</a><button className="secondaryButton full" onClick={testGeminiKey}><Icon name="refresh" />Test verbinding</button>{keyStatus && <div className={`statusMessage ${keyStatus.startsWith('✓') ? 'success' : ''}`}>{keyStatus}</div>}</div></Panel>

              <Panel title="Gratis live web search" eyebrow="OPTIONAL"><p className="panelIntro">Voor nieuws, sport, prijzen en andere actuele info. Weer werkt ook zonder deze key via Open-Meteo.</p><div className="formStack"><label>Tavily API-key<input type="password" autoComplete="off" value={tavilyKey} onChange={event => { setTavilyKey(event.target.value.trim()); setSearchKeyStatus(''); }} placeholder="tvly-…" /></label><a className="secondaryButton linkButton" href="https://app.tavily.com/" target="_blank" rel="noreferrer"><Icon name="external" />Maak gratis Tavily-key</a><button className="secondaryButton full" onClick={testSearchKey}><Icon name="search" />Test live search</button>{searchKeyStatus && <div className={`statusMessage ${searchKeyStatus.startsWith('✓') ? 'success' : ''}`}>{searchKeyStatus}</div>}</div></Panel>

              <Panel title="Installeer op gsm" eyebrow="MOBILE PWA"><div className="installCard"><div className="appIconPreview"><span>J</span></div><div><strong>{isStandalone ? 'JARVIS is geïnstalleerd' : 'Zet JARVIS op je beginscherm'}</strong><p>Opent fullscreen als een app en bewaart je lokale gegevens.</p></div></div><button className="primaryButton full" onClick={installApp}><Icon name="download" />{isStandalone ? 'App is actief' : 'Installeer JARVIS'}</button></Panel>

              <Panel title="Back-up en privacy" eyebrow="LOCAL DATA"><div className="dataActions"><button onClick={() => downloadJson(`jarvis-backup-${new Date().toISOString().slice(0, 10)}.json`, state)}><Icon name="download" />Exporteer back-up</button><button onClick={() => importInputRef.current?.click()}><Icon name="upload" />Herstel back-up</button><button className="dangerButton" onClick={resetData}><Icon name="trash" />Wis lokale data</button></div><input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={event => { void importBackup(event.target.files?.[0]); event.target.value = ''; }} /><p className="privacyNote">De gratis Gemini-laag kan ingestuurde inhoud gebruiken om Google-producten te verbeteren. Deel geen wachtwoorden of zeer vertrouwelijke documenten.</p></Panel>

              <Panel title="Systeemstatus" eyebrow="CAPABILITIES"><div className="capabilityList"><div><Icon name="chat" /><span><strong>Chat & bestanden</strong><small>Gemini 3.5 Flash-Lite</small></span><b className={geminiKey ? 'ready' : ''}>{geminiKey ? 'READY' : 'SETUP'}</b></div><div><Icon name="mic" /><span><strong>Live audio</strong><small>Gemini 3.1 Flash Live</small></span><b className={geminiKey ? 'ready' : ''}>{geminiKey ? 'READY' : 'SETUP'}</b></div><div><Icon name="weather" /><span><strong>Live weer</strong><small>Open-Meteo</small></span><b className="ready">READY</b></div><div><Icon name="memory" /><span><strong>Lokaal geheugen</strong><small>{safeState.memories.length} herinneringen</small></span><b className="ready">READY</b></div></div></Panel>
            </div>
          </div>
        )}
      </main>

      <nav className="bottomNav" aria-label="Mobiele navigatie">
        {navItems.map(([id, icon, label]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon name={icon} /><span>{label}</span>{id === 'organize' && openTasks.length > 0 && <b>{openTasks.length}</b>}</button>)}
      </nav>

      {live.isOpen && (
        <div className="liveOverlay" role="dialog" aria-modal="true" aria-label="JARVIS Live">
          <div className="liveBackdrop" />
          <header><div className="brandMark"><span>J</span><div><strong>JARVIS LIVE</strong><small>SECURE REALTIME LINK</small></div></div><button onClick={live.stop} aria-label="Live sluiten"><Icon name="close" /></button></header>
          <div className="liveCore"><JarvisOrb active={live.status === 'listening'} status={live.status === 'listening' ? 'LISTENING' : live.status.toUpperCase()} /><div className={`liveStatus ${live.status}`}><span /><strong>{live.status === 'listening' ? 'Ik luister' : live.status === 'connecting' ? 'Beveiligde verbinding maken' : live.status === 'connected' ? 'Audio initialiseren' : live.status}</strong></div></div>
          <div className="liveTranscript">{live.transcript.length ? live.transcript.slice(-6).map(item => <div className={item.role} key={item.id}><small>{item.role === 'assistant' ? 'JARVIS' : 'JIJ'}</small><p>{item.text}</p></div>) : <div className="liveHint"><Icon name="mic" /><p>Zodra “Ik luister” verschijnt, kun je gewoon beginnen praten.</p></div>}</div>
          {live.error && <div className="liveError">{live.error}</div>}
          <button className="endLive" onClick={live.stop}><span><Icon name="close" /></span>Gesprek beëindigen</button>
          <p className="voiceNote">Originele volwassen, filmische AI-stem · geen imitatie van een echte persoon</p>
        </div>
      )}

      {installHelp && <div className="modalLayer" onClick={() => setInstallHelp(false)}><div className="modalCard" onClick={event => event.stopPropagation()}><button className="modalClose" onClick={() => setInstallHelp(false)}><Icon name="close" /></button><div className="modalIcon"><Icon name="download" /></div><span className="eyebrow">IPHONE INSTALLATIE</span><h2>Zet JARVIS op je beginscherm</h2><ol><li>Open deze pagina in <strong>Safari</strong>.</li><li>Tik onderaan op <strong>Deel</strong>.</li><li>Kies <strong>Zet op beginscherm</strong>.</li><li>Zet “Open als webapp” aan als dat wordt getoond.</li><li>Tik op <strong>Voeg toe</strong>.</li></ol><button className="primaryButton full" onClick={() => setInstallHelp(false)}>Begrepen</button></div></div>}

      {toast && <div className="toast"><Icon name="check" />{toast}</div>}
    </div>
  );
}
