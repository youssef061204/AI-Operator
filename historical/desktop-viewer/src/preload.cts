import { contextBridge, ipcRenderer } from "electron";

type PresencePayload = {
  state: string;
  mode: string;
  size: string;
  text: string;
  active: boolean;
  manual_pause: boolean;
};

contextBridge.exposeInMainWorld("desktopBridge", {
  killSwitch: async () => ipcRenderer.invoke("agent:kill"),
  startLocalAgent: async () => ipcRenderer.invoke("agent:start-local"),
  stopLocalAgent: async () => ipcRenderer.invoke("agent:stop-local"),
  resumeAfterInput: async () => ipcRenderer.invoke("agent:resume-after-input"),
  openMainWindow: async () => ipcRenderer.invoke("agent:open-main"),
  togglePresenceMode: async () => ipcRenderer.invoke("agent:presence:toggle-mode"),
  setPresenceSize: async (size: "orb" | "compact" | "expanded") => ipcRenderer.invoke("agent:presence:set-size", size),
  setPresence: (payload: Partial<PresencePayload>) => {
    ipcRenderer.send("agent:presence:update", payload);
  },
  onPresenceData: (callback: (payload: PresencePayload) => void) => {
    const listener = (_event: unknown, payload: PresencePayload) => callback(payload);
    ipcRenderer.on("agent:presence:data", listener);
    return () => ipcRenderer.removeListener("agent:presence:data", listener);
  },
  onPresenceCommand: (callback: (command: string) => void) => {
    const listener = (_event: unknown, command: string) => callback(command);
    ipcRenderer.on("agent:presence:command", listener);
    return () => ipcRenderer.removeListener("agent:presence:command", listener);
  },
  onProcessLog: (callback: (message: string) => void) => {
    const listener = (_event: unknown, message: string) => callback(message);
    ipcRenderer.on("agent:process-log", listener);
    return () => ipcRenderer.removeListener("agent:process-log", listener);
  },
});
