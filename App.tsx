import React, { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AUDIO_CONFIG } from './types.ts';
import { decode, decodeAudioData, createBlob } from './utils/audio-processing.ts';

const FRAME_RATE = 2; 
const JPEG_QUALITY = 0.4;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<string>('System Idle');
  const [error, setError] = useState<string | null>(null);

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
    setStatus('System Idle');
    if (frameIntervalRef.current) {
      window.clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (streamsRef.current.mic) {
      streamsRef.current.mic.getTracks().forEach(t => t.stop());
      streamsRef.current.mic = null;
    }
    if (streamsRef.current.screen) {
      streamsRef.current.screen.getTracks().forEach(t => t.stop());
      streamsRef.current.screen = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.input.close().catch(() => {});
      audioContextRef.current.output.close().catch(() => {});
      audioContextRef.current = null;
    }
    sourcesRef.current.forEach(s => { 
      try { s.stop(); } catch (e) {} 
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const startTutor = async () => {
    const apiKey = (window as any).process?.env?.API_KEY || process.env.API_KEY;
    
    if (!apiKey) {
      setError("Critical Error: API Key is missing. Check environment configuration.");
      return;
    }

    try {
      setError(null);
      setStatus('Initializing Media...');
      
      const nav = navigator as any;
      const getDisplayMedia = (nav.mediaDevices?.getDisplayMedia?.bind(nav.mediaDevices)) || (nav.getDisplayMedia?.bind(nav));

      if (!getDisplayMedia) {
        throw new Error("Screen sharing is not supported on this device/browser.");
      }

      const screenStream = await getDisplayMedia({ 
        video: { cursor: "always" }, 
        audio: false 
      });

      const micStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });

      streamsRef.current = { mic: micStream, screen: screenStream };
      screenStream.getVideoTracks()[0].onended = () => stopSession();

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtx({ sampleRate: AUDIO_CONFIG.SAMPLE_RATE });
      const outputCtx = new AudioCtx({ sampleRate: AUDIO_CONFIG.OUTPUT_SAMPLE_RATE });
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);
      audioContextRef.current = { input: inputCtx, output: outputCtx };
      
      const videoEl = document.createElement('video');
      videoEl.srcObject = screenStream;
      videoEl.muted = true;
      videoEl.setAttribute('playsinline', 'true');
      await videoEl.play();
      
      const canvasEl = document.createElement('canvas');
      const ctx = canvasEl.getContext('2d', { alpha: false });

      const ai = new GoogleGenAI({ apiKey });
      setStatus('Establishing Neural Link...');
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: 'You are a brilliant, empathetic iPad tutor. You see the user\'s screen. Help them with whatever task they are doing by observing their screen and speaking to them. Keep responses concise and helpful.',
        },
        callbacks: {
          onopen: () => {
            setStatus('Neural Link Active');
            setIsActive(true);
            
            const source = inputCtx.createMediaStreamSource(micStream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            frameIntervalRef.current = window.setInterval(() => {
              if (videoEl && canvasEl && ctx) {
                const scale = 0.5; // Scale down to save bandwidth
                canvasEl.width = videoEl.videoWidth * scale;
                canvasEl.height = videoEl.videoHeight * scale;
                ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
                canvasEl.toBlob(
                  async (blob) => {
                    if (blob) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        const base64Data = (reader.result as string)?.split(',')[1];
                        if (base64Data) {
                          sessionPromise.then((session) => {
                            session.sendRealtimeInput({
                              media: { data: base64Data, mimeType: 'image/jpeg' }
                            });
                          });
                        }
                      };
                      reader.readAsDataURL(blob);
                    }
                  },
                  'image/jpeg',
                  JPEG_QUALITY
                );
              }
            }, 1000 / FRAME_RATE);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64EncodedAudioString =
              message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64EncodedAudioString) {
              nextStartTimeRef.current = Math.max(
                nextStartTimeRef.current,
                outputCtx.currentTime,
              );
              const audioBuffer = await decodeAudioData(
                decode(base64EncodedAudioString),
                outputCtx,
                AUDIO_CONFIG.OUTPUT_SAMPLE_RATE,
                1,
              );
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputNode);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current = nextStartTimeRef.current + audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of sourcesRef.current.values()) {
                try { source.stop(); } catch (e) {}
              }
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => {
            console.error('Gemini Live API Error:', e);
            setError('The neural link was severed. Please try again.');
            stopSession();
          },
          onclose: () => {
            stopSession();
          },
        },
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Connection failed.');
      stopSession();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center bg-slate-950">
      <div className="w-full max-w-lg space-y-12">
        <header className="space-y-4">
          <div className="inline-block px-4 py-1.5 mb-2 text-[10px] font-black tracking-[0.3em] uppercase bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-full">
            Gemini 2.5 Live
          </div>
          <h1 className="text-5xl font-black italic tracking-tighter text-white uppercase sm:text-7xl">
            iPad <span className="text-indigo-500">Tutor</span>
          </h1>
          <p className="text-lg font-medium text-slate-400">
            {isActive 
              ? "Tutor is currently viewing your screen and listening." 
              : "Experience real-time visual assistance with Gemini."}
          </p>
        </header>

        <div className="relative group">
          {/* Dynamic Glow Effect */}
          <div className={`absolute -inset-4 rounded-full blur-2xl transition-all duration-1000 opacity-20 group-hover:opacity-40 
            ${isActive ? 'bg-rose-500 animate-pulse' : 'bg-indigo-500'}`}></div>
          
          <button
            onClick={isActive ? stopSession : startTutor}
            className={`relative flex flex-col items-center justify-center w-64 h-64 mx-auto transition-all duration-500 rounded-full border-4 active:scale-95 shadow-2xl
              ${isActive 
                ? 'bg-rose-600 border-rose-400 shadow-rose-900/50' 
                : 'bg-indigo-600 border-indigo-400 shadow-indigo-900/50 hover:bg-indigo-500'}`}
          >
            <span className="text-4xl font-black tracking-tighter text-white uppercase italic">
              {isActive ? 'Stop' : 'Start'}
            </span>
            <span className="mt-2 text-[10px] font-bold tracking-widest uppercase opacity-70">
              {status}
            </span>
          </button>
        </div>

        {error && (
          <div className="p-4 border border-rose-500/30 bg-rose-500/10 rounded-2xl animate-in fade-in slide-in-from-bottom-4">
            <p className="text-sm font-bold text-rose-400">{error}</p>
          </div>
        )}

        <footer className="pt-12">
          <p className="text-[10px] font-bold tracking-[0.4em] uppercase text-slate-600">
            Secure Context Required &bull; Full Screen Capture
          </p>
        </footer>
      </div>
    </div>
  );
};

export default App;