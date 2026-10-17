import React, { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws';
const SEND_INTERVAL_MS = 80;     // ~12 frames/sec sent to the backend
const INFLIGHT_TIMEOUT_MS = 1500; // give up waiting for a reply after this
const RECONNECT_MS = 2000;
const MAX_HISTORY = 6;

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

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Sign Language Assistant</h1>
          <p className="sub">Fingerspell A–Z or sign everyday words. Pause to hear the sentence.</p>
        </div>
        <div className="status" role="status" aria-live="polite">
          <span className={`pill ${connected ? 'on' : 'off'}`}>
            {connected ? 'Connected' : 'Reconnecting…'}
          </span>
          <span className="metrics">{fps} FPS · {latency} ms</span>
        </div>
      </header>

      <main className="layout">
        <section className="camera" aria-label="Camera">
          <div className="frame">
            <video ref={videoRef} autoPlay playsInline muted />
            {cameraError && <p className="cam-error">{cameraError}</p>}
            <div className="live">
              <span className="live-label">Seeing</span>
              <strong>{sign === '-' ? 'No hand' : sign.replace(/_/g, ' ')}</strong>
              <span className="confirmed">Last confirmed: {confirmedSign === '-' ? 'none' : confirmedSign.replace(/_/g, ' ')}</span>
            </div>
          </div>
          <canvas ref={canvasRef} hidden />
        </section>

        <section className="output" aria-label="Translation">
          <div className="block">
            <h2>Signing now</h2>
            <p className="buffer" aria-live="polite">
              {displayBuffer || <span className="hint">Waiting for your first sign</span>}
            </p>
          </div>

          <div className="block">
            <h2>Sentence</h2>
            <p className="sentence" aria-live="polite">
              {lastSentence || <span className="hint">Your sentence appears here after a short pause</span>}
            </p>
          </div>

          <div className="actions">
            <button className="primary" onClick={speakCurrent} disabled={!hasText}>
              Speak
            </button>
            <button onClick={() => setSoundOn((s) => !s)} aria-pressed={soundOn}>
              Voice {soundOn ? 'on' : 'off'}
            </button>
            <button className="ghost" onClick={clearAll}>
              Clear
            </button>
          </div>

          {history.length > 1 && (
            <div className="block">
              <h2>Earlier</h2>
              <ul className="history">
                {history.slice(1).map((s, i) => (
                  <li key={i}>
                    <button className="line" onClick={() => speak(s)}>{s}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
