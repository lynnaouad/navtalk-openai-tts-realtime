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

// NavTalk realtime WS endpoint
const NAVTALK_WS_URL = "wss://transfer.navtalk.ai/wss/v2/realtime-chat";

const NavTalkMessageType = Object.freeze({
  CONNECTED_SUCCESS: "conversation.connected.success",
  CONNECTED_FAIL: "conversation.connected.fail",
  CONNECTED_CLOSE: "conversation.connected.close",
  INSUFFICIENT_BALANCE: "conversation.connected.insufficient_balance",

  WEB_RTC_OFFER: "webrtc.signaling.offer",
  WEB_RTC_ANSWER: "webrtc.signaling.answer",
  WEB_RTC_ICE_CANDIDATE: "webrtc.signaling.iceCandidate",

  REALTIME_SESSION_CREATED: "realtime.session.created",
  REALTIME_SESSION_UPDATED: "realtime.session.updated",

  REALTIME_INPUT_AUDIO_BUFFER_APPEND: "realtime.input_audio_buffer.append",
});

let socket = null;
let peerConnection = null;
let abortSpeak = null;
let videoStatsTimer = null;

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

function b64FromBytes(u8) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchIceServers() {
  const res = await fetch(
    "https://transfer.navtalk.ai/api/webrtc/generate-ice-servers",
    { method: "POST" }
  );
  const json = await res.json();
  const servers = json?.data?.iceServers ?? json?.iceServers;
  return Array.isArray(servers) && servers.length
    ? servers
    : [{ urls: "stun:stun.l.google.com:19302" }];
}

function sendWs(type, dataObj) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, data: dataObj }));
}

function cleanupPeer() {
  // STOP video stats polling FIRST
  if (videoStatsTimer) {
    clearInterval(videoStatsTimer);
    videoStatsTimer = null;
  }

  try {
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.close();
    }
  } catch {}
  peerConnection = null;
  webrtcPill.textContent = "webrtc: idle";
  try {
    videoEl.srcObject = null;
  } catch {}
}

function cleanupSocket() {
  try {
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
  } catch {}
  socket = null;
  setWsUI(false, "disconnected");
  sessionPill.textContent = "session: -";
}

function setButtons(connected) {
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
  sendBtn.disabled = !connected;
}

async function connectNavTalk() {
  const license = navtalkKeyEl.value.trim();
  const name = characterNameEl.value.trim();

  if (!license) {
    log("Missing NavTalk API key");
    return;
  }
  if (!name) {
    log("Missing character name");
    return;
  }

  const url = `${NAVTALK_WS_URL}?license=${encodeURIComponent(
    license
  )}&name=${encodeURIComponent(name)}&model=${encodeURIComponent(
    "transparency"
  )}`;

  log("Connecting WS:", url.replace(license, "****"));

  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    setWsUI(true, "connected (ws open)");
    log("WS open");
  };

  socket.onerror = (e) => log("WS error:", e?.message || e);

  socket.onclose = (e) => {
    log("WS close:", e.code, e.reason);
    setWsUI(false, "disconnected");
    cleanupPeer();
    cleanupSocket();
    setButtons(false);
    stopSpeaking();
  };

  socket.onmessage = async (event) => {
    if (typeof event.data !== "string") return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const nav_data = msg.data;

    switch (msg.type) {
      case NavTalkMessageType.CONNECTED_SUCCESS:
        setButtons(true);
        setWsUI(true, "connected (handshake ok)");
        log("CONNECTED_SUCCESS");
        if (nav_data?.sessionId)
          sessionPill.textContent = "session: " + nav_data.sessionId;
        break;

      case NavTalkMessageType.CONNECTED_FAIL:
        log("CONNECTED_FAIL:", msg.message || "unknown");
        break;

      case NavTalkMessageType.INSUFFICIENT_BALANCE:
        log("INSUFFICIENT_BALANCE");
        break;

      case NavTalkMessageType.WEB_RTC_OFFER:
        log("WEB_RTC_OFFER received");
        await handleOffer(nav_data);
        break;

      case NavTalkMessageType.WEB_RTC_ICE_CANDIDATE:
        await handleRemoteIce(nav_data);
        break;

      default:
        break;
    }
  };
}

async function handleOffer(payload) {
  try {
    cleanupPeer();

    const iceServers = await fetchIceServers();
    peerConnection = new RTCPeerConnection({ iceServers });

    peerConnection.ontrack = (event) => {
      log("ontrack:", event.track.kind);

      if (event.track.kind === "video") {
        const s = event.track.getSettings?.();
        // log("VIDEO settings:", s); // usually shows width/height
        // if (!videoStatsTimer) videoStatsTimer = startVideoStats();
      }

      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.play().catch(() => {});
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs(NavTalkMessageType.WEB_RTC_ICE_CANDIDATE, {
          candidate: event.candidate,
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      const s = peerConnection.iceConnectionState;
      webrtcPill.textContent = "webrtc: " + s;
      if (s === "connected" || s === "completed") log("WebRTC connected");
      if (s === "failed") log("WebRTC failed");
    };

    const offer = new RTCSessionDescription(payload.sdp);
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendWs(NavTalkMessageType.WEB_RTC_ANSWER, {
      sdp: peerConnection.localDescription,
    });
    webrtcPill.textContent = "webrtc: negotiating";
  } catch (e) {
    log("handleOffer error:", e?.message || e);
  }
}

async function handleRemoteIce(payload) {
  try {
    if (!peerConnection) return;
    const candidate = new RTCIceCandidate(payload.candidate);
    await peerConnection.addIceCandidate(candidate);
  } catch (e) {
    log("addIceCandidate error:", e?.message || e);
  }
}

function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    abortSpeak.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

async function sendPcmChunk(u8, sampleRate, bytesPerSample) {
  // Keep websocket messages small-ish (your old 4096 base64 slicing was fine)
  const BASE64_SLICE = 4096;

  if (!u8.length) return;

  const b64 = b64FromBytes(u8);

  for (let i = 0; i < b64.length; i += BASE64_SLICE) {
    socket.send(
      JSON.stringify({
        type: NavTalkMessageType.REALTIME_INPUT_AUDIO_BUFFER_APPEND,
        data: { audio: b64.slice(i, i + BASE64_SLICE) },
      })
    );
  }

  // pace by actual audio duration in this chunk
  const ms = (u8.length / (sampleRate * bytesPerSample)) * 1000;
  await sleep(ms);
}

async function speakText(text) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("Not connected");
    return;
  }

  stopSpeaking();

  const voice = voiceEl.value;
  const instructions = ttsInstructionsEl.value.trim();

  abortSpeak = new AbortController();
  stopBtn.disabled = false;

  log("TTS stream start (OpenAI) voice=", voice);

  const res = await fetch(TTS_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: abortSpeak.signal,
    body: JSON.stringify({ text, voice, instructions }),
  });

  if (!res.ok || !res.body) {
    log("TTS proxy failed:", res.status);
    stopSpeaking();
    return;
  }

  const reader = res.body.getReader();

  // PCM16 24kHz mono expected for this API style :contentReference[oaicite:1]{index=1}
  const sampleRate = 24000;
  const bytesPerSample = 2;

  // ~100ms audio per chunk (recommended range is typically 100–200ms for realtime pipelines)
  const chunkMs = 100;
  const targetBytes = Math.floor(
    sampleRate * (chunkMs / 1000) * bytesPerSample
  ); // 4800 bytes

  let buf = new Uint8Array(0);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;

      buf = concatU8(buf, value);

      while (buf.length >= targetBytes) {
        const chunk = buf.slice(0, targetBytes);
        buf = buf.slice(targetBytes);
        await sendPcmChunk(chunk, sampleRate, bytesPerSample);
      }
    }

    // IMPORTANT: flush remainder (this is what your 960-byte framing version was dropping)
    if (buf.length) {
      await sendPcmChunk(buf, sampleRate, bytesPerSample);
      buf = new Uint8Array(0);
    }

    log("TTS done");
  } catch (e) {
    if (abortSpeak?.signal?.aborted) log("TTS aborted");
    else log("TTS error:", e?.message || e);
  } finally {
    stopSpeaking();
  }
}

function stopSpeaking() {
  try {
    abortSpeak?.abort();
  } catch {}
  abortSpeak = null;
  stopBtn.disabled = true;
}

function startVideoStats() {
  let lastBytes = 0;
  let lastTs = 0;

  const timer = setInterval(async () => {
    if (!peerConnection) return;

    const stats = await peerConnection.getStats();
    for (const r of stats.values()) {
      if (
        r.type === "inbound-rtp" &&
        (r.kind === "video" || r.mediaType === "video")
      ) {
        // bitrate calc
        if (lastTs) {
          const dt = (r.timestamp - lastTs) / 1000;
          const dBytes = r.bytesReceived - lastBytes;
          const kbps = (dBytes * 8) / dt / 1000;
          log("video quality:", {
            w: r.frameWidth,
            h: r.frameHeight,
            fps: r.framesPerSecond,
            kbps: Math.round(kbps),
            lost: r.packetsLost,
            jitter: r.jitter,
          });
        }
        lastBytes = r.bytesReceived;
        lastTs = r.timestamp;
      }
    }
  }, 3000);

  return timer;
}

connectBtn.onclick = async () => {
  try {
    await connectNavTalk();
  } catch (e) {
    log("connect error:", e?.message || e);
  }
};

disconnectBtn.onclick = () => {
  stopSpeaking();
  cleanupPeer();
  cleanupSocket();
  setButtons(false);
};

stopBtn.onclick = () => stopSpeaking();

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
