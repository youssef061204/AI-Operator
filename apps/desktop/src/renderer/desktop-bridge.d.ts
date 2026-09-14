interface DesktopBridge {
  killSwitch: () => Promise<{ ok: boolean; status?: number }>;
  startLocalAgent: () => Promise<{ ok: boolean; message: string }>;
  stopLocalAgent: () => Promise<{ ok: boolean; message: string }>;
  resumeAfterInput?: () => Promise<{ ok: boolean; message: string }>;
  openMainWindow?: () => Promise<{ ok: boolean }>;
  togglePresenceMode?: () => Promise<{ ok: boolean; mode: string }>;
  setPresenceSize?: (size: "orb" | "compact" | "expanded") => Promise<{ ok: boolean; size: string }>;
  setPresence?: (payload: { state?: string; mode?: string; size?: string; text?: string; active?: boolean; manual_pause?: boolean }) => void;
  onPresenceData?: (callback: (payload: { state: string; mode: string; size: string; text: string; active: boolean; manual_pause: boolean }) => void) => () => void;
  onProcessLog: (callback: (message: string) => void) => () => void;
}

interface Window {
  desktopBridge?: DesktopBridge;
}
