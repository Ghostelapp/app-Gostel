import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';
import { api } from './api';

/**
 * Max dimension for chat images. Anything bigger is downscaled to this on the
 * longest side using expo-image-manipulator before upload. Keeps payloads small
 * (~150-400KB JPEG instead of 5-10MB camera photos).
 */
const CHAT_IMAGE_MAX_DIM = 1280;
const CHAT_IMAGE_QUALITY = 0.65;
export const ENCRYPTED_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type UploadResult = {
  id: string;
  filename: string;
  mime: string;
  size: number;
};

export type UploadCandidate = {
  filename: string;
  mime: string;
  data: string;
  size: number;
};

export type UploadOptions = {
  kind?: 'voice' | 'image' | 'file';
  durationMs?: number;
  originalMime?: string;
};

function cleanBase64(value: string): string {
  const idx = value.indexOf(',');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function base64ToBlob(base64Data: string, mime: string): Blob {
  const b64 = cleanBase64(base64Data);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function writeEncryptedUploadTempFile(candidate: UploadCandidate): Promise<string> {
  let FileSystem: any;
  try {
    FileSystem = require('expo-file-system/legacy');
  } catch {
    FileSystem = require('expo-file-system');
  }
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) throw new Error('Upload cache is not available');
  const safeName = candidate.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const uri = `${dir}${Date.now()}-${safeName}`;
  await FileSystem.writeAsStringAsync(uri, cleanBase64(candidate.data), { encoding: 'base64' });
  return uri;
}

async function uriToBase64(uri: string): Promise<string> {
  // Web (data URI or blob URL): use fetch + FileReader
  if (Platform.OS === 'web' || uri.startsWith('blob:') || uri.startsWith('http')) {
    const res = await fetch(uri);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // Strip data:<mime>;base64,
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  // Native: use the new File API from expo-file-system (SDK 54+). Falls back
  // to the legacy `readAsStringAsync` if the new API isn't available.
  const FileSystem: any = require('expo-file-system');
  if (FileSystem?.File) {
    try {
      const file = new FileSystem.File(uri);
      // File.base64() returns a base64 string (no data: prefix).
      const b64 = await file.base64();
      if (typeof b64 === 'string' && b64.length > 0) return b64;
    } catch {
      /* fall through to legacy */
    }
  }
  try {
    const Legacy = require('expo-file-system/legacy');
    return await Legacy.readAsStringAsync(uri, { encoding: 'base64' });
  } catch {
    /* one more fallback path below */
  }
  if (FileSystem?.readAsStringAsync) {
    return await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
  }
  throw new Error('Could not read file');
}

export async function pickImageForUpload(): Promise<UploadCandidate | null> {
  if (Platform.OS !== 'android') {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.9, // keep high here — we re-encode below
    base64: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];

  // Downscale + re-encode JPEG to keep the upload reasonable.
  let finalUri = asset.uri;
  let mime = asset.mimeType || 'image/jpeg';
  let fileSize = asset.fileSize || 0;
  try {
    const w = asset.width || 0;
    const h = asset.height || 0;
    const longest = Math.max(w, h);
    if (longest > CHAT_IMAGE_MAX_DIM || longest === 0) {
      const ImageManipulator = require('expo-image-manipulator');
      const actions = [];
      if (longest > CHAT_IMAGE_MAX_DIM) {
        const ratio = CHAT_IMAGE_MAX_DIM / longest;
        actions.push({
          resize: {
            width: Math.round((w || CHAT_IMAGE_MAX_DIM) * ratio),
            height: Math.round((h || CHAT_IMAGE_MAX_DIM) * ratio),
          },
        });
      }
      const out = await ImageManipulator.manipulateAsync(asset.uri, actions, {
        compress: CHAT_IMAGE_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      finalUri = out.uri;
      mime = 'image/jpeg';
      fileSize = 0; // will recompute from base64
    }
  } catch {
    // If manipulator fails, fall back to the original asset.
  }

  const data = await uriToBase64(finalUri);
  const filename = asset.fileName || `image-${Date.now()}.jpg`;
  const size = fileSize || Math.ceil((data.length * 3) / 4);
  return { filename, mime, data, size };
}

export async function takePhotoForUpload(): Promise<UploadCandidate | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (perm.status !== 'granted') return null;
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: CHAT_IMAGE_QUALITY,
    base64: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const data = await uriToBase64(asset.uri);
  return {
    filename: asset.fileName || `camera-${Date.now()}.jpg`,
    mime: asset.mimeType || 'image/jpeg',
    data,
    size: asset.fileSize || Math.ceil((data.length * 3) / 4),
  };
}

export async function pickAndUploadImage(): Promise<UploadResult | null> {
  throw new Error('Direct uploads are disabled. Encrypt the attachment before upload.');
}

/** Pick an image and return raw base64 + mime (no upload). Used for avatars. */
export async function pickImageAsBase64(opts?: {
  aspect?: [number, number];
  allowsEditing?: boolean;
  quality?: number;
}): Promise<{ base64: string; mime: string } | null> {
  if (Platform.OS !== 'android') {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') return null;
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: opts?.quality ?? 0.5,
    base64: false,
    allowsEditing: opts?.allowsEditing ?? true,
    aspect: opts?.aspect ?? [1, 1],
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const base64 = await uriToBase64(asset.uri);
  return { base64, mime: asset.mimeType || 'image/jpeg' };
}

export async function pickDocumentForUpload(): Promise<UploadCandidate | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  const data = await uriToBase64(asset.uri);
  const size = asset.size || Math.ceil((data.length * 3) / 4);
  if (size > 8 * 1024 * 1024) {
    throw new Error('File exceeds 8 MB limit');
  }
  return {
    filename: asset.name,
    mime: asset.mimeType || 'application/octet-stream',
    data,
    size,
  };
}

export async function pickAndUploadDocument(): Promise<UploadResult | null> {
  throw new Error('Direct uploads are disabled. Encrypt the attachment before upload.');
}

export async function uploadCandidate(
  candidate: UploadCandidate,
  options: UploadOptions = {},
): Promise<UploadResult> {
  return uploadCandidateMultipart(candidate, options);
}

export async function uploadCandidateMultipart(
  candidate: UploadCandidate,
  options: UploadOptions = {},
): Promise<UploadResult> {
  if (candidate.mime !== 'application/octet-stream' || !candidate.filename.endsWith('.ghostel')) {
    throw new Error('Uploads must be encrypted before being sent.');
  }
  if (candidate.size > ENCRYPTED_ATTACHMENT_MAX_BYTES) {
    throw new Error(
      options.kind === 'voice'
        ? 'Voice message is too large. Record a shorter message.'
        : 'File exceeds 10 MB limit',
    );
  }

  const form = new FormData();
  form.append('filename', candidate.filename);
  form.append('mime', candidate.mime);
  form.append('size', String(candidate.size));
  if (options.kind) form.append('kind', options.kind);
  if (options.durationMs != null) form.append('durationMs', String(options.durationMs));
  if (options.originalMime) form.append('originalMime', options.originalMime);

  let cleanupUri: string | null = null;
  if (Platform.OS === 'web') {
    form.append('encryptedAudioFile', base64ToBlob(candidate.data, candidate.mime), candidate.filename);
  } else {
    cleanupUri = await writeEncryptedUploadTempFile(candidate);
    form.append('encryptedAudioFile', {
      uri: cleanupUri,
      name: candidate.filename,
      type: candidate.mime,
    } as any);
  }

  try {
    const { data } = await api.post('/uploads', form, { timeout: 60000 });
    return data as UploadResult;
  } finally {
    if (cleanupUri) {
      try {
        const FileSystem = require('expo-file-system/legacy');
        await FileSystem.deleteAsync?.(cleanupUri, { idempotent: true });
      } catch {
        try {
          const FileSystem = require('expo-file-system');
          await FileSystem.deleteAsync?.(cleanupUri, { idempotent: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
}

export async function uploadCandidateJson(candidate: UploadCandidate): Promise<UploadResult> {
  if (candidate.mime !== 'application/octet-stream' || !candidate.filename.endsWith('.ghostel')) {
    throw new Error('Uploads must be encrypted before being sent.');
  }
  if (candidate.size > ENCRYPTED_ATTACHMENT_MAX_BYTES) {
    throw new Error('File exceeds 10 MB limit');
  }
  const { data } = await api.post('/uploads', candidate, { timeout: 60000 });
  return data as UploadResult;
}

export async function uploadBase64(filename: string, mime: string, base64Data: string): Promise<UploadResult> {
  if (mime !== 'application/octet-stream' || !filename.endsWith('.ghostel')) {
    throw new Error('Uploads must be encrypted before being sent.');
  }
  const size = Math.ceil((base64Data.length * 3) / 4);
  return uploadCandidateMultipart({ filename, mime, data: base64Data, size });
}

export function attachmentUrlFor(id: string, mime: string, data: string): string {
  return `data:${mime};base64,${data}`;
}
