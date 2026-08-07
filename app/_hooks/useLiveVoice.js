'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { relevantHistory, uid } from '../_lib/jarvis-data';

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function devicePosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Locatie is niet beschikbaar. Noem een stad.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000,
    });
  });
}

const liveTools = [{
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get current weather and a three day forecast. Use __device__ when the user asks for weather here or at their current location.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'A city/place, or __device__.' } },
        required: ['location'],
      },
    },
    {
      name: 'web_search',
      description: 'Search the current public web for news, sports, prices, stock, opening hours, schedules or any other fact that may have changed.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    {
      name: 'save_memory',
      description: 'Save a durable preference, goal, profile fact or project fact that the user asks JARVIS to remember.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' }, category: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'add_task',
      description: 'Add a concrete task to the local JARVIS task list.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, due: { type: 'string', description: 'Optional ISO date-time.' } },
        required: ['title'],
      },
    },
    {
      name: 'add_event',
      description: 'Add an appointment or event to the local JARVIS agenda.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' }, when: { type: 'string', description: 'ISO date-time.' } },
        required: ['title', 'when'],
      },
    },
    {
      name: 'save_note',
      description: 'Append useful text to the local JARVIS notes.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'search_history',
      description: 'Search older local JARVIS conversations when the user asks what was discussed or remembered before.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
}];

export default function useLiveVoice({ geminiKey, tavilyKey, state, applyActions, archiveVoice, openSettings }) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState([]);

  const socketRef = useRef(null);
  const micStreamRef = useRef(null);
  const inputContextRef = useRef(null);
  const inputSourceRef = useRef(null);
  const processorRef = useRef(null);
  const silentGainRef = useRef(null);
  const outputContextRef = useRef(null);
  const playbackSourcesRef = useRef(new Set());
  const playbackTimeRef = useRef(0);
  const transcriptRef = useRef([]);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const appendTranscript = useCallback((role, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    setTranscript(previous => {
      const last = previous[previous.length - 1];
      if (last?.role === role) {
        return [...previous.slice(0, -1), { ...last, text: `${last.text} ${text}`.trim() }];
      }
      return [...previous, { id: uid('voice'), role, text, createdAt: new Date().toISOString() }];
    });
  }, []);

  const stopPlayback = useCallback(() => {
    playbackSourcesRef.current.forEach(source => {
      try { source.stop(); } catch {}
    });
    playbackSourcesRef.current.clear();
    playbackTimeRef.current = outputContextRef.current?.currentTime || 0;
  }, []);

  const playPcm = useCallback(async base64 => {
    if (!base64) return;
    let context = outputContextRef.current;
    if (!context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      context = new AudioContextClass();
      outputContextRef.current = context;
    }
    if (context.state === 'suspended') await context.resume();
    const bytes = base64ToBytes(base64);
    const samples = Math.floor(bytes.byteLength / 2);
    if (!samples) return;
    const audioBuffer = context.createBuffer(1, samples, 24000);
    const channel = audioBuffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.025, playbackTimeRef.current || 0);
    source.start(startAt);
    playbackTimeRef.current = startAt + audioBuffer.duration;
    playbackSourcesRef.current.add(source);
    source.onended = () => playbackSourcesRef.current.delete(source);
  }, []);

  const cleanupAudio = useCallback(async () => {
    try { if (processorRef.current) processorRef.current.onaudioprocess = null; } catch {}
    try { processorRef.current?.disconnect(); } catch {}
    try { inputSourceRef.current?.disconnect(); } catch {}
    try { silentGainRef.current?.disconnect(); } catch {}
    try { await inputContextRef.current?.close(); } catch {}
    micStreamRef.current?.getTracks().forEach(track => track.stop());
    processorRef.current = null;
    inputSourceRef.current = null;
    silentGainRef.current = null;
    inputContextRef.current = null;
    micStreamRef.current = null;
    stopPlayback();
    try { await outputContextRef.current?.close(); } catch {}
    outputContextRef.current = null;
    playbackTimeRef.current = 0;
  }, [stopPlayback]);

  const startMicrophone = useCallback(async socket => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    micStreamRef.current = stream;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    inputContextRef.current = context;
    if (context.state === 'suspended') await context.resume();
    const inputSource = context.createMediaStreamSource(stream);
    inputSourceRef.current = inputSource;
    const processor = context.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    silentGainRef.current = silentGain;

    processor.onaudioprocess = event => {
      if (socket.readyState !== WebSocket.OPEN || socketRef.current !== socket) return;
      const input = event.inputBuffer.getChannelData(0);
      const ratio = (context.sampleRate || 48000) / 16000;
      const outputLength = Math.max(1, Math.floor(input.length / ratio));
      const buffer = new ArrayBuffer(outputLength * 2);
      const view = new DataView(buffer);
      for (let index = 0; index < outputLength; index += 1) {
        const startIndex = Math.floor(index * ratio);
        const endIndex = Math.min(input.length, Math.max(startIndex + 1, Math.floor((index + 1) * ratio)));
        let total = 0;
        for (let sample = startIndex; sample < endIndex; sample += 1) total += input[sample];
        const normalized = Math.max(-1, Math.min(1, total / Math.max(1, endIndex - startIndex)));
        view.setInt16(index * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true);
      }
      socket.send(JSON.stringify({
        realtimeInput: { audio: { data: bytesToBase64(buffer), mimeType: 'audio/pcm;rate=16000' } },
      }));
    };
    inputSource.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    setStatus('listening');
  }, []);

  const runTool = useCallback(async call => {
    const args = call?.args || {};
    if (call?.name === 'get_weather') {
      let requestBody = { location: String(args.location || state.profile.homeLocation || 'Mortsel') };
      if (requestBody.location === '__device__') {
        const position = await devicePosition();
        requestBody = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      }
      const response = await fetch('/api/weather', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Weather HTTP ${response.status}`);
      return data;
    }
    if (call?.name === 'web_search') {
      if (!tavilyKey.trim()) throw new Error('Geen gratis Tavily-key ingesteld. Open Instellingen → Live web search.');
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tavily-key': tavilyKey.trim() },
        body: JSON.stringify({ query: String(args.query || '') }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Search HTTP ${response.status}`);
      return data;
    }
    if (call?.name === 'search_history') {
      return { matches: relevantHistory(state, String(args.query || ''), 8).map(item => ({ role: item.role, text: item.text, createdAt: item.createdAt })) };
    }

    let action = null;
    if (call?.name === 'save_memory' && args.text) action = { type: 'save_memory', text: String(args.text), category: String(args.category || 'general') };
    if (call?.name === 'add_task' && args.title) action = { type: 'add_task', title: String(args.title), due: args.due ? String(args.due) : '' };
    if (call?.name === 'add_event' && args.title && args.when) action = { type: 'add_event', title: String(args.title), when: String(args.when) };
    if (call?.name === 'save_note' && args.text) action = { type: 'save_note', text: String(args.text) };
    if (!action) return { ok: false, error: 'Onbekende of ongeldige actie.' };
    applyActions([action]);
    return { ok: true, saved_on_device: true };
  }, [applyActions, state, tavilyKey]);

  const start = useCallback(async () => {
    const key = geminiKey.trim();
    if (!key) {
      openSettings();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext)) {
      setError('Deze browser ondersteunt geen live microfoongesprek. Open JARVIS in Safari of Chrome.');
      setIsOpen(true);
      setStatus('error');
      return;
    }

    setIsOpen(true);
    setStatus('connecting');
    setError('');
    setTranscript([]);
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      outputContextRef.current = new AudioContextClass();
      await outputContextRef.current.resume();

      const tokenResponse = await fetch('/api/realtime/token', {
        method: 'POST',
        headers: { 'x-gemini-key': key },
      });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenData.error || `Token HTTP ${tokenResponse.status}`);

      const socketUrl = `${tokenData.url}?access_token=${encodeURIComponent(tokenData.token)}`;
      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        setStatus('connected');
        const memories = (state.memories || []).slice(-30).map(item => `- ${item.text}`).join('\n');
        socket.send(JSON.stringify({
          setup: {
            model: `models/${tokenData.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Gacrux' } } },
            },
            systemInstruction: {
              parts: [{
                text: `You are JARVIS, a private personal AI assistant. Speak Dutch by default. Be calm, natural, sharp, warm and concise. Use a mature cinematic manner without imitating Paul Bettany or any real person. You can explain, plan, research and use the supplied tools. For every weather question call get_weather. For facts that may have changed call web_search. Only claim a local action succeeded after calling its tool. User name: ${state.profile.name || '(not set)'}. Device time: ${new Date().toISOString()}. Durable local memory:\n${memories || '(none)'}`,
              }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: liveTools,
          },
        }));
      };

      socket.onmessage = async event => {
        try {
          const raw = typeof event.data === 'string' ? event.data : await event.data.text();
          const message = JSON.parse(raw);
          if (message.setupComplete) {
            await startMicrophone(socket);
            return;
          }
          const serverContent = message.serverContent;
          if (serverContent?.interrupted) stopPlayback();
          if (serverContent?.inputTranscription?.text) appendTranscript('user', serverContent.inputTranscription.text);
          if (serverContent?.outputTranscription?.text) appendTranscript('assistant', serverContent.outputTranscription.text);
          for (const part of serverContent?.modelTurn?.parts || []) {
            const inline = part.inlineData || part.inline_data;
            if (inline?.data) await playPcm(inline.data);
          }
          for (const call of message.toolCall?.functionCalls || []) {
            let responsePayload;
            try {
              responsePayload = await runTool(call);
            } catch (toolError) {
              responsePayload = { ok: false, error: String(toolError?.message || toolError) };
            }
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                toolResponse: {
                  functionResponses: [{ id: call.id, name: call.name, response: responsePayload }],
                },
              }));
            }
          }
          if (message.goAway?.timeLeft) setError(`De Live-sessie eindigt over ${message.goAway.timeLeft}; start daarna opnieuw.`);
        } catch (messageError) {
          setError(`Live-bericht kon niet worden verwerkt: ${messageError?.message || messageError}`);
        }
      };

      socket.onerror = () => {
        if (socketRef.current === socket) setError('De beveiligde Live-verbinding kon niet stabiel worden geopend.');
      };

      socket.onclose = async event => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setStatus('closed');
        const reason = event.reason ? ` — ${event.reason}` : '';
        setError(`Live werd gesloten (code ${event.code}${reason}).`);
        await cleanupAudio();
      };
    } catch (startError) {
      setStatus('error');
      setError(startError?.message || 'JARVIS Live kon niet starten.');
      socketRef.current = null;
      await cleanupAudio();
    }
  }, [appendTranscript, cleanupAudio, geminiKey, openSettings, playPcm, runTool, startMicrophone, state, stopPlayback]);

  const stop = useCallback(async () => {
    const archived = transcriptRef.current;
    const socket = socketRef.current;
    socketRef.current = null;
    try { socket?.close(1000, 'User ended session'); } catch {}
    await cleanupAudio();
    if (archived.length) archiveVoice(archived);
    setStatus('idle');
    setIsOpen(false);
    setError('');
    setTranscript([]);
  }, [archiveVoice, cleanupAudio]);

  useEffect(() => () => {
    const socket = socketRef.current;
    socketRef.current = null;
    try { socket?.close(1000, 'Component unmounted'); } catch {}
    void cleanupAudio();
  }, [cleanupAudio]);

  return { isOpen, status, error, transcript, start, stop };
}
