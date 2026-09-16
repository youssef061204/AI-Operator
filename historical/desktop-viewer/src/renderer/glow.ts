const frame = document.getElementById("glowFrame") as HTMLDivElement;

window.desktopBridge?.onPresenceData?.((payload) => {
  const state = String(payload.state || "idle");
  frame.className = `glow-frame state-${state}`;
});

export {};
