// Shapes returned by the public viewer endpoints. Kept in sync by hand
// with handlers under backend/src/routes/rooms_public.rs and the websocket
// hub in backend/src/ws.rs. snake_case fields come straight from SQLite
// row_to_json; camelCase fields are explicit JSON.

export type Role = 'presenter' | 'viewer';
export type RoomStatus = 'pending' | 'live' | 'ended';
export type DeliveryMode = 'webrtc' | 'llhls';
// A tile in the unified viewer stage. 'stream' is the OvenPlayer broadcast,
// 'share' is the active screenshare, anything else is a LiveKit participant
// identity.
export type TileId = 'stream' | 'share' | string;

export interface RoomInfo {
  name: string;
  status: RoomStatus;
  delivery_mode: DeliveryMode;
  has_password: boolean;
  has_stream_key: boolean;
  waiting_room: boolean;
}

export interface JoinResponse {
  participant_id: string;
  token: string;
  role: Role;
  delivery_mode: DeliveryMode;
  stream_key: string | null;
  status: RoomStatus;
  admitted: boolean;
  waiting_room: boolean;
  error?: string;
}

export interface StatusResponse {
  admitted: boolean;
  kicked: boolean;
  room_status: RoomStatus;
}

export interface LivekitTokenResponse {
  token: string;
  url: string;
}

export interface RosterEntry {
  id: string;
  name: string;
  role: Role;
}

export interface SessionFile {
  id: string;
  name: string;
  size: number;
  uploaderName?: string;
  role?: Role;
}

// ---- WebSocket message variants (server → client) ----

interface ChatHistoryItem {
  type: 'chat:message' | 'file:shared';
  ts: number;
  name: string;
  role: Role;
  text?: string;
  // file:shared fields
  id?: string;
  size?: number;
  uploaderName?: string;
}

export type WsMessage =
  | { type: 'auth:ok' }
  | { type: 'kicked' }
  | { type: 'room:live' }
  | { type: 'room:pending' }
  | { type: 'room:ended' }
  | { type: 'stream:assigned'; streamKey: string }
  | { type: 'stream:removed' }
  | { type: 'participants:update'; participants: RosterEntry[] }
  | { type: 'chat:history'; messages: ChatHistoryItem[] }
  | {
      type: 'chat:message';
      ts: number;
      name: string;
      role: Role;
      text: string;
    }
  | {
      type: 'file:shared';
      ts: number;
      name: string;
      role: Role;
      id: string;
      size: number;
      uploaderName: string;
    }
  | { type: 'pointer:move'; participantId: string; name: string; x: number; y: number }
  | { type: 'pointer:hide'; participantId: string }
  | { type: 'focus:set'; tileId: TileId | null };

// ---- WebSocket message variants (client → server) ----

export type WsClientMessage =
  | { type: 'auth'; participantId: string; token: string }
  | { type: 'chat:message'; text: string }
  | { type: 'pointer:move'; x: number; y: number }
  | { type: 'pointer:hide' }
  | { type: 'focus:set'; tileId: TileId | null }
  | { type: 'file:share'; fileId: string };

// ---- Saved session (sessionStorage) ----

export interface SavedSession {
  participantId: string;
  token: string;
  deliveryMode: DeliveryMode;
  streamKey: string | null;
  role: Role;
}
