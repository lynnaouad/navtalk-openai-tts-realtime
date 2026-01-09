import { createAvatarClient } from "./avatarCore.js";

const el = (id) => document.getElementById(id);

const logEl = el("log");
const wsDot = el("wsDot");
const wsStatus = el("wsStatus");
const sessionPill = el("sessionPill");
const webrtcPill = el("webrtcPill");

const navtalkKeyEl = el("navtalkKey");
const characterNameEl = el("characterName");

const connectBtn = el("connectBtn");
const disconnectBtn = el("disconnectBtn");
const sendBtn = el("sendBtn");
const stopBtn = el("stopBtn");

const textEl = el("text");
const voiceEl = el("voice");
const ttsInstructionsEl = el("ttsInstructions");
const videoEl = el("character-video");

// local TTS proxy
const TTS_PROXY_URL = "http://localhost:5179/tts";

function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  logEl.textContent += line + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setWsUI(connected, statusText) {
  wsDot.classList.toggle("ok", !!connected);
  wsStatus.textContent = statusText;
}

function setButtons(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  sendBtn.disabled = !connected;
}

const avatar = createAvatarClient({
  videoEl,
  ttsProxyUrl: TTS_PROXY_URL,
  log,
  onWsStatus: (connected, txt) => {
    setWsUI(connected, txt);
    setButtons(connected);
    if (!connected) stopBtn.disabled = true;
  },
  onSessionId: (id) => {
    sessionPill.textContent = "session: " + (id ?? "-");
  },
  onWebrtcState: (s) => {
    webrtcPill.textContent = "webrtc: " + s;
    if (s === "connected" || s === "completed") log("WebRTC connected");
    if (s === "failed") log("WebRTC failed");
  },
  getTtsSettings: () => ({
    voice: voiceEl.value,
    instructions: ttsInstructionsEl.value.trim(),
  }),
});

async function speakText(text) {
  stopBtn.disabled = false;
  try {
    await avatar.speakText(text);
  } finally {
    stopBtn.disabled = true;
  }
}

connectBtn.onclick = async () => {
  try {
    await avatar.connect({
      navtalkKey: navtalkKeyEl.value,
      characterName: characterNameEl.value,
      avatarModel: "transparency",
    });
  } catch (e) {
    log("connect error:", e?.message || e);
  }
};

disconnectBtn.onclick = () => {
  avatar.disconnect();
  setButtons(false);
  setWsUI(false, "disconnected");
};

stopBtn.onclick = () => {
  avatar.stopSpeaking();
  stopBtn.disabled = true;
};

sendBtn.onclick = () => {
  const t = textEl.value.trim();
  if (!t) return;
  speakText(t);
};

textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

setWsUI(false, "disconnected");
setButtons(false);
stopBtn.disabled = true;
