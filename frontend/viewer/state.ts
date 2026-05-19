// Cross-module shared state. Subscribers re-render when state changes
// instead of every site calling syncConferenceTiles + sizePlayer + etc.
// manually after a mutation. Modules that own their own internal state
// (chat list, pointer cursors, upload XHR) keep it private.

import { createStore } from '../shared/store.js';
import type {
  DeliveryMode,
  Role,
  RoomInfo,
  RoomStatus,
  RosterEntry,
  TileId,
} from './types.js';

export interface ViewerState {
  // Room metadata loaded once on /info
  roomInfo: RoomInfo | null;
  status: RoomStatus;
  // Tile currently pinned to the main stage. null = grid view, every tile
  // shares the stage equally.
  focusedTile: TileId | null;
  // True once the user has manually pinned/unpinned. Suppresses auto-pin
  // until the user resets (clicking the focused tile clears it).
  focusOverride: boolean;
  // Session
  role: Role;
  deliveryMode: DeliveryMode;
  streamKey: string | null;
  // Conference local state
  cameraOn: boolean;
  micOn: boolean;
  screenOn: boolean;
  // Roster from participants:update WS messages
  roster: RosterEntry[];
  // Panels
  chatOpen: boolean;
  confOpen: boolean;
  // Pointer mode toggle
  pointerMode: boolean;
}

export const viewerStore = createStore<ViewerState>({
  roomInfo: null,
  status: 'pending',
  focusedTile: null,
  focusOverride: false,
  role: 'viewer',
  deliveryMode: 'webrtc',
  streamKey: null,
  cameraOn: false,
  micOn: false,
  screenOn: false,
  roster: [],
  chatOpen: false,
  // Strip is "open" by default — entering focus mode shows it.
  confOpen: true,
  pointerMode: false,
});

// Convenience helpers — modules that just want a single field don't need
// to spell out viewerStore.get().mode each time.
export const getState = (): ViewerState => viewerStore.get();
export const setState = viewerStore.set;
