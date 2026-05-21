export type CaptureMode = "screenshot" | "video";
export type CaptureArea = "full" | "region";

export type CaptureStatus =
  | "draft"
  | "capturing"
  | "recording"
  | "ready"
  | "failed";

export interface ConsoleEntry {
  level: "error" | "warn";
  message: string;
  source:
    | "console"
    | "error"
    | "resource"
    | "securitypolicyviolation"
    | "unhandledrejection";
  timestamp: string;
  url: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface EvidenceAttachment {
  id: string;
  dataUrl: string;
  createdAt: string;
  url?: string;
  title?: string;
  captureArea?: CaptureArea;
  region?: CaptureRegion;
  originalDataUrl?: string;
  editedAt?: string;
}

export interface RecordingAttachment extends EvidenceAttachment {
  mimeType?: string;
}

export interface PageMetadata {
  url: string;
  title: string;
  userAgent: string;
  language: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
  };
}

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

export interface CaptureSession {
  id: string;
  mode: CaptureMode;
  status: CaptureStatus;
  tabId?: number;
  windowId?: number;
  createdAt: string;
  updatedAt: string;
  metadata?: PageMetadata;
  consoleErrors: ConsoleEntry[];
  screenshots?: EvidenceAttachment[];
  recordings?: RecordingAttachment[];
  screenshotDataUrl?: string;
  recordingDataUrl?: string;
  recordingMimeType?: string;
  error?: string;
  notice?: string;
}

export interface Settings {
  openaiApiKey?: string;
  openaiModel?: string;
  githubClientId?: string;
  githubAccessToken?: string;
  githubUserLogin?: string;
  githubSelectedRepo?: {
    owner: string;
    name: string;
    fullName: string;
    private?: boolean;
  };
  githubDefaultLabels?: string[];
}

export interface BackgroundResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type RuntimeMessage =
  | { type: "CAPTURE_SCREENSHOT"; area?: CaptureArea }
  | { type: "START_VIDEO_CAPTURE"; area?: CaptureArea }
  | { type: "ADD_SCREENSHOT_TO_SESSION"; sessionId: string; area?: CaptureArea }
  | { type: "ADD_VIDEO_TO_SESSION"; sessionId: string; area?: CaptureArea }
  | { type: "STOP_VIDEO_CAPTURE"; sessionId: string }
  | { type: "GET_SESSION"; sessionId?: string }
  | { type: "GET_SESSIONS" }
  | { type: "SET_ACTIVE_SESSION"; sessionId: string }
  | { type: "CLEAR_ACTIVE_SESSION"; sessionId?: string }
  | { type: "UPDATE_SESSION"; sessionId: string; patch: Partial<CaptureSession> }
  | { type: "LOG_CONSOLE_ENTRY"; entry: ConsoleEntry }
  | { type: "START_REGION_SELECTION" }
  | {
      type: "OFFSCREEN_START_RECORDING";
      streamId: string;
      sessionId: string;
      region?: CaptureRegion;
    }
  | { type: "OFFSCREEN_STOP_RECORDING"; sessionId: string }
  | {
      type: "OFFSCREEN_RECORDING_COMPLETE";
      sessionId: string;
      dataUrl: string;
      mimeType: string;
      region?: CaptureRegion;
    }
  | { type: "OFFSCREEN_RECORDING_ERROR"; sessionId: string; error: string };

export const STORAGE_KEYS = {
  latestSessionId: "latestSessionId",
  settings: "settings",
  sessions: "sessions",
  consolePrefix: "console:"
} as const;

export const DEFAULT_MODEL = "gpt-5";
