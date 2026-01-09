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
const stopBtn = el("stopBtn");
const clearChatBtn = el("clearChatBtn");

const voiceEl = el("voice");
const ttsInstructionsEl = el("ttsInstructions");
const chatModelEl = el("chatModel");
const autoSpeakEl = el("autoSpeak");

const chatLogEl = el("chatLog");
const chatInputEl = el("chatInput");
const sendChatBtn = el("sendChatBtn");
const videoEl = el("character-video");

const TTS_PROXY_URL = "http://localhost:5179/tts";
const CHAT_PROXY_URL = "http://localhost:5179/chat";

const sessionId = crypto.randomUUID();

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
  sendChatBtn.disabled = !connected;
}

function escapeHtml(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="bubble"><div class="role">${role}</div><div class="text">${escapeHtml(
    text
  ).replaceAll("\n", "<br/>")}</div></div>`;
  chatLogEl.appendChild(div);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

async function callChat(userText) {
  const model = chatModelEl.value;
  const res = await fetch(CHAT_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message: userText, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.message || `Chat failed (${res.status})`);
  }
  return await res.json();
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
  },
  getTtsSettings: () => ({
    voice: voiceEl.value,
    instructions: ttsInstructionsEl.value.trim(),
  }),
});

async function speakAssistant(text) {
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

clearChatBtn.onclick = () => {
  chatLogEl.innerHTML = "";
  addMsg("system", "Chat cleared (server session stays until server restarts). ");
};

sendChatBtn.onclick = async () => {
  const t = chatInputEl.value.trim();
  if (!t) return;

  chatInputEl.value = "";
  addMsg("user", t);
  sendChatBtn.disabled = true;

  try {
    const out = await callChat(t);
    const reply = out?.reply || "";
    addMsg("assistant", reply);

    if (autoSpeakEl.checked && avatar.isConnected() && reply) {
      await speakAssistant(reply);
    }
  } catch (e) {
    addMsg("system", `Error: ${e?.message || e}`);
    log("chat error:", e?.message || e);
  } finally {
    sendChatBtn.disabled = !avatar.isConnected();
  }
};

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChatBtn.click();
  }
});

// initial UI state
setWsUI(false, "disconnected");
setButtons(false);
stopBtn.disabled = true;
addMsg("system", "Type a message, then Send. The server keeps conversation context per session.");
