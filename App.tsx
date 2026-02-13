
import React, { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AUDIO_CONFIG } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audio-processing';

const FRAME_RATE = 2; 
const JPEG_QUALITY = 0.4;

const App: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<string>('Ready');
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

  // Stop the session and clean up all media and audio resources
  const stopSession = useCallback(() => {
    setIsActive(false);
    setStatus('Ready');
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

  // Initialize and start the tutor session with screen share and mic
  const startTutor = async () => {
    // API key must be accessed directly from process.env.API_KEY
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      setError("API Key not found. Please ensure process.env.API_KEY is configured.");
      return;
    }

    try {
      setError(null);
      const nav = navigator as any;
      const getDisplayMedia = (nav.mediaDevices?.getDisplayMedia?.bind(nav.mediaDevices)) || (nav.getDisplayMedia?.bind(nav));

      if (!getDisplayMedia) {
        throw new Error("Screen sharing is not supported in this browser or context.");
      }

      setStatus('Accessing Screen...');
      const screenStream = await getDisplayMedia({ video: true, audio: false });

      setStatus('Accessing Mic...');
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

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

      // Create a fresh instance for the connection
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setStatus('Connecting to Gemini...');
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: 'You are a helpful tutor who can see the user screen. Talk to them naturally.',
        },
        callbacks: {
          onopen: () => {
            setStatus('Connected');
            setIsActive(true);
            
            // Handle microphone input streaming
            const source = inputCtx.createMediaStreamSource(micStream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              // Use sessionPromise to prevent race conditions
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);

            // Handle video frame streaming from screen share
            frameIntervalRef.current = window.setInterval(() => {
              if (videoEl && canvasEl && ctx) {
                canvasEl.width = videoEl.videoWidth;
                canvasEl.height = videoEl.videoHeight;
                ctx.drawImage(videoEl, 0, 0, videoEl.videoWidth, videoEl.videoHeight);
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
            // Process audio data from Gemini
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

            // Handle model interruptions
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
            setError('A connection error occurred with the Gemini API.');
            stopSession();
          },
          onclose: () => {
            console.log('Gemini Live API Connection closed');
            stopSession();
          },
        },
      });
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to start the tutor session.');
      stopSession();
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Gemini Live Tutor</h1>
      <div style={{ marginBottom: '20px', padding: '10px', borderRadius: '4px', background: isActive ? '#e6fffa' : '#f7fafc', border: '1px solid #cbd5e0' }}>
        Status: <strong>{status}</strong>
      </div>
      
      {error && (
        <div style={{ color: '#c53030', backgroundColor: '#fff5f5', padding: '15px', borderRadius: '4px', marginBottom: '20px', border: '1px solid #feb2b2' }}>
          {error}
        </div>
      )}
      
      {!isActive ? (
        <button 
          onClick={startTutor} 
          style={{ 
            padding: '12px 24px', 
            fontSize: '18px', 
            cursor: 'pointer', 
            backgroundColor: '#3182ce', 
            color: 'white', 
            border: 'none', 
            borderRadius: '6px',
            fontWeight: 'bold'
          }}
        >
          Start Tutor Session
        </button>
      ) : (
        <button 
          onClick={stopSession} 
          style={{ 
            padding: '12px 24px', 
            fontSize: '18px', 
            cursor: 'pointer', 
            backgroundColor: '#e53e3e', 
            color: 'white', 
            border: 'none', 
            borderRadius: '6px',
            fontWeight: 'bold'
          }}
        >
          Stop Session
        </button>
      )}

      <div style={{ marginTop: '40px', borderTop: '1px solid #eee', paddingTop: '20px' }}>
        <h3>Instructions:</h3>
        <ol style={{ lineHeight: '1.6' }}>
          <li>Click "Start Tutor Session".</li>
          <li>Choose a screen, window, or tab to share.</li>
          <li>Allow microphone access when prompted.</li>
          <li>Talk to Gemini! It can see your shared screen and assist you in real-time.</li>
        </ol>
      </div>
    </div>
  );
};

// Exporting as default to fix module import error in index.tsx
export default App;
