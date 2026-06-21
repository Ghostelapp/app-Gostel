import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  AppState,
  Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  PhoneOff,
  Mic,
  MicOff,
  ShieldCheck,
  Volume2,
  VolumeX,
} from 'lucide-react-native';
import Avatar from '../../src/Avatar';
import { useAuth } from '../../src/auth';
import { api, formatApiErrorDetail } from '../../src/api';
import { useWebSocket } from '../../src/ws';
import { theme } from '../../src/theme';
import { getInCallManager } from '../../src/incall';
import {
  markCallActive,
  endIncomingCallNative,
  subscribeToCallKeepActions,
} from '../../src/callkeep';
import {
  activateWebRtcAudioSession,
  deactivateWebRtcAudioSession,
} from '../../src/webrtcAudioSession';
import {
  cancelFullScreenIncomingCallNotification,
  startActiveCallService,
  stopActiveCallService,
} from '../../src/androidCallNotification';
import { useCallRingback } from '../../src/callRingback';
import {
  decryptCallSignalFromUser,
  encryptCallSignalForUser,
  syncConversationKeyTrust,
  type E2EECallSignalPayload,
} from '../../src/e2ee';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type CallStatus =
  | 'init'        // bootstrapping (loading ICE, getting media)
  | 'ringing'     // caller waiting for callee, or callee seeing incoming
  | 'connecting'  // SDP exchange in progress
  | 'connected'   // ICE connected — audio flowing
  | 'failed'      // ICE failed / no media
  | 'ended';      // hangup

type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type ContactInfo = { id: string; name?: string; username?: string };
type CallInfo = {
  caller_id?: string;
  caller_name?: string;
  member_ids?: string[];
  participants?: ContactInfo[];
  e2ee_required?: boolean;
  e2ee_member_keys?: Record<string, { public_key?: string; name?: string }>;
  status?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RINGBACK = require('../../assets/audio/ringback.mp3');
const CALL_TIMEOUT_MS = 45_000; // no-answer cutoff
const READY_RETRY_MS = 1_000;   // callee retries call:ready every 1s
const READY_RETRY_MAX = 15;     // 15s of retries — covers a slow caller bootstrap
const CONNECTION_RECOVERY_MS = 12_000;

const FALLBACK_ICE: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

const candidateTypeFromText = (candidate: unknown): string | null => {
  const text =
    typeof candidate === 'string'
      ? candidate
      : typeof (candidate as any)?.candidate === 'string'
        ? (candidate as any).candidate
        : '';
  const match = text.match(/\styp\s+([a-z0-9-]+)/i);
  return match?.[1]?.toLowerCase() || null;
};

const bumpCandidateCount = (
  countsRef: React.MutableRefObject<Record<string, number>>,
  candidate: unknown,
) => {
  const type = candidateTypeFromText(candidate);
  if (!type) return null;
  countsRef.current = {
    ...countsRef.current,
    [type]: (countsRef.current[type] || 0) + 1,
  };
  return type;
};

const trackSummary = (stream: any) => {
  const tracks = stream?.getTracks?.() || [];
  return tracks.map((track: any) => ({
    kind: String(track?.kind || ''),
    enabled: track?.enabled !== false,
    muted: track?.muted === true,
    readyState: String(track?.readyState || ''),
  }));
};

const summarizeAudioStats = (report: any) => {
  const rows: any[] = [];
  if (!report) return null;
  if (typeof report.forEach === 'function') {
    report.forEach((value: any) => rows.push(value));
  } else if (typeof report.values === 'function') {
    rows.push(...Array.from(report.values()));
  } else if (typeof report === 'object') {
    rows.push(...Object.values(report));
  }
  const audioRows = rows.filter((row) => {
    const kind = String(row?.kind || row?.mediaType || '').toLowerCase();
    const type = String(row?.type || '').toLowerCase();
    return kind === 'audio' || type.includes('audio') || row?.trackIdentifier;
  });
  const pick = (dir: string) => audioRows.filter((row) => String(row?.type || '').includes(dir));
  const sum = (items: any[], key: string) =>
    items.reduce((total, item) => total + Number(item?.[key] || 0), 0);
  const inbound = pick('inbound-rtp');
  const outbound = pick('outbound-rtp');
  const tracks = pick('track');
  return {
    inbound_packets: sum(inbound, 'packetsReceived'),
    inbound_bytes: sum(inbound, 'bytesReceived'),
    inbound_lost: sum(inbound, 'packetsLost'),
    outbound_packets: sum(outbound, 'packetsSent'),
    outbound_bytes: sum(outbound, 'bytesSent'),
    audio_levels: tracks
      .map((row) => row?.audioLevel)
      .filter((value) => typeof value === 'number')
      .slice(0, 4),
  };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function CallScreen() {
  const params = useLocalSearchParams<{
    id: string;
    role?: string;
    caller_id?: string;
    conversation_id?: string;
  }>();
  const id = params.id;
  const role = params.role;
  const callerIdParam = params.caller_id;
  const conversationIdParam = params.conversation_id;
  const router = useRouter();
  const { user } = useAuth();
  const { t } = useTranslation();

  const isCaller = role === 'caller';

  // ---------- UI state ----------
  const [callerName, setCallerName] = useState<string>(
    isCaller ? 'Calling…' : 'Incoming call'
  );
  const [status, setStatus] = useState<CallStatus>('init');
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState<string | null>(null);
  const [RTCViewComponent, setRTCViewComponent] = useState<any>(null);
  const [debugLine, setDebugLine] = useState<string>('');

  // ---------- refs ----------
  const pcRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const remoteStreamRef = useRef<any>(null);
  const remoteAudioElRef = useRef<any>(null); // web only
  const timerRef = useRef<any>(null);
  const peerIdRef = useRef<string | null>(isCaller ? null : callerIdParam || null);
  const iceServersRef = useRef<IceServer[]>(FALLBACK_ICE);
  const pendingIceRef = useRef<any[]>([]);
  const pendingSignalMessagesRef = useRef<any[]>([]);
  const processedSignalIdsRef = useRef<Set<string>>(new Set());
  const remoteSetRef = useRef(false);
  const wsSendRef = useRef<((data: any) => void) | null>(null);
  const peerPublicKeyRef = useRef<string | null>(null);
  const timeoutTimerRef = useRef<any>(null);
  const readyRetryRef = useRef<any>(null);
  const reconnectTimerRef = useRef<any>(null);
  const audioRepairTimerRef = useRef<any>(null);
  const statusRef = useRef<CallStatus>('init');
  const endedRef = useRef(false);
  const connectedRef = useRef(false);
  const inCallStartedRef = useRef(false);
  /** Caller side only: have we already created & sent the SDP offer? */
  const offerSentRef = useRef(false);
  /** Callee side only: have we already created & sent the SDP answer? */
  const answerSentRef = useRef(false);
  const restartAttemptedRef = useRef(false);
  const relayCandidateRef = useRef(false);
  const iceSourceRef = useRef<string>('fallback');
  const diagSeqRef = useRef(0);
  const onTrackCountRef = useRef(0);
  const onAddStreamCountRef = useRef(0);
  const remoteTrackCountRef = useRef(0);
  const localCandidateTypeCountsRef = useRef<Record<string, number>>({});
  const remoteCandidateTypeCountsRef = useRef<Record<string, number>>({});
  const lastIceStateRef = useRef<string>('new');
  const lastConnectionStateRef = useRef<string>('new');
  const lastAudioStatsRef = useRef<any>(null);

  // ringback player (caller only)
  const InCall = getInCallManager();
  const { startRingback, stopRingback } = useCallRingback(
    RINGBACK,
    isCaller && Platform.OS !== 'ios',
  );

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWebRTC } = require('../../src/webrtc');
      const WebRTC = getWebRTC();
      if (WebRTC?.RTCView) setRTCViewComponent(() => WebRTC.RTCView);
    } catch {
      /* native WebRTC unavailable */
    }
  }, []);

  const ensureCallPeerE2EE = useCallback(async (): Promise<boolean> => {
    if (!user?.id) {
      setErrMsg('Missing user session');
      return false;
    }
    try {
      const { data: call } = await api.get<CallInfo>(`/calls/${id}`);
      if (!call?.e2ee_required || !call.e2ee_member_keys) {
        setErrMsg('Call is not E2EE-ready');
        return false;
      }
      const peerId =
        peerIdRef.current ||
        (call.member_ids || []).find((memberId: string) => memberId !== user.id) ||
        null;
      if (!peerId) {
        setErrMsg('Missing E2EE peer');
        return false;
      }
      const peerKey = call.e2ee_member_keys[peerId]?.public_key || '';
      if (!peerKey) {
        setErrMsg('Missing peer E2EE key');
        return false;
      }
      const trust = await syncConversationKeyTrust(
        {
          type: 'direct',
          members: Object.entries(call.e2ee_member_keys).map(([memberId, key]) => ({
            id: memberId,
            e2ee_public_key: key.public_key,
          })),
        },
        user.id,
      );
      if (!trust.trusted) {
        setErrMsg(
          trust.changedMemberIds.includes(peerId)
            ? 'Contact E2EE key changed. Verify it in chat before calling.'
            : 'Call E2EE trust verification failed',
        );
        return false;
      }
      peerIdRef.current = peerId;
      peerPublicKeyRef.current = peerKey;
      return true;
    } catch (e) {
      setErrMsg(formatApiErrorDetail(e));
      return false;
    }
  }, [id, user?.id]);

  const sendEncryptedSignal = useCallback(
    async (
      type: 'call:offer' | 'call:answer' | 'call:ice',
      to: string,
      signal: Record<string, unknown>,
    ): Promise<boolean> => {
      if (!user?.id || !peerPublicKeyRef.current) {
        setErrMsg('Missing call E2EE keys');
        return false;
      }
      try {
        const e2eeSignal = await encryptCallSignalForUser(
          signal,
          peerPublicKeyRef.current,
          user.id,
        );
        const payload = {
          type,
          to,
          call_id: id,
          conversation_id: conversationIdParam,
          encrypted: true,
          e2ee_signal: e2eeSignal,
          signal_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
        // Persist first so signaling still works while the WebSocket is
        // reconnecting after the app is opened from a native call alert.
        await api.post(`/calls/${id}/signals`, payload);
        wsSendRef.current?.(payload);
        return true;
      } catch (e: any) {
        setErrMsg(`Signal encryption failed: ${e?.message || e}`);
        return false;
      }
    },
    [conversationIdParam, id, user?.id],
  );

  const decryptPeerSignal = useCallback(
    async (msg: {
      e2ee_signal?: E2EECallSignalPayload | null;
      from?: string;
    }): Promise<Record<string, unknown> | null> => {
      if (!user?.id || !peerPublicKeyRef.current || msg.from !== peerIdRef.current) {
        return null;
      }
      return decryptCallSignalFromUser(msg.e2ee_signal, peerPublicKeyRef.current, user.id);
    },
    [user?.id],
  );

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    setElapsedSec(0);
    timerRef.current = setInterval(
      () => setElapsedSec((s) => s + 1),
      1000
    );
  }, []);

  const fmtElapsed = () => {
    const m = Math.floor(elapsedSec / 60);
    const s = elapsedSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    if (readyRetryRef.current) {
      clearTimeout(readyRetryRef.current);
      readyRetryRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (audioRepairTimerRef.current) {
      clearInterval(audioRepairTimerRef.current);
      audioRepairTimerRef.current = null;
    }
  }, []);

  const startNativeCallAudio = useCallback(
    (forceSpeaker = speakerOn) => {
      if (Platform.OS === 'web') return;
      try {
        if (!inCallStartedRef.current) {
          InCall.start({ media: 'audio', auto: true });
          InCall.setKeepScreenOn(true);
          inCallStartedRef.current = true;
        }
        InCall.setForceSpeakerphoneOn(forceSpeaker);
        InCall.setSpeakerphoneOn(forceSpeaker);
        // InCallManager rewrites AVAudioSession while routing audio. Notify
        // react-native-webrtc after that rewrite so WebRTC binds to the final
        // active iOS audio session.
        activateWebRtcAudioSession();
      } catch {
        /* native audio routing is best-effort */
      }
    },
    [InCall, speakerOn],
  );

  const buildCallDiag = useCallback(
    (reason: string, extra: Record<string, unknown> = {}) => {
      const pc = pcRef.current;
      const localTracks = trackSummary(localStreamRef.current);
      const remoteTracks = trackSummary(remoteStreamRef.current);
      remoteTrackCountRef.current = remoteTracks.length;
      const localRelay = localCandidateTypeCountsRef.current.relay || 0;
      const remoteRelay = remoteCandidateTypeCountsRef.current.relay || 0;
      const iceState = String(
        pc?.iceConnectionState || lastIceStateRef.current || 'unknown',
      );
      const connectionState = String(
        pc?.connectionState || lastConnectionStateRef.current || 'unknown',
      );
      lastIceStateRef.current = iceState;
      lastConnectionStateRef.current = connectionState;
      setDebugLine(
        `ICE ${iceState}/${connectionState} | remote ${remoteTracks.length} | relay ${
          localRelay + remoteRelay > 0 ? 'yes' : 'no'
        } | stream ${remoteStreamRef.current ? 'yes' : 'no'}`,
      );
      return {
        reason,
        seq: ++diagSeqRef.current,
        platform: Platform.OS,
        role: isCaller ? 'caller' : 'callee',
        call_id: id,
        status: statusRef.current,
        err_msg: errMsg || '',
        peer_id_present: !!peerIdRef.current,
        ice_source: iceSourceRef.current,
        ice_state: iceState,
        connection_state: connectionState,
        signaling_state: String(pc?.signalingState || 'unknown'),
        gathering_state: String(pc?.iceGatheringState || 'unknown'),
        local_candidates: localCandidateTypeCountsRef.current,
        remote_candidates: remoteCandidateTypeCountsRef.current,
        relay_seen: localRelay + remoteRelay > 0 || relayCandidateRef.current,
        pending_ice: pendingIceRef.current.length,
        pending_signals: pendingSignalMessagesRef.current.length,
        processed_signals: processedSignalIdsRef.current.size,
        ontrack_count: onTrackCountRef.current,
        onaddstream_count: onAddStreamCountRef.current,
        remote_stream_url: !!remoteStreamUrl,
        rtc_view_loaded: !!RTCViewComponent,
        incall_started: inCallStartedRef.current,
        speaker_on: speakerOn,
        muted,
        connected_ref: connectedRef.current,
        local_tracks: localTracks,
        remote_tracks: remoteTracks,
        ...extra,
      };
    },
    [RTCViewComponent, errMsg, id, isCaller, muted, remoteStreamUrl, speakerOn],
  );

  const reportCallDiag = useCallback(
    async (reason: string, extra: Record<string, unknown> = {}) => {
      try {
        let audioStats = lastAudioStatsRef.current;
        try {
          const report = await pcRef.current?.getStats?.();
          audioStats = summarizeAudioStats(report);
          lastAudioStatsRef.current = audioStats;
        } catch {
          /* getStats is best-effort on native */
        }
        const diag = buildCallDiag(reason, { audio_stats: audioStats, ...extra });
        await api.post(`/calls/${id}/diag`, diag);
      } catch {
        /* diagnostics must never affect the call */
      }
    },
    [buildCallDiag, id],
  );

  const startAudioRepairLoop = useCallback(() => {
    if (Platform.OS === 'web') return;
    if (audioRepairTimerRef.current) {
      clearInterval(audioRepairTimerRef.current);
    }
    let ticks = 0;
    audioRepairTimerRef.current = setInterval(() => {
      ticks += 1;
      if (endedRef.current || !connectedRef.current || ticks > 8) {
        clearInterval(audioRepairTimerRef.current);
        audioRepairTimerRef.current = null;
        return;
      }
      startNativeCallAudio(speakerOn);
      reportCallDiag('audio_route_repair', { audio_repair_tick: ticks }).catch(() => {});
    }, 1_000);
  }, [reportCallDiag, speakerOn, startNativeCallAudio]);

  // ---------------------------------------------------------------------------
  // Cleanup + endCall
  // ---------------------------------------------------------------------------
  const cleanup = useCallback(async () => {
    clearTimers();
    stopRingback();
    connectedRef.current = false;
    try {
      localStreamRef.current?.getTracks?.().forEach((t: any) => {
        try {
          t.stop();
        } catch {}
      });
    } catch {}
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    setRemoteStreamUrl(null);
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    if (remoteAudioElRef.current && Platform.OS === 'web') {
      try {
        remoteAudioElRef.current.srcObject = null;
        remoteAudioElRef.current.remove();
      } catch {}
      remoteAudioElRef.current = null;
    }
    if (inCallStartedRef.current) {
      try {
        InCall.stop();
      } catch {}
      inCallStartedRef.current = false;
      // InCallManager.stop() may have swapped the AVAudioSession / Android
      // audio mode back to voice-call defaults. Clear our cached "configured"
      // flag so the next ringtone re-applies speaker routing.
      try {
        const Sounds = require('../../src/sounds');
        Sounds.resetAudioMode?.();
      } catch {
        /* ignore */
      }
      deactivateWebRtcAudioSession();
    }
    try {
      Vibration.cancel();
    } catch {}
    stopActiveCallService().catch(() => {});
  }, [clearTimers, stopRingback, InCall]);

  const returnToChat = useCallback(() => {
    if (conversationIdParam) {
      router.replace(`/chat/${conversationIdParam}` as any);
      return;
    }
    router.replace('/(tabs)/chats');
  }, [conversationIdParam, router]);

  const endCall = useCallback(
    async (reason?: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      await reportCallDiag('end_call', { end_reason: reason || '' });
      setStatus('ended');
      if (reason) setErrMsg(reason);

      // Clear any native OS-level CallKeep entry for this call (foreground
      // service notification, system call log). Safe no-op if the call was
      // never registered with CallKeep (e.g. outgoing call from in-app).
      try {
        endIncomingCallNative(id);
      } catch {
        /* ignore */
      }

      // notify backend (best effort)
      try {
        await api.post(`/calls/${id}/end`);
      } catch {}

      // notify peer over WS (best effort)
      if (peerIdRef.current) {
        try {
          wsSendRef.current?.({
            type: 'call:end',
            to: peerIdRef.current,
            call_id: id,
            conversation_id: conversationIdParam,
          });
        } catch {}
      }

      await cleanup();
      setTimeout(returnToChat, 800);
    },
    [id, cleanup, conversationIdParam, reportCallDiag, returnToChat]
  );

  const closeCallFromPeer = useCallback(
    async (reason?: string) => {
      if (endedRef.current) return;
      endedRef.current = true;
      await reportCallDiag('peer_end', { end_reason: reason || '' });
      setStatus('ended');
      if (reason) setErrMsg(reason);

      try {
        endIncomingCallNative(id);
      } catch {
        /* ignore */
      }

      await cleanup();
      try {
        const sounds = await import('../../src/sounds');
        await sounds.playDisconnectTone();
      } catch {
        /* keep call teardown reliable even if audio playback is unavailable */
      }
      setTimeout(returnToChat, 350);
    },
    [id, cleanup, reportCallDiag, returnToChat],
  );

  // ---------------------------------------------------------------------------
  // Media + PeerConnection setup
  // ---------------------------------------------------------------------------
  const fetchIceServers = useCallback(async () => {
    try {
      const { data } = await api.get('/calls/ice-servers');
      if (data?.iceServers?.length) {
        iceServersRef.current = data.iceServers;
        iceSourceRef.current = data.source || 'server';
      }
      if (data?.relayAvailable === false) {
        setErrMsg('TURN relay unavailable - calls between mobile networks may fail');
      }
    } catch (e) {
      console.warn('ice-servers fetch failed, using STUN fallback', e);
    }
  }, []);

  const ensureMedia = useCallback(async (): Promise<any | null> => {
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (Platform.OS === 'web') {
        const stream = await (navigator as any).mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
        return stream;
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWebRTC } = require('../../src/webrtc');
      const WebRTC = getWebRTC();
      if (!WebRTC) {
        setErrMsg('Native WebRTC not loaded. Requires APK build.');
        return null;
      }
      const stream = await WebRTC.mediaDevices.getUserMedia({ audio: audioConstraints });
      return stream;
    } catch (e: any) {
      const msg = e?.message || String(e);
      setErrMsg(`Microphone error: ${msg}`);
      return null;
    }
  }, []);

  const makeRemoteStreamFromTrack = useCallback((track: any): any | null => {
    if (!track || Platform.OS === 'web') return null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWebRTC } = require('../../src/webrtc');
      const WebRTC = getWebRTC();
      if (!WebRTC?.MediaStream) return null;
      let stream: any = null;
      try {
        stream = new WebRTC.MediaStream([track]);
      } catch {
        stream = new WebRTC.MediaStream();
        stream.addTrack?.(track);
      }
      return stream;
    } catch {
      return null;
    }
  }, []);

  const attachRemoteStream = useCallback((stream: any) => {
    remoteStreamRef.current = stream;
    remoteTrackCountRef.current = trackSummary(stream).length;
    if (Platform.OS === 'web') {
      const audio = (window as any).document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = 'none';
      (window as any).document.body.appendChild(audio);
      remoteAudioElRef.current = audio;
      return;
    }
    const url = typeof stream?.toURL === 'function' ? stream.toURL() : null;
    if (url) setRemoteStreamUrl(url);
    reportCallDiag('remote_stream_attached').catch(() => {});
  }, [reportCallDiag]);

  const markConnected = useCallback(() => {
    if (endedRef.current) return;
    connectedRef.current = true;
    statusRef.current = 'connected';
    stopRingback();
    setErrMsg(null);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    startNativeCallAudio(speakerOn);
    startAudioRepairLoop();
    startTimer();
    setStatus('connected');
    try {
      markCallActive(id);
    } catch {
      /* ignore */
    }
    startActiveCallService(id, callerName).catch(() => {});
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    reportCallDiag('mark_connected').catch(() => {});
  }, [
    callerName,
    id,
    reportCallDiag,
    speakerOn,
    startAudioRepairLoop,
    startNativeCallAudio,
    startTimer,
    stopRingback,
  ]);

  const attemptIceRestart = useCallback(async (): Promise<boolean> => {
    const pc = pcRef.current;
    const peerId = peerIdRef.current;
    if (!isCaller || restartAttemptedRef.current || !pc || !peerId) return false;
    restartAttemptedRef.current = true;
    remoteSetRef.current = false;
    pendingIceRef.current = [];
    setStatus('connecting');
    setErrMsg('Reconnecting through TURN…');
    try {
      pc.restartIce?.();
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        iceRestart: true,
      });
      await pc.setLocalDescription(offer);
      return await sendEncryptedSignal('call:offer', peerId, {
        sdp: offer.sdp,
        sdp_type: offer.type || 'offer',
        ice_restart: true,
      });
    } catch (e: any) {
      setErrMsg(`Reconnect failed: ${e?.message || e}`);
      return false;
    }
  }, [isCaller, sendEncryptedSignal]);

  const scheduleConnectionRecovery = useCallback(
    (pc: any) => {
      if (endedRef.current || reconnectTimerRef.current) return;
      setErrMsg('Reconnecting…');
      reconnectTimerRef.current = setTimeout(async () => {
        reconnectTimerRef.current = null;
        if (
          pc.connectionState === 'connected' ||
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed'
        ) {
          markConnected();
          return;
        }
        const restartSent = await attemptIceRestart();
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          if (
            pc.connectionState !== 'connected' &&
            pc.iceConnectionState !== 'connected' &&
            pc.iceConnectionState !== 'completed'
          ) {
            endCall(
              relayCandidateRef.current
                ? 'Connection failed'
                : 'Connection failed - TURN relay did not respond',
            );
          }
        }, restartSent || !isCaller ? CONNECTION_RECOVERY_MS : CONNECTION_RECOVERY_MS / 2);
      }, 3_000);
    },
    [attemptIceRestart, endCall, isCaller, markConnected],
  );

  const setupPeer = useCallback(
    (stream: any): any => {
      let pc: any;
      const config = {
        iceServers: iceServersRef.current,
        iceCandidatePoolSize: 10,
        // Mobile NAT paths often connect briefly and then drop media. We have
        // Cloudflare TURN in production, so native calls should prefer relay.
        iceTransportPolicy: Platform.OS === 'web' ? 'all' : 'relay',
      };

      if (Platform.OS === 'web') {
        pc = new (window as any).RTCPeerConnection(config);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWebRTC } = require('../../src/webrtc');
        const WebRTC = getWebRTC();
        if (!WebRTC) return null;
        pc = new WebRTC.RTCPeerConnection(config);
      }

      // remote track → attach
      const handleRemoteStream = (remoteStream: any) => {
        if (!remoteStream) return;
        attachRemoteStream(remoteStream);
        markConnected();
      };

      pc.ontrack = (e: any) => {
        onTrackCountRef.current += 1;
        const remoteStream = e?.streams?.[0] || makeRemoteStreamFromTrack(e?.track);
        handleRemoteStream(remoteStream);
      };
      pc.onaddstream = (e: any) => {
        onAddStreamCountRef.current += 1;
        handleRemoteStream(e?.stream);
      };
      // ICE candidates → relay to peer
      pc.onicecandidate = (e: any) => {
        if (e?.candidate && peerIdRef.current && wsSendRef.current) {
          const candidateText = String(e.candidate?.candidate || e.candidate || '');
          const type = bumpCandidateCount(localCandidateTypeCountsRef, e.candidate);
          if (type === 'relay' || candidateText.includes(' typ relay ')) {
            relayCandidateRef.current = true;
          }
          sendEncryptedSignal('call:ice', peerIdRef.current, {
            candidate: e.candidate.toJSON
              ? e.candidate.toJSON()
              : e.candidate,
          }).catch(() => {});
        }
      };
      pc.onicegatheringstatechange = () => {
        if (
          pc.iceGatheringState === 'complete' &&
          iceSourceRef.current === 'public-fallback' &&
          !relayCandidateRef.current &&
          !endedRef.current
        ) {
          setErrMsg('TURN relay did not respond; trying direct connection…');
        }
      };
      // Connection state
      pc.oniceconnectionstatechange = () => {
        const st = pc.iceConnectionState;
        lastIceStateRef.current = String(st || 'unknown');
        reportCallDiag('ice_state_change', { ice_state_event: String(st || '') }).catch(() => {});
        if (st === 'connected' || st === 'completed') {
          markConnected();
        } else if (st === 'failed' || st === 'disconnected') {
          scheduleConnectionRecovery(pc);
        }
      };
      pc.onconnectionstatechange = () => {
        lastConnectionStateRef.current = String(pc.connectionState || 'unknown');
        reportCallDiag('connection_state_change', {
          connection_state_event: String(pc.connectionState || ''),
        }).catch(() => {});
        if (pc.connectionState === 'connected') markConnected();
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          scheduleConnectionRecovery(pc);
        }
      };

      // Add local audio tracks
      if (stream) {
        if (Platform.OS !== 'web' && typeof pc.addStream === 'function') {
          try {
            pc.addStream(stream);
          } catch {}
        } else {
          try {
            stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));
          } catch {
            try {
              pc.addStream?.(stream);
            } catch {}
          }
        }
      }
      return pc;
    },
    [
      attachRemoteStream,
      makeRemoteStreamFromTrack,
      markConnected,
      reportCallDiag,
      scheduleConnectionRecovery,
      sendEncryptedSignal,
    ]
  );

  const drainPendingIce = useCallback(async () => {
    if (!pcRef.current) return;
    const queue = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const c of queue) {
      try {
        const type = bumpCandidateCount(remoteCandidateTypeCountsRef, c);
        if (type === 'relay') relayCandidateRef.current = true;
        await pcRef.current.addIceCandidate(c);
      } catch {
        /* ignore individual errors */
      }
    }
  }, []);

  // ---------------------------------------------------------------------------
  // WS message handler
  // ---------------------------------------------------------------------------
  const onWs = useCallback(
    async (msg: any) => {
      if (!msg || !msg.type) return;
      // Only process messages for THIS call
      if (msg.call_id && msg.call_id !== id) {
        // not for us, but call:incoming has no call_id check — skip silently
        if (msg.type !== 'call:incoming') return;
      }

      const pc = pcRef.current;
      const isPeerSignal =
        msg.type === 'call:offer' ||
        msg.type === 'call:answer' ||
        msg.type === 'call:ice';

      // Offers, answers and ICE can arrive while this screen is still loading
      // E2EE keys, microphone access or the PeerConnection. Dropping any of
      // them leaves both peers stuck on "Connecting", so replay them once the
      // bootstrap is complete.
      if (isPeerSignal && (!pc || !peerPublicKeyRef.current)) {
        pendingSignalMessagesRef.current.push(msg);
        if (pendingSignalMessagesRef.current.length > 100) {
          pendingSignalMessagesRef.current.shift();
        }
        return;
      }
      const signalId = String(msg.signal_id || '');
      if (signalId) {
        if (processedSignalIdsRef.current.has(signalId)) return;
        processedSignalIdsRef.current.add(signalId);
        if (processedSignalIdsRef.current.size > 500) {
          processedSignalIdsRef.current = new Set(
            Array.from(processedSignalIdsRef.current).slice(-250),
          );
        }
      }

      // ----- Caller side: callee is ready, can send offer -----
      if (msg.type === 'call:ready' && isCaller) {
        if (offerSentRef.current) return; // already sent offer for this call
        const from = msg.from;
        if (!from) return;
        // Remember peer id even if pc isn't ready yet — the callee will retry
        // sending call:ready until we (the caller) finally answer with an offer.
        peerIdRef.current = from;
        if (!pc) return; // PC not ready yet — wait for next retry
        offerSentRef.current = true;
        try {
          setStatus('connecting');
          const offer = await pc.createOffer({ offerToReceiveAudio: true });
          await pc.setLocalDescription(offer);
          const sent = await sendEncryptedSignal('call:offer', from, {
            sdp: offer.sdp,
            sdp_type: offer.type || 'offer',
          });
          if (!sent) throw new Error('Encrypted offer not sent');
        } catch (e: any) {
          offerSentRef.current = false; // allow retry
          setErrMsg(`Offer failed: ${e?.message || e}`);
          setStatus('failed');
          setTimeout(() => endCall('Offer failed'), 1500);
        }
        return;
      }

      // ----- Callee side: caller's SDP offer arrived -----
      if (msg.type === 'call:offer' && !isCaller) {
        const from = msg.from;
        if (from && !peerIdRef.current) peerIdRef.current = from;
        if (!pc) return; // PC not ready — caller will give up on no-answer timeout
        try {
          const signal = await decryptPeerSignal(msg);
          if (!signal?.sdp) throw new Error('Encrypted offer unavailable');
          const isRestart = signal.ice_restart === true;
          if (answerSentRef.current && !isRestart) return;
          answerSentRef.current = true;
          if (isRestart) {
            remoteSetRef.current = false;
          }
          setStatus('connecting');
          await pc.setRemoteDescription({ type: 'offer', sdp: String(signal.sdp) });
          remoteSetRef.current = true;
          await drainPendingIce();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (peerIdRef.current) {
            const sent = await sendEncryptedSignal('call:answer', peerIdRef.current, {
              sdp: answer.sdp,
              sdp_type: answer.type || 'answer',
              ice_restart: isRestart,
            });
            if (!sent) throw new Error('Encrypted answer not sent');
          }
        } catch (e: any) {
          answerSentRef.current = false;
          setErrMsg(`Answer failed: ${e?.message || e}`);
          setStatus('failed');
          setTimeout(() => endCall('Answer failed'), 1500);
        }
        return;
      }

      // ----- Caller side: callee's SDP answer arrived -----
      if (msg.type === 'call:answer' && isCaller) {
        try {
          if (!pc) return;
          const signal = await decryptPeerSignal(msg);
          if (!signal?.sdp) throw new Error('Encrypted answer unavailable');
          await pc.setRemoteDescription({ type: 'answer', sdp: String(signal.sdp) });
          remoteSetRef.current = true;
          await drainPendingIce();
        } catch (e: any) {
          setErrMsg(`SetRemote failed: ${e?.message || e}`);
        }
        return;
      }

      // ----- Both: ICE candidates from peer -----
      if (msg.type === 'call:ice') {
        if (!pc) return;
        const signal = await decryptPeerSignal(msg);
        if (!signal?.candidate) return;
        const type = bumpCandidateCount(remoteCandidateTypeCountsRef, signal.candidate);
        if (type === 'relay') relayCandidateRef.current = true;
        if (!remoteSetRef.current) {
          pendingIceRef.current.push(signal.candidate);
        } else {
          try {
            await pc.addIceCandidate(signal.candidate);
          } catch {
            /* often invalid candidates — ignore */
          }
        }
        return;
      }

      // ----- Both: peer cancelled / ended / rejected -----
      if (
        msg.type === 'call:end' ||
        msg.type === 'call:reject' ||
        msg.type === 'call:cancel' ||
        // Server-side broadcast when /api/calls/{id}/end is called by either side.
        msg.type === 'call:ended'
      ) {
        // Only react to events for THIS call.
        const evCallId = msg.call_id ?? msg.data?.call_id;
        if (evCallId && evCallId !== id) return;
        const status = msg.data?.status;
        closeCallFromPeer(
          msg.type === 'call:reject' || status === 'rejected'
            ? 'Call rejected'
            : msg.type === 'call:cancel' || status === 'cancelled'
              ? 'Call cancelled'
              : 'Call ended by peer'
        );
        return;
      }
    },
    [id, isCaller, drainPendingIce, endCall, closeCallFromPeer, sendEncryptedSignal, decryptPeerSignal]
  );

  const { send } = useWebSocket(onWs, !!user);
  wsSendRef.current = send;

  useEffect(() => {
    if (isCaller || !id) return;
    api.post(`/calls/${id}/accept`).catch(() => {});
  }, [id, isCaller]);

  useEffect(() => {
    cancelFullScreenIncomingCallNotification(id).catch(() => {});
    import('../../src/sounds').then((s) => s.stopRingtone()).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id || !user) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { data } = await api.get(`/calls/${id}/signals`);
        const signals = Array.isArray(data) ? data : [];
        for (const signal of signals) {
          if (cancelled) return;
          await onWs(signal);
        }
      } catch (error: any) {
        if (error?.response?.status === 404 && !cancelled) {
          closeCallFromPeer('Call ended by peer');
        }
        /* WebSocket remains the primary signaling path. */
      }
    };
    poll().catch(() => {});
    const timer = setInterval(() => poll().catch(() => {}), 750);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [closeCallFromPeer, id, onWs, user]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!endedRef.current && pcRef.current) {
        reportCallDiag('periodic').catch(() => {});
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [reportCallDiag]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let previousState = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      const fromState = previousState;
      previousState = nextState;
      reportCallDiag('app_state_change', {
        app_state_from: fromState,
        app_state_to: nextState,
      }).catch(() => {});

      if (nextState !== 'active' || endedRef.current) return;

      // Mobile OSes can hand the audio route back to the app while unlocking.
      // Rebind WebRTC and restore routing without rebuilding the peer connection.
      startNativeCallAudio(speakerOn);
      if (Platform.OS === 'android' && localStreamRef.current) {
        startActiveCallService(id, callerName).catch(() => {
          reportCallDiag('android_active_call_service_resume_failed').catch(() => {});
        });
      }
      if (connectedRef.current) startAudioRepairLoop();

      const pc = pcRef.current;
      if (
        pc &&
        pc.connectionState !== 'connected' &&
        pc.iceConnectionState !== 'connected' &&
        pc.iceConnectionState !== 'completed'
      ) {
        scheduleConnectionRecovery(pc);
      }
    });
    return () => sub.remove();
  }, [
    callerName,
    id,
    reportCallDiag,
    scheduleConnectionRecovery,
    speakerOn,
    startAudioRepairLoop,
    startNativeCallAudio,
  ]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    return subscribeToCallKeepActions(({ callId, action }) => {
      if (callId === id && action === 'end') {
        closeCallFromPeer('Call ended');
      }
    });
  }, [closeCallFromPeer, id]);

  // ---------------------------------------------------------------------------
  // Lifecycle: bootstrap the call when component mounts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    const sendReadyWithRetry = async (attempt = 0) => {
      if (endedRef.current || cancelled) return;
      const target = peerIdRef.current; // for callee = caller_id from URL
      if (target) {
        const payload = {
          type: 'call:ready',
          to: target,
          call_id: id,
          conversation_id: conversationIdParam,
          signal_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
        try {
          await api.post(`/calls/${id}/signals`, payload);
          wsSendRef.current?.(payload);
        } catch {}
      }
      if (attempt < READY_RETRY_MAX) {
        readyRetryRef.current = setTimeout(
          () => sendReadyWithRetry(attempt + 1).catch(() => {}),
          READY_RETRY_MS
        );
      }
    };

    const bootstrap = async () => {
      reportCallDiag('bootstrap_start').catch(() => {});
      // 1. Fetch ICE servers (cached on backend)
      await fetchIceServers();
      reportCallDiag('ice_servers_loaded').catch(() => {});
      if (cancelled || endedRef.current) return;

      // 2. Resolve and verify call E2EE keys before touching media/WebRTC.
      const e2eeReady = await ensureCallPeerE2EE();
      if (!e2eeReady) {
        reportCallDiag('e2ee_failed').catch(() => {});
        setTimeout(() => endCall('E2EE unavailable'), 1500);
        return;
      }
      reportCallDiag('e2ee_ready').catch(() => {});
      if (cancelled || endedRef.current) return;

      // 2b. Native audio session must be active before microphone/WebRTC setup,
      // especially on iOS when the call was answered from CallKit.
      startNativeCallAudio(false);

      // 3. Get microphone access
      const stream = await ensureMedia();
      if (!stream) {
        // ensureMedia already set errMsg; end the call
        reportCallDiag('media_failed').catch(() => {});
        setTimeout(() => endCall('No microphone'), 1500);
        return;
      }
      if (cancelled || endedRef.current) return;
      localStreamRef.current = stream;
      reportCallDiag('local_media_ready').catch(() => {});

      // Android must own a microphone foreground service before the app can
      // move behind the lock screen. Waiting for ICE to connect is too late:
      // Android 12+ can reject a foreground-service start from the background.
      if (Platform.OS === 'android') {
        try {
          await startActiveCallService(id, callerName);
          reportCallDiag('android_active_call_service_started').catch(() => {});
        } catch {
          reportCallDiag('android_active_call_service_start_failed').catch(() => {});
        }
      }

      // 4. Setup PC
      const pc = setupPeer(stream);
      if (!pc) {
        reportCallDiag('peer_setup_failed').catch(() => {});
        setTimeout(() => endCall('WebRTC unavailable'), 1500);
        return;
      }
      pcRef.current = pc;
      reportCallDiag('peer_setup_ready').catch(() => {});

      const pendingSignals = pendingSignalMessagesRef.current;
      pendingSignalMessagesRef.current = [];
      for (const pendingSignal of pendingSignals) {
        if (cancelled || endedRef.current) return;
        await onWs(pendingSignal);
      }

      // 5. Set initial status
      setStatus(isCaller ? 'ringing' : 'connecting');
      if (isCaller) startRingback();

      // 4b. RACE FIX (caller): if callee already sent `call:ready` while we
      // were still fetching ICE / acquiring mic, the handler set peerIdRef but
      // had to bail because pc wasn't ready. Trigger the offer now.
      if (
        isCaller &&
        peerIdRef.current &&
        !offerSentRef.current &&
        pcRef.current
      ) {
        offerSentRef.current = true;
        try {
          setStatus('connecting');
          const offer = await pcRef.current.createOffer({
            offerToReceiveAudio: true,
          });
          await pcRef.current.setLocalDescription(offer);
          const sent = await sendEncryptedSignal('call:offer', peerIdRef.current, {
            sdp: offer.sdp,
            sdp_type: offer.type || 'offer',
          });
          if (!sent) throw new Error('Encrypted offer not sent');
        } catch (e: any) {
          offerSentRef.current = false;
          setErrMsg(`Offer failed: ${e?.message || e}`);
          setStatus('failed');
          setTimeout(() => endCall('Offer failed'), 1500);
          return;
        }
      }

      // 6. Timeout for no-answer
      timeoutTimerRef.current = setTimeout(() => {
        if (!endedRef.current && !connectedRef.current) {
          endCall('No answer');
        }
      }, CALL_TIMEOUT_MS);

      // 7. Callee: notify caller we're ready (will retry)
      if (!isCaller) {
        sendReadyWithRetry().catch(() => {});
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // UI actions
  // ---------------------------------------------------------------------------
  const toggleMute = () => {
    setMuted((m) => {
      const next = !m;
      try {
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => {
          t.enabled = !next;
        });
        if (Platform.OS !== 'web') InCall.setMicrophoneMute(next);
      } catch {}
      return next;
    });
  };

  const toggleSpeaker = () => {
    setSpeakerOn((s) => {
      const next = !s;
      try {
        if (Platform.OS !== 'web') {
          InCall.setForceSpeakerphoneOn(next);
          InCall.setSpeakerphoneOn(next);
        }
      } catch {}
      return next;
    });
  };

  const handleEndPress = () => {
    if (status === 'ringing' && isCaller && peerIdRef.current) {
      // Caller cancels before pickup
      try {
        wsSendRef.current?.({
          type: 'call:cancel',
          to: peerIdRef.current,
          call_id: id,
          conversation_id: conversationIdParam,
        });
      } catch {}
    }
    endCall('Hung up');
  };

  // ---------------------------------------------------------------------------
  // Initial peer name (caller fetches call info)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const { data: call } = await api.get<CallInfo>(`/calls/${id}`);
        if (!call) return;
        const participants = Array.isArray(call.participants) ? call.participants : [];
        const participantById = Object.fromEntries(
          participants.map((p) => [p.id, p] as const)
        );
        if (!isCaller) {
          const caller = call.caller_id ? participantById[call.caller_id] : null;
          setCallerName(
            caller?.name ||
              (caller?.username ? `@${caller.username}` : null) ||
              call.caller_name ||
              'Incoming call'
          );
          return;
        }
        const peerId = (call.member_ids || []).find((m: string) => m !== user?.id);
        if (peerId) {
          const participant = participantById[peerId];
          if (participant?.name || participant?.username) {
            setCallerName(participant.name || `@${participant.username}`);
            return;
          }
          try {
            const { data: contacts } = await api.get('/contacts');
            const peer = Array.isArray(contacts)
              ? (contacts as ContactInfo[]).find((c) => c.id === peerId)
              : null;
            setCallerName(peer?.name || (peer?.username ? `@${peer.username}` : 'Calling…'));
          } catch {
            setCallerName('Calling…');
          }
        }
      } catch (e) {
        console.warn('call info fetch', formatApiErrorDetail(e));
      }
    })();
  }, [id, isCaller, user?.id]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const statusLine = (() => {
    if (errMsg && (status === 'failed' || status === 'ended')) return errMsg;
    switch (status) {
      case 'init':
        return 'Preparing…';
      case 'ringing':
        return isCaller ? 'Calling…' : 'Incoming call…';
      case 'connecting':
        return 'Connecting…';
      case 'connected':
        return fmtElapsed();
      case 'failed':
        return errMsg || 'Connection failed';
      case 'ended':
        return 'Call ended';
      default:
        return elapsedSec > 0 ? fmtElapsed() : '';
    }
  })();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.bg} />
      {Platform.OS !== 'web' && remoteStreamUrl && RTCViewComponent ? (
        <RTCViewComponent
          streamURL={remoteStreamUrl}
          style={styles.remoteAudioSink}
          objectFit="cover"
        />
      ) : null}

      <View style={styles.content}>
        <View style={styles.statusRow}>
          <ShieldCheck color={theme.colors.primary} size={14} strokeWidth={2.5} />
          <Text style={styles.encryptedText}>{t('calls.encrypted_call')}</Text>
        </View>

        <Avatar name={callerName} size={140} color={theme.colors.primary} />
        <Text style={styles.name}>{callerName}</Text>
        <Text style={styles.statusText}>{statusLine}</Text>

        {errMsg && status !== 'ended' && status !== 'failed' && (
          <Text style={styles.warnText}>{errMsg}</Text>
        )}
        {debugLine ? <Text style={styles.debugText}>{debugLine}</Text> : null}
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          testID="speaker-button"
          onPress={toggleSpeaker}
          style={[
            styles.ctrlBtn,
            speakerOn && { backgroundColor: theme.colors.primaryDark },
          ]}
          disabled={status !== 'connected'}
        >
          {speakerOn ? (
            <Volume2 color={theme.colors.primary} size={22} strokeWidth={2} />
          ) : (
            <VolumeX color={theme.colors.textPrimary} size={22} strokeWidth={2} />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          testID="end-call-button"
          onPress={handleEndPress}
          style={[styles.ctrlBtn, styles.endBtn]}
        >
          <PhoneOff color="#fff" size={26} strokeWidth={2.4} />
        </TouchableOpacity>

        <TouchableOpacity
          testID="mute-button"
          onPress={toggleMute}
          style={[
            styles.ctrlBtn,
            muted && { backgroundColor: theme.colors.warning },
          ]}
          disabled={status !== 'connected' && status !== 'connecting'}
        >
          {muted ? (
            <MicOff color={theme.colors.background} size={22} strokeWidth={2} />
          ) : (
            <Mic color={theme.colors.textPrimary} size={22} strokeWidth={2} />
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  bg: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.background },
  remoteAudioSink: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.primaryDark,
    marginBottom: 30,
  },
  encryptedText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 26,
    fontWeight: '700',
    marginTop: 24,
  },
  statusText: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    marginTop: 8,
  },
  warnText: {
    color: theme.colors.warning,
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
  debugText: {
    color: theme.colors.textMuted,
    fontSize: 11,
    marginTop: 12,
    textAlign: 'center',
    lineHeight: 16,
    maxWidth: 320,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingBottom: 36,
    paddingTop: 12,
  },
  ctrlBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  endBtn: {
    backgroundColor: theme.colors.error,
    borderColor: theme.colors.error,
  },
});
