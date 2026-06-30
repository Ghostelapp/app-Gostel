import { Platform } from 'react-native';

export const VOICE_MAX_DURATION_MS = 60_000;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;

export interface VoiceRecorder {
  start(): Promise<void>;
  stop(): Promise<VoiceCaptureResult | null>;
  cancel(): Promise<void>;
}

export type VoiceCaptureResult = {
  filename: string;
  mime: string;
  data: string;
  size: number;
  durationMs: number;
};

// Web implementation using MediaRecorder
class WebVoiceRecorder implements VoiceRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private mime = 'audio/webm';

  async start() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API not available in this browser');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not supported in this browser');
    }
    this.chunks = [];
    this.startedAt = Date.now();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ];
    const supported = candidates.find((m) =>
      (MediaRecorder as any).isTypeSupported?.(m)
    );
    this.mime = supported || 'audio/webm';
    this.recorder = supported
      ? new MediaRecorder(this.stream, { mimeType: supported })
      : new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  stop(): Promise<VoiceCaptureResult | null> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) return resolve(null);
      const durationMs = Date.now() - this.startedAt;
      this.recorder.onstop = async () => {
        try {
          const blob = new Blob(this.chunks, { type: this.mime });
          const reader = new FileReader();
          reader.onloadend = async () => {
            const result = reader.result as string;
            const idx = result.indexOf(',');
            const b64 = idx >= 0 ? result.slice(idx + 1) : result;
            const ext = this.mime.includes('mp4') ? 'm4a' : this.mime.includes('ogg') ? 'ogg' : 'webm';
            const filename = `voice-${Date.now()}.${ext}`;
            try {
              const size = Math.ceil((b64.length * 3) / 4);
              if (durationMs > VOICE_MAX_DURATION_MS) {
                throw new Error('Voice message is too long. Maximum length is 60 seconds.');
              }
              if (size > VOICE_MAX_BYTES) {
                throw new Error('Voice message is too large. Record a shorter message.');
              }
              this.cleanup();
              resolve({ filename, mime: this.mime, data: b64, size, durationMs });
            } catch (e) {
              reject(e);
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        } catch (e) {
          reject(e);
        }
      };
      this.recorder.stop();
    });
  }

  async cancel() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null as any;
      this.recorder.stop();
    }
    this.cleanup();
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.recorder = undefined;
    this.chunks = [];
  }
}

// Native implementation using expo-audio (SDK 54+)
class NativeVoiceRecorder implements VoiceRecorder {
  private recorder: any = null;
  private startedAt = 0;

  async start() {
    let ExpoAudio: any;
    try {
      ExpoAudio = require('expo-audio');
    } catch (e) {
      throw new Error('expo-audio is not installed in this build');
    }
    const {
      AudioModule,
      RecordingPresets,
      setAudioModeAsync,
      requestRecordingPermissionsAsync,
    } = ExpoAudio;
    if (!AudioModule || !AudioModule.AudioRecorder) {
      throw new Error('expo-audio AudioRecorder native module unavailable');
    }
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        throw new Error('Microphone permission denied. Enable it in system settings.');
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      const rec = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await rec.prepareToRecordAsync();
      rec.record();
      this.recorder = rec;
      this.startedAt = Date.now();
    } catch (e: any) {
      throw new Error(`Cannot start recording: ${e?.message || e}`);
    }
  }

  async stop(): Promise<VoiceCaptureResult | null> {
    if (!this.recorder) return null;
    const durationMs = Date.now() - this.startedAt;
    let uri: string | null = null;
    try {
      await this.recorder.stop();
      uri = this.recorder.uri || null;
    } catch (e: any) {
      throw new Error(`Stop failed: ${e?.message || e}`);
    }
    this.recorder = null;
    if (!uri) return null;
    let FileSystem: any;
    try {
      FileSystem = require('expo-file-system/legacy');
    } catch {
      try {
        FileSystem = require('expo-file-system');
      } catch {
        throw new Error('expo-file-system not available');
      }
    }
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      const filename = `voice-${Date.now()}.m4a`;
      const size = Math.ceil((b64.length * 3) / 4);
      if (durationMs > VOICE_MAX_DURATION_MS) {
        throw new Error('Voice message is too long. Maximum length is 60 seconds.');
      }
      if (size > VOICE_MAX_BYTES) {
        throw new Error('Voice message is too large. Record a shorter message.');
      }
      return { filename, mime: 'audio/m4a', data: b64, size, durationMs };
    } finally {
      await FileSystem.deleteAsync?.(uri, { idempotent: true }).catch?.(() => {});
    }
  }

  async cancel() {
    const recorder = this.recorder;
    let uri = recorder?.uri || null;
    try {
      if (recorder) {
        await recorder.stop();
        uri = recorder.uri || uri;
      }
    } catch {
      /* ignore */
    }
    this.recorder = null;
    if (uri) {
      try {
        let FileSystem: any;
        try {
          FileSystem = require('expo-file-system/legacy');
        } catch {
          FileSystem = require('expo-file-system');
        }
        await FileSystem.deleteAsync?.(uri, { idempotent: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export function createVoiceRecorder(): VoiceRecorder {
  return Platform.OS === 'web' ? new WebVoiceRecorder() : new NativeVoiceRecorder();
}

export function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
