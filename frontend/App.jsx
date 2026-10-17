import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';
const SEND_INTERVAL_MS = 80;     // ~12 frames/sec sent to the backend
const INFLIGHT_TIMEOUT_MS = 1500; // give up waiting for a reply after this
const RECONNECT_MS = 2000;
const MAX_HISTORY = 6;
const HEALTH_URL = WS_URL.replace(/^ws/, 'http').replace(/\/ws$/, '/health');
const QUICK_PHRASES = [
  'Please help me.',
  'I would like some water, please.',
  'Thank you very much.',
  'I do not understand.',
];
const pretty = (t) => (t || '').replace(/_/g, ' ');
const FUNCTIONAL = ['SPACE', 'BACKSPACE', 'CLEAR'];

// Speak text with the browser's built-in voice. Cancels anything still playing
// so sentences never pile up.
function speak(text) {
  if (!text || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

export default function App() {
  const [sign, setSign] = useState('-');
  const [confirmedSign, setConfirmedSign] = useState('-');
  const [displayBuffer, setDisplayBuffer] = useState('');
  const [lastSentence, setLastSentence] = useState('');
  const [history, setHistory] = useState([]);
  const [fps, setFps] = useState(0);
  const [latency, setLatency] = useState(0);
  const [connected, setConnected] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [soundOn, setSoundOn] = useState(true);
  const [vocab, setVocab] = useState([]);
  const [showVocab, setShowVocab] = useState(false);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const inflightSince = useRef(0); // 0 = nothing waiting for a reply
  const soundRef = useRef(true);

  useEffect(() => {
    soundRef.current = soundOn;
    if (!soundOn && window.speechSynthesis) window.speechSynthesis.cancel();
  }, [soundOn]);

  // 1. Camera
  useEffect(() => {
    let stream;
    let cancelled = false;
    async function initCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        console.error('Camera access error:', err);
        setCameraError(
          'Camera blocked or not found. Allow camera access in your browser, then reload.'
        );
      }
    }
    initCamera();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // 2. WebSocket with automatic reconnect
  useEffect(() => {
    let closed = false;
    let retryTimer;

    function handleMessage(event) {
      inflightSince.current = 0;
      try {
        const data = JSON.parse(event.data);
        setSign(data.raw_sign || '-');
        if (data.confirmed_sign && data.confirmed_sign !== '-') {
          setConfirmedSign(data.confirmed_sign);
        }
        setDisplayBuffer(data.display_buffer ?? '');
        if (data.fps) setFps(data.fps);
        if (data.latency_ms) setLatency(data.latency_ms);

        if (data.spoken_sentence) {
          setLastSentence(data.spoken_sentence);
          setHistory((h) => [data.spoken_sentence, ...h].slice(0, MAX_HISTORY));
          if (soundRef.current) speak(data.spoken_sentence);
        }
      } catch (e) {
        console.error('Payload parse error:', e);
      }
    }

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        inflightSince.current = 0;
        setConnected(true);
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        setConnected(false);
        inflightSince.current = 0;
        if (!closed) retryTimer = setTimeout(connect, RECONNECT_MS);
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Load the list of supported signs from the backend
  useEffect(() => {
    if (!connected || vocab.length) return;
    fetch(HEALTH_URL)
      .then((r) => r.json())
      .then((d) => setVocab((d.supported_classes || []).filter((c) => !FUNCTIONAL.includes(c))))
      .catch(() => {});
  }, [connected, vocab.length]);

  // 3. Send camera frames to the backend (one at a time, so a slow backend never gets flooded)
  useEffect(() => {
    const timer = setInterval(() => {
      const ws = wsRef.current;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!video || video.readyState < 2 || !canvas) return;

      const now = Date.now();
      if (inflightSince.current && now - inflightSince.current < INFLIGHT_TIMEOUT_MS) return;

      canvas.width = 320;
      canvas.height = 240;
      canvas.getContext('2d').drawImage(video, 0, 0, 320, 240);
      inflightSince.current = now;
      canvas.toBlob(
        (blob) => {
          if (blob && ws.readyState === WebSocket.OPEN) ws.send(blob);
          else inflightSince.current = 0;
        },
        'image/jpeg',
        0.7
      );
    }, SEND_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const speakCurrent = useCallback(() => {
    speak(displayBuffer || lastSentence);
  }, [displayBuffer, lastSentence]);

  // Clears the screen AND the backend's buffer, so old words don't come back.
  const clearAll = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'clear' }));
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setDisplayBuffer('');
    setLastSentence('');
    setHistory([]);
    setConfirmedSign('-');
  }, []);

  const hasText = Boolean(displayBuffer || lastSentence);
  const tokens = displayBuffer ? displayBuffer.split(' ').filter(Boolean) : [];
  const handSeen = sign !== '-';
  const letters = vocab.filter((c) => c.length === 1);
  const words = vocab.filter((c) => c.length > 1);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 13V5a1.5 1.5 0 0 1 3 0v6m0-1V3.5a1.5 1.5 0 0 1 3 0V10m0-.5a1.5 1.5 0 0 1 3 0V14m0-2.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L4 15.5a1.6 1.6 0 0 1 2.4-2L8 15" />
            </svg>
          </span>
          <div>
            <h1>Signspeak</h1>
            <p className="sub">Sign in front of the camera. Pause, and it speaks for you.</p>
          </div>
        </div>
        <div className="status" role="status" aria-live="polite">
          <span className={`pill ${connected ? 'on' : 'off'}`}>
            <i className="dot" />
            {connected ? 'Connected' : 'Reconnecting…'}
          </span>
          <span className="metrics">{fps} FPS · {latency} ms</span>
        </div>
      </header>

      <main className="layout">
        <section className="camera" aria-label="Camera">
          <div className={`frame ${handSeen ? 'seen' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted />
            {cameraError && <p className="cam-error">{cameraError}</p>}
            <div className="chip live">
              <i className={`dot ${handSeen ? 'on' : ''}`} />
              {handSeen ? pretty(sign) : 'Show your hand'}
            </div>
            {confirmedSign !== '-' && (
              <div className="chip confirmed">Locked in: {pretty(confirmedSign)}</div>
            )}
          </div>
          <canvas ref={canvasRef} hidden />

          <div className="quick">
            <span className="quick-label">Quick phrases</span>
            <div className="quick-row">
              {QUICK_PHRASES.map((p) => (
                <button key={p} className="soft" onClick={() => speak(p)}>{p}</button>
              ))}
            </div>
          </div>
        </section>

        <section className="output" aria-label="Translation">
          <div className="stage">
            <h2>Signing now</h2>
            <div className="tokens" aria-live="polite">
              {tokens.length ? (
                tokens.map((t, i) => (
                  <span key={i} className={`token ${t.length === 1 ? 'letter' : 'word'}`}>{pretty(t)}</span>
                ))
              ) : (
                <span className="hint">Letters and words appear here as you sign</span>
              )}
            </div>

            <h2>Sentence</h2>
            <p className="sentence" aria-live="polite">
              {lastSentence || <span className="hint">Your sentence appears here after a short pause</span>}
            </p>

            <div className="actions">
              <button className="primary" onClick={speakCurrent} disabled={!hasText}>Speak</button>
              <button className="soft" onClick={() => setSoundOn((v) => !v)} aria-pressed={soundOn}>
                Voice {soundOn ? 'on' : 'off'}
              </button>
              <button className="ghost" onClick={clearAll}>Clear</button>
            </div>
          </div>

          {history.length > 1 && (
            <div className="panel">
              <h2>Earlier</h2>
              <ul className="history">
                {history.slice(1).map((h, i) => (
                  <li key={i}><button className="line" onClick={() => speak(h)}>{h}</button></li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel">
            <button className="reveal" onClick={() => setShowVocab((v) => !v)} aria-expanded={showVocab}>
              <span>Signs I understand{vocab.length ? ` (${vocab.length})` : ''}</span>
              <span className="chev">{showVocab ? '–' : '+'}</span>
            </button>
            {showVocab && (
              <div className="vocab">
                {vocab.length === 0 && <p className="hint">Connect to the backend to see the list.</p>}
                {words.length > 0 && <div className="vgroup">{words.map((w) => <span key={w} className="vchip">{pretty(w)}</span>)}</div>}
                {letters.length > 0 && <div className="vgroup letters">{letters.map((l) => <span key={l} className="vchip">{l}</span>)}</div>}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
