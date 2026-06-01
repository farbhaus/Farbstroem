// Ambient declarations for CDN-loaded libraries used by the viewer.
// We don't pull in the upstream types because we'd then need npm runtime
// deps; only the surface we actually call is declared.

declare const OvenPlayer: {
  create(elementId: string, config: unknown): OvenPlayerInstance;
};

interface OvenPlayerInstance {
  on(
    event: string,
    handler: (e?: { newstate?: string; position?: number; offset?: number; duration?: number }) => void,
  ): void;
  getState(): string;
  getMute(): boolean;
  setMute(muted: boolean): void;
  getVolume(): number;
  setVolume(vol: number): void;
  play(): void;
  pause(): void;
  seek(position: number): void;
  getPosition(): number;
  getDuration(): number;
  load(): void;
  remove(): void;
}

// LiveKit client (loaded as window.LivekitClient by the UMD bundle).
// Only the bits the viewer touches are typed.
declare const LivekitClient: LivekitClientNS;

// Subset of LiveKit's AudioCaptureOptions we configure. voiceIsolation is a
// stronger, browser-native noise/voice isolation (Chrome ML) that supersedes
// noiseSuppression when supported; unsupported browsers ignore it.
interface AudioCaptureOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  voiceIsolation?: boolean;
  deviceId?: string;
}

interface RoomOptions {
  audioCaptureDefaults?: AudioCaptureOptions;
}

interface LivekitClientNS {
  Room: new (options?: RoomOptions) => LkRoom;
  RoomEvent: {
    ParticipantConnected: string;
    ParticipantDisconnected: string;
    TrackPublished: string;
    TrackUnpublished: string;
    TrackMuted: string;
    TrackUnmuted: string;
    TrackSubscribed: string;
    TrackUnsubscribed: string;
    LocalTrackUnpublished: string;
  };
  Track: {
    Source: {
      Camera: string;
      Microphone: string;
      ScreenShare: string;
    };
    Kind: {
      Audio: string;
      Video: string;
    };
  };
}

interface LkTrack {
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
  attach(el?: HTMLElement | HTMLMediaElement | null): void;
  detach(el?: HTMLElement | HTMLMediaElement | null): void;
}

interface LkPublication {
  trackSid: string;
  source: string;
  isMuted: boolean;
  track: LkTrack | null;
}

interface LkLocalParticipant {
  setCameraEnabled(on: boolean): Promise<void>;
  setMicrophoneEnabled(on: boolean, options?: AudioCaptureOptions): Promise<void>;
  setScreenShareEnabled(on: boolean): Promise<void>;
  getTrackPublication(source: string): LkPublication | undefined;
}

interface LkRemoteParticipant {
  identity: string;
  name?: string;
  metadata?: string;
  getTrackPublication(source: string): LkPublication | undefined;
  trackPublications: Map<string, LkPublication>;
}

interface LkRoom {
  localParticipant: LkLocalParticipant;
  remoteParticipants: Map<string, LkRemoteParticipant>;
  on(
    event: string,
    handler: (
      arg1?: LkPublication | LkTrack,
      arg2?: LkRemoteParticipant | LkLocalParticipant,
      arg3?: LkRemoteParticipant,
    ) => void,
  ): void;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  switchActiveDevice(kind: 'videoinput' | 'audioinput' | 'audiooutput', deviceId: string): Promise<void>;
}

// Vendor-prefixed fullscreen API on Safari/iOS.
interface Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface Element {
  webkitRequestFullscreen?: () => void;
}
interface HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}
