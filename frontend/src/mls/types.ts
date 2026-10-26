export type Device = { user_id: string; device_id: string };
export type PublicDevice = Device & { signature_key: string };
export type Room = { roster: Device[]; seq: number; epoch: number; joined: boolean; messages: any[]; deletions?: Record<string, string>; outbox?: { request: any; body?: any }; claimId?: string };
export type Vault = { version: 1; device: Device; master: string; state?: string; publicKey?: string; verified: Record<string, string>; rooms: Record<string, Room>; enrollment?: string[] };
export type SaveVault = () => Promise<void>;
