import { AppState, Platform } from 'react-native';
import { api } from './api';
import {
  clearActiveCallState,
  getActiveCallState,
  isTerminalCallStatus,
  type LocalCallStatus,
  logCallEvent,
  mapBackendCallStatus,
  saveActiveCallState,
} from './callState';
import {
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
  isIncoming: boolean;
  isCallUiVisible: boolean;
  lastSyncAt: number;
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
  }

  async endCall(callId: string): Promise<void> {
    if (!callId) return;
    await api.post(`/calls/${callId}/end`);
  }

  private async syncActiveCallFromBackendInternal(reason: string): Promise<ManagedCallState | null> {
    logCallEvent('APP_RESUMED_CALL_SYNC_START', {
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
      logCallEvent('APP_RESUMED_CALL_SYNC_RESULT', {
        reason,
        ok: false,
        statusCode: error?.response?.status || '',
      });
      return this.state;
    }

    const status = mapBackendCallStatus(data?.status);
    const callId = String(data?.call_id || data?.id || local?.activeCallId || '');
    const hasActiveCall = Boolean(data?.call_id || data?.id);
    logCallEvent('APP_RESUMED_CALL_SYNC_RESULT', {
      reason,
      ok: true,
      hasActiveCall,
      callId,
      status,
    });

    if (!hasActiveCall || isTerminalCallStatus(status) || data?.ended_at) {
      logCallEvent('NO_ACTIVE_CALL_AFTER_UNLOCK', {
        reason,
        callId,
        status,
      });
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
      status === 'IDLE'
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
      isIncoming,
      isCallUiVisible: this.context.isIncomingUiVisible?.(call.id) || false,
      lastSyncAt: Date.now(),
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
