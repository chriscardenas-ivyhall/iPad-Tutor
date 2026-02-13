
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AUDIO_CONFIG } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audio-processing';

const FRAME_RATE = 2; 
const JPEG_QUALITY = 0.4;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<string>('Ready');
  const [error, setError] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const audioContextRef = useRef<{
    input: AudioContext;
    output: AudioContext;
  } | null>(null);
  const streamsRef = useRef<{
    mic: MediaStream | null;
    screen: MediaStream | null;
  }>({ mic: null, screen: null });
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);

  const stopSession = useCallback(() => {
    setIsActive(false);
    setStatus('Ready');
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (streamsRef.current.mic) streamsRef.current.mic.getTracks().forEach(t => t.stop());
    if (streamsRef.current.screen) streamsRef.current.screen.getTracks().forEach(t => t.stop());
    if (audioContextRef.current) {
      audioContextRef.current.input.close().catch(() => {});
      audioContextRef.current.output.close().catch(() => {});
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const startTutor = async () => {
    try {
      setError(null);
      const nav = navigator as any;
      const getDisplayMedia = (nav.mediaDevices?.getDisplayMedia?.bind(nav.mediaDevices)) || (nav.getDisplayMedia?.bind(nav));

      if (!getDisplayMedia) {
        throw new Error("Screen Sharing API missing. Ensure you are in Desktop Mode (Tap 'AA' in Safari) and NOT inside an iframe.");
      }

      setStatus('Starting Screen...');
      // IMPORTANT: Must be called directly in the click handler for iPad Safari
      const screenStream = await getDisplayMedia({ 
        video: { frameRate: 15, width: { ideal: 1280 } }, 
        audio: false 
      });

      setStatus('Starting Mic...');
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      streamsRef.current = { mic: micStream, screen: screenStream };
      screenStream.getVideoTracks()[0].onended = () => stopSession();

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtx({ sampleRate: AUDIO_CONFIG.SAMPLE_RATE });
      const outputCtx = new AudioCtx({ sampleRate: AUDIO_CONFIG.OUTPUT_SAMPLE_RATE });
      audioContextRef.current = { input: inputCtx, output: outputCtx };
      
      const videoEl = document.createElement('video');
      videoEl.srcObject = screenStream;
      videoEl.muted = true;
      videoEl.setAttribute('playsinline', 'true');
      await videoEl.play();
      
      const canvasEl = document.createElement('canvas');
      const ctx = canvasEl.getContext('2d', { alpha: false });

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setStatus('AI Connecting...');
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: 'You are a helpful iPad tutor. You see the users screen in real-time. Keep responses very short, conversational, and helpful.',
        },
        callbacks: {
          onopen: () => {
            setStatus('Active');
            setIsActive(true);
            const source = inputCtx.createMediaStreamSource(micStream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (!isActive) return;
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(e.inputBuffer.getChannelData(0)) }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            frameIntervalRef.current = window.setInterval(() => {
              if (!videoEl.videoWidth || !ctx) return;
              const scale = Math.min(1, 1024 / Math.max(videoEl.videoWidth, videoEl.videoHeight));
              canvasEl.width = videoEl.videoWidth * scale;
              canvasEl.height = videoEl.videoHeight * scale;
              ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
              const base64Data = canvasEl.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64Data, mimeType: 'image/jpeg' } }));
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (m: LiveServerMessage) => {
            const data = m.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (data && audioContextRef.current) {
              const { output } = audioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, output.currentTime);
              const buffer = await decodeAudioData(decode(data), output, AUDIO_CONFIG.OUTPUT_SAMPLE_RATE, 1);
              const source = output.createBufferSource();
              source.buffer = buffer;
              source.connect(output.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
            }
          },
          onerror: (e) => { console.error(e); stopSession(); },
          onclose: () => stopSession()
        }
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to start. Check Safari settings.');
      stopSession();
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center font-sans p-6 overflow-hidden">
      <div className="w-full max-w-md space-y-12">
        
        <header className="text-center space-y-2">
            <h1 className="text-4xl font-black tracking-tighter text-white uppercase italic">iPad Tutor</h1>
            <p className="text-slate-500 text-xs font-bold tracking-[0.3em] uppercase">Gemini Live API</p>
        </header>

        <div className="relative group">
            <div className={`absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-full blur opacity-25 group-hover:opacity-50 transition duration-1000 ${isActive ? 'animate-pulse' : ''}`}></div>
            <button
                onClick={isActive ? stopSession : startTutor}
                className={`relative w-full aspect-square rounded-full flex flex-col items-center justify-center transition-all active:scale-95 border-4 shadow-2xl
                    ${isActive 
                        ? 'bg-rose-600 border-rose-400 shadow-rose-500/50' 
                        : 'bg-indigo-600 border-indigo-400 shadow-indigo-500/50'}`}
            >
                <span className="text-5xl font-black tracking-tighter text-white">
                    {isActive ? 'STOP' : 'START'}
                </span>
                <span className="mt-2 text-[10px] font-black tracking-[0.4em] uppercase opacity-70">
                    {status}
                </span>
            </button>
        </div>

        {error && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-2xl animate-bounce">
            <p className="text-rose-400 font-bold text-xs text-center">{error}</p>
          </div>
        )}

        <div className="flex justify-center pt-8">
            <button 
                onClick={() => setShowGuide(!showGuide)}
                className="text-[10px] font-black text-slate-500 uppercase tracking-widest hover:text-indigo-400 transition-colors underline decoration-slate-800"
            >
                Deployment Guide & Help
            </button>
        </div>

        {showGuide && (
            <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-xl p-8 overflow-y-auto animate-in slide-in-from-bottom duration-500">
                <div className="max-w-xl mx-auto space-y-8">
                    <div className="flex justify-between items-center">
                        <h2 className="text-2xl font-black italic tracking-tighter">FIXING SAFARI ERRORS</h2>
                        <button onClick={() => setShowGuide(false)} className="p-2 text-slate-400 font-bold text-xl">✕</button>
                    </div>

                    <section className="space-y-4">
                        <h3 className="text-indigo-400 font-black text-sm tracking-widest uppercase">The "WebKitBlob" Error</h3>
                        <p className="text-slate-400 text-sm leading-relaxed">
                            If you see a "Safari can't open page" error, it's because you are trying to run the app inside a frame. 
                            <strong> To fix this permanently:</strong>
                        </p>
                        <ol className="list-decimal list-inside space-y-3 text-slate-300 text-sm">
                            <li className="pl-2">Create a new <strong>GitHub Repository</strong>.</li>
                            <li className="pl-2">Upload these files (index.html, index.tsx, App.tsx, etc).</li>
                            <li className="pl-2">Go to <strong>Settings > Pages</strong> and enable deployment.</li>
                            <li className="pl-2">Visit your unique <strong>.github.io</strong> URL in Safari.</li>
                        </ol>
                    </section>

                    <section className="space-y-4 p-6 bg-slate-900 rounded-3xl border border-slate-800">
                        <h3 className="text-white font-black text-xs tracking-widest uppercase">iPad Critical Settings</h3>
                        <ul className="space-y-3 text-xs text-slate-400">
                            <li>• <strong>Desktop Mode:</strong> Tap "AA" in the Safari address bar and ensure you are NOT on the mobile site.</li>
                            <li>• <strong>Permissions:</strong> Settings > Safari > Advanced > Feature Flags > <strong>Screen Capture</strong> = ON.</li>
                            <li>• <strong>Secure Context:</strong> Screen sharing ONLY works on HTTPS (which GitHub Pages provides for free).</li>
                        </ul>
                    </section>
                </div>
            </div>
        )}

      </div>

      <footer className="mt-auto py-12 opacity-20 text-[8px] font-black tracking-[1.5em] uppercase text-center w-full">
        v2.5 Full Screen Capture
      </footer>
    </div>
  );
};

export default App;
