// Cross-module shared state. Subscribers re-render when state changes
// instead of every site calling syncConferenceTiles + sizePlayer + etc.
// manually after a mutation. Modules that own their own internal state
// (chat list, pointer cursors, upload XHR) keep it private.

import { createStore } from '../shared/store.js';
import type {
  CallLayout,
  DeliveryMode,
  Role,
  RoomInfo,
  RoomMode,
  RoomStatus,
  RosterEntry,
} from './types.js';

export interface ViewerState {
  // Room metadata loaded once on /info
  roomInfo: RoomInfo | null;
  status: RoomStatus;
  mode: RoomMode;
  layout: CallLayout;
  // True once the user manually toggles the layout while a screen share is
  // active. Prevents auto-switch from fighting the user mid-share. Cleared
  // when the share ends.
  layoutOverride: boolean;
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
  mode: 'broadcast',
  layout: 'grid',
  layoutOverride: false,
  role: 'viewer',
  deliveryMode: 'webrtc',
  streamKey: null,
  cameraOn: false,
  micOn: false,
  screenOn: false,
  roster: [],
  chatOpen: false,
  confOpen: false,
  pointerMode: false,
});

// Convenience helpers — modules that just want a single field don't need
// to spell out viewerStore.get().mode each time.
export const getState = (): ViewerState => viewerStore.get();
export const setState = viewerStore.set;
