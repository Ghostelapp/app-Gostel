import { AppState, Platform } from 'react-native';
import { api } from './api';
import {
  cacheTerminatedCallId,
  clearActiveCallState,
  getCachedTerminatedCallStatus,
  getActiveCallState,
  isTerminalCallStatus,
  type LocalCallStatus,
  logCallEvent,
  mapBackendCallStatus,
  saveActiveCallState,
} from './callState';
import {
  savePendingIncomingCall,
  normalizeIncomingCallPayload,
  type IncomingCallPayload,
} from './incomingCallStore';

type RouterLike = { push: (href: any) => void };

type ManagedCallState = {
  activeCallId: string;
  callStatus: LocalCallStatus;
  callerId: string;
  calleeId?: string;
  conversationId: string;
  mode: string;
  createdAt?: string;
  expiresAt?: string;
  answeredAt?: string;
  endedAt?: string;
  isIncoming: boolean;
  isCallUiVisible: boolean;
  isNativeCallUiActive: boolean;
  lastSyncAt: number;
  peerConnectionState: string;
  localAudioEnabled: boolean;
  remoteAudioConnected: boolean;
};

type RestoreOptions = {
  persist?: boolean;
  notifyNative?: boolean;
};

type CallManagerContext = {
  userId?: string | null;
  router?: RouterLike | null;
  isIncomingUiVisible?: (callId: string) => boolean;
  restoreIncomingUi?: (call: IncomingCallPayload, options?: RestoreOptions) => void;
  restoreActiveCallUi?: (
    call: IncomingCallPayload,
    status: LocalCallStatus,
    reason: string,
  ) => void;
  clearCallUi?: (callId: string | null, reason: string) => void;
};

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return first ? String(first) : undefined;
  }
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function callPayloadFromBackend(data: any): IncomingCallPayload | null {
  return normalizeIncomingCallPayload({
    ...data,
    id: data?.call_id || data?.id,
    call_id: data?.call_id || data?.id,
    caller_id: data?.caller_id,
    caller_name: data?.caller_name,
    conversation_id: data?.conversation_id,
    mode: data?.mode || 'audio',
    received_at: Date.now(),
  });
}

class GhostelCallManager {
  private context: CallManagerContext = {};
  private state: ManagedCallState | null = null;
  private syncPromise: Promise<ManagedCallState | null> | null = null;

  configure(context: CallManagerContext): void {
    this.context = context;
  }

  getState(): ManagedCallState | null {
    return this.state;
  }

  async startOutgoingCall(conversationId: string, mode: 'audio' | 'video' = 'audio'): Promise<ManagedCallState | null> {
    const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { data } = await api.post('/calls/start', {
      conversation_id: conversationId,
      mode,
      call_id: callId,
    });
    const call = callPayloadFromBackend(data);
    if (!call) return null;
    const nextState: ManagedCallState = {
      activeCallId: call.id,
      callStatus: 'OUTGOING_RINGING',
      callerId: call.caller_id,
      calleeId: firstString(data?.callee_ids),
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: data?.created_at || data?.createdAt || '',
      expiresAt: data?.expires_at || data?.expiresAt || '',
      answeredAt: '',
      endedAt: '',
      isIncoming: false,
      isCallUiVisible: false,
      isNativeCallUiActive: false,
      lastSyncAt: Date.now(),
      peerConnectionState: 'new',
      localAudioEnabled: true,
      remoteAudioConnected: false,
    };
    this.state = nextState;
    await saveActiveCallState({
      activeCallId: call.id,
      callStatus: 'OUTGOING_RINGING',
      callerId: call.caller_id,
      calleeId: nextState.calleeId,
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: nextState.createdAt,
      expiresAt: nextState.expiresAt,
    }).catch(() => {});
    logCallEvent('CALL_MANAGER_STATE_CHANGED', {
      callId: call.id,
      status: 'OUTGOING_RINGING',
      reason: 'start_outgoing_call',
    });
    return nextState;
  }

  async handleIncomingCallInvite(payload: unknown, reason = 'incoming_invite'): Promise<ManagedCallState | null> {
    const call = normalizeIncomingCallPayload(payload);
    if (!call) return this.state;
    const cachedTerminalStatus = await getCachedTerminatedCallStatus(call.id);
    if (cachedTerminalStatus) {
      logCallEvent('STALE_PUSH_IGNORED', {
        callId: call.id,
        terminalStatus: cachedTerminalStatus,
        source: reason,
      });
      await this.clearCallState(`${reason}:cached_terminal`, call.id);
      return this.state;
    }
    if (this.state?.activeCallId === call.id && !isTerminalCallStatus(this.state.callStatus)) {
      logCallEvent('DUPLICATE_CALL_IGNORED', {
        callId: call.id,
        reason,
        currentStatus: this.state.callStatus,
      });
      return this.state;
    }
    await savePendingIncomingCall(call).catch(() => {});
    await saveActiveCallState({
      activeCallId: call.id,
      callStatus: 'INCOMING_RINGING',
      callerId: call.caller_id,
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: call.received_at ? new Date(call.received_at).toISOString() : undefined,
    }).catch(() => {});
    this.state = {
      activeCallId: call.id,
      callStatus: 'INCOMING_RINGING',
      callerId: call.caller_id,
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: call.received_at ? new Date(call.received_at).toISOString() : undefined,
      isIncoming: true,
      isCallUiVisible: this.context.isIncomingUiVisible?.(call.id) || false,
      isNativeCallUiActive: Platform.OS === 'ios' && AppState.currentState !== 'active',
      lastSyncAt: Date.now(),
      peerConnectionState: 'new',
      localAudioEnabled: true,
      remoteAudioConnected: false,
    };
    logCallEvent('CALL_MANAGER_STATE_CHANGED', {
      callId: call.id,
      status: 'INCOMING_RINGING',
      reason,
    });
    await this.restoreCallUi(call, 'INCOMING_RINGING', reason);
    return this.state;
  }

  async handlePushReceived(payload: unknown): Promise<ManagedCallState | null> {
    logCallEvent(Platform.OS === 'ios' ? 'VOIP_PUSH_RECEIVED' : 'CALL_PUSH_RECEIVED', {
      type: (payload as any)?.type || '',
      callId: (payload as any)?.call_id || (payload as any)?.id || '',
    });
    return this.handleIncomingCallInvite(payload, 'push_received');
  }

  async handleAppForeground(reason = 'app_foreground'): Promise<ManagedCallState | null> {
    return this.syncActiveCallFromBackend(reason);
  }

  handleAppBackground(): void {
    logCallEvent('CALL_MANAGER_STATE_CHANGED', {
      callId: this.state?.activeCallId || '',
      status: this.state?.callStatus || 'IDLE',
      reason: 'app_background',
    });
  }

  reconnectSignaling(): void {
    logCallEvent('WEBSOCKET_RECONNECT_AFTER_RESUME', {
      callId: this.state?.activeCallId || '',
    });
  }

  reconnectWebRTCIfNeeded(): void {
    logCallEvent('CALL_MANAGER_STATE_CHANGED', {
      callId: this.state?.activeCallId || '',
      status: this.state?.callStatus || 'IDLE',
      reason: 'webrtc_reconnect_requested',
    });
  }

  handleNetworkChange(): void {
    logCallEvent('CALL_MANAGER_STATE_CHANGED', {
      callId: this.state?.activeCallId || '',
      status: 'RECONNECTING',
      reason: 'network_change',
    });
  }

  async syncActiveCallFromBackend(reason: string): Promise<ManagedCallState | null> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.syncActiveCallFromBackendInternal(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async restoreCallUi(call: IncomingCallPayload, status: LocalCallStatus, reason: string): Promise<void> {
    if (status === 'INCOMING_RINGING') {
      const alreadyVisible = this.context.isIncomingUiVisible?.(call.id) || false;
      if (alreadyVisible) {
        logCallEvent('CALL_UI_ALREADY_VISIBLE_SKIP_DUPLICATE', {
          callId: call.id,
          reason,
          status,
        });
        this.state = this.state
          ? { ...this.state, isCallUiVisible: true, lastSyncAt: Date.now() }
          : this.state;
        return;
      }
      logCallEvent('RESTORE_INCOMING_CALL_UI', {
        callId: call.id,
        reason,
        appState: AppState.currentState,
      });
      this.context.restoreIncomingUi?.(call, {
        persist: true,
        notifyNative: Platform.OS === 'android' || AppState.currentState !== 'active',
      });
      if (this.state) this.state.isCallUiVisible = true;
      return;
    }

    if (status === 'ACTIVE' || status === 'CONNECTING' || status === 'RECONNECTING') {
      logCallEvent('RESTORE_ACTIVE_CALL_UI', {
        callId: call.id,
        reason,
        status,
        appState: AppState.currentState,
      });
      this.context.restoreActiveCallUi?.(call, status, reason);
      if (this.state) this.state.isCallUiVisible = true;
    }
  }

  async clearCallState(reason: string, callId?: string | null): Promise<void> {
    const targetCallId = callId || this.state?.activeCallId || null;
    this.context.clearCallUi?.(targetCallId, reason);
    await clearActiveCallState(targetCallId || undefined).catch(() => {});
    logCallEvent('LOCAL_CALL_STATE_CLEARED', {
      reason,
      callId: targetCallId,
    });
    this.state = null;
  }

  async acceptCall(callId: string): Promise<void> {
    if (!callId) return;
    await api.post(`/calls/${callId}/accept`);
  }

  async declineCall(callId: string): Promise<void> {
    if (!callId) return;
    await api.post(`/calls/${callId}/decline`).catch(() => api.post(`/calls/${callId}/end`));
    await cacheTerminatedCallId(callId, 'DECLINED').catch(() => {});
    await this.clearCallState('decline_call', callId);
  }

  async cancelOutgoingCall(callId: string): Promise<void> {
    if (!callId) return;
    await api.post(`/calls/${callId}/cancel`).catch(() => api.post(`/calls/${callId}/end`));
    await cacheTerminatedCallId(callId, 'CANCELLED').catch(() => {});
    await this.clearCallState('cancel_outgoing_call', callId);
  }

  async endCall(callId: string): Promise<void> {
    if (!callId) return;
    await api.post(`/calls/${callId}/end`);
    await cacheTerminatedCallId(callId, 'ENDED').catch(() => {});
    await this.clearCallState('end_call', callId);
  }

  private async syncActiveCallFromBackendInternal(reason: string): Promise<ManagedCallState | null> {
    logCallEvent('CALL_STATE_SYNC_START', {
      reason,
      appState: AppState.currentState,
    });

    const local = await getActiveCallState().catch(() => null);
    logCallEvent('LOCAL_CALL_STATE_LOADED', {
      reason,
      callId: local?.activeCallId || '',
      status: local?.callStatus || '',
    });

    let data: any = null;
    try {
      const activeResponse = await api.get('/calls/active');
      data = activeResponse.data;
      if (!data && local?.activeCallId) {
        try {
          const statusResponse = await api.get(`/calls/${local.activeCallId}/status`);
          data = statusResponse.data;
        } catch {
          data = null;
        }
      }
    } catch (error: any) {
      logCallEvent('CALL_STATE_SYNC_RESULT', {
        reason,
        ok: false,
        statusCode: error?.response?.status || '',
      });
      return this.state;
    }

    const status = mapBackendCallStatus(data?.status);
    const callId = String(data?.call_id || data?.id || local?.activeCallId || '');
    const hasActiveCall = Boolean(data?.call_id || data?.id);
    const cachedTerminalStatus = await getCachedTerminatedCallStatus(callId);
    logCallEvent('CALL_STATE_SYNC_RESULT', {
      reason,
      ok: true,
      hasActiveCall,
      callId,
      status,
      cachedTerminalStatus: cachedTerminalStatus || '',
    });

    if (cachedTerminalStatus || !hasActiveCall || isTerminalCallStatus(status) || data?.ended_at) {
      logCallEvent(
        !hasActiveCall
          ? 'APP_RESUME_NO_ACTIVE_CALL_CLEARING_LOCAL_STATE'
          : cachedTerminalStatus
            ? 'APP_RESUME_NO_ACTIVE_CALL_CLEARING_LOCAL_STATE'
            : 'NO_ACTIVE_CALL_AFTER_UNLOCK',
        {
        reason,
        callId,
        status: cachedTerminalStatus || status,
        },
      );
      if (isTerminalCallStatus(status)) {
        await cacheTerminatedCallId(callId, status).catch(() => {});
      }
      await this.clearCallState(reason, callId || local?.activeCallId || null);
      return null;
    }

    const call = callPayloadFromBackend(data);
    if (!call) {
      await this.clearCallState(`${reason}:invalid_backend_call`, callId || null);
      return null;
    }

    const userId = this.context.userId || '';
    const isIncoming = String(data?.direction || '') === 'incoming' || call.caller_id !== userId;
    const normalizedStatus =
      String(data?.status || '').toLowerCase() === 'ringing'
        ? isIncoming
          ? 'INCOMING_RINGING'
          : 'OUTGOING_RINGING'
        : status === 'IDLE'
          ? isIncoming
            ? 'INCOMING_RINGING'
            : 'OUTGOING_RINGING'
          : status;

    const nextState: ManagedCallState = {
      activeCallId: call.id,
      callStatus: normalizedStatus,
      callerId: call.caller_id,
      calleeId: firstString(data?.callee_ids),
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: data?.created_at || data?.started_at || local?.createdAt || '',
      expiresAt: data?.expires_at || local?.expiresAt || '',
      answeredAt: data?.answered_at || data?.answeredAt || '',
      endedAt: data?.ended_at || data?.endedAt || '',
      isIncoming,
      isCallUiVisible: this.context.isIncomingUiVisible?.(call.id) || false,
      isNativeCallUiActive: false,
      lastSyncAt: Date.now(),
      peerConnectionState: String(data?.lastKnownClientState?.[userId]?.peer_connection_state || 'unknown'),
      localAudioEnabled: data?.lastKnownClientState?.[userId]?.local_audio_enabled !== false,
      remoteAudioConnected: data?.lastKnownClientState?.[userId]?.remote_audio_connected === true,
    };
    this.state = nextState;

    await saveActiveCallState({
      activeCallId: call.id,
      callStatus: normalizedStatus,
      callerId: call.caller_id,
      calleeId: nextState.calleeId,
      conversationId: call.conversation_id,
      mode: call.mode,
      createdAt: nextState.createdAt,
      expiresAt: nextState.expiresAt,
    }).catch(() => {});

    logCallEvent('ACTIVE_CALL_FOUND_AFTER_UNLOCK', {
      reason,
      callId: call.id,
      status: normalizedStatus,
      isIncoming,
    });

    if (normalizedStatus === 'INCOMING_RINGING' && isIncoming) {
      await this.restoreCallUi(call, normalizedStatus, reason);
    } else if (
      normalizedStatus === 'CONNECTING' ||
      normalizedStatus === 'ACTIVE' ||
      normalizedStatus === 'RECONNECTING'
    ) {
      await this.restoreCallUi(call, normalizedStatus, reason);
    }

    return nextState;
  }
}

export const callManager = new GhostelCallManager();
