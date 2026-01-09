// avatarCore.js
// Shared NavTalk avatar + WebRTC connection and OpenAI TTS->PCM forwarding.
//
// This module is UI-agnostic: you pass DOM elements + callbacks in.

const NAVTALK_WS_URL = "wss://transfer.navtalk.ai/wss/v2/realtime-chat";

const NavTalkMessageType = Object.freeze({
  CONNECTED_SUCCESS: "conversation.connected.success",
  CONNECTED_FAIL: "conversation.connected.fail",
  CONNECTED_CLOSE: "conversation.connected.close",
  INSUFFICIENT_BALANCE: "conversation.connected.insufficient_balance",

  WEB_RTC_OFFER: "webrtc.signaling.offer",
  WEB_RTC_ANSWER: "webrtc.signaling.answer",
  WEB_RTC_ICE_CANDIDATE: "webrtc.signaling.iceCandidate",

  REALTIME_INPUT_AUDIO_BUFFER_APPEND: "realtime.input_audio_buffer.append",
  REALTIME_INPUT_AUDIO_BUFFER_CLEAR: "realtime.input_audio_buffer.clear",
  REALTIME_INPUT_AUDIO_BUFFER_COMMIT: "realtime.input_audio_buffer.commit",
});

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

function concatU8(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function createAvatarClient(opts) {
  const {
    videoEl,
    log = () => {},
    onWsStatus = () => {},
    onSessionId = () => {},
    onWebrtcState = () => {},
    ttsProxyUrl,
    getTtsSettings = () => ({ voice: "nova", instructions: "" }),
  } = opts;

  let socket = null;
  let peerConnection = null;
  let abortSpeak = null;

  function commitNavTalkAudioBuffer() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: NavTalkMessageType.REALTIME_INPUT_AUDIO_BUFFER_COMMIT,
        data: {},
      })
    );
  }

  function sendWs(type, dataObj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type, data: dataObj }));
  }

  function clearNavTalkAudioBuffer() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: NavTalkMessageType.REALTIME_INPUT_AUDIO_BUFFER_CLEAR,
        data: {},
      })
    );
  }

  function cleanupPeer() {
    try {
      if (peerConnection) {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.close();
      }
    } catch {}
    peerConnection = null;
    onWebrtcState("idle");
    try {
      if (videoEl) videoEl.srcObject = null;
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
    onWsStatus(false, "disconnected");
    onSessionId(null);
  }

  function stopSpeaking() {
    try {
      abortSpeak?.abort();
    } catch {}
    abortSpeak = null;
  }

  function interruptSpeaking() {
    stopSpeaking(); // abort local fetch/stream
    clearNavTalkAudioBuffer(); // flush navtalk queued audio
  }

  async function handleOffer(payload) {
    try {
      cleanupPeer();

      const iceServers = await fetchIceServers();
      peerConnection = new RTCPeerConnection({ iceServers });

      peerConnection.ontrack = (event) => {
        if (event.streams && event.streams[0] && videoEl) {
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
        onWebrtcState(s);
      };

      const offer = new RTCSessionDescription(payload.sdp);
      await peerConnection.setRemoteDescription(offer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      sendWs(NavTalkMessageType.WEB_RTC_ANSWER, {
        sdp: peerConnection.localDescription,
      });
      onWebrtcState("negotiating");
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

  async function connect({
    navtalkKey,
    characterName,
    avatarModel = "transparency",
  }) {
    const license = (navtalkKey || "").trim();
    const name = (characterName || "").trim();

    if (!license) throw new Error("Missing NavTalk API key");
    if (!name) throw new Error("Missing character name");

    // reset
    stopSpeaking();
    cleanupPeer();
    cleanupSocket();

    const url = `${NAVTALK_WS_URL}?license=${encodeURIComponent(
      license
    )}&name=${encodeURIComponent(name)}&model=${encodeURIComponent(
      avatarModel
    )}`;

    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      onWsStatus(true, "connected (ws open)");
      log("WS open");
    };

    socket.onerror = (e) => log("WS error:", e?.message || e);

    socket.onclose = (e) => {
      log("WS close:", e.code, e.reason);
      onWsStatus(false, "disconnected");
      cleanupPeer();
      cleanupSocket();
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
          onWsStatus(true, "connected (handshake ok)");
          log("CONNECTED_SUCCESS");
          if (nav_data?.sessionId) onSessionId(nav_data.sessionId);
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

  async function sleep(ms, controller) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      controller?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    });
  }

  function makeSilencePcm(sampleRate, ms) {
    const samples = Math.floor(sampleRate * (ms / 1000));
    const bytes = samples * 2; // 16-bit mono
    return new Uint8Array(bytes); // zeros = silence
  }

  async function sendPcmChunk(u8, sampleRate, bytesPerSample, controller) {
    const BASE64_SLICE = 4096;
    if (!u8.length) return;

    // ✅ ensure 16-bit alignment (prevents tail corruption)
    if (u8.length % 2 !== 0) {
      u8 = u8.slice(0, u8.length - 1);
    }

    const b64 = b64FromBytes(u8);
    for (let i = 0; i < b64.length; i += BASE64_SLICE) {
      if (controller?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");

      socket.send(
        JSON.stringify({
          type: NavTalkMessageType.REALTIME_INPUT_AUDIO_BUFFER_APPEND,
          data: { audio: b64.slice(i, i + BASE64_SLICE) },
        })
      );
    }

    // ✅ Don't pace by audio duration (causes drift + tail cut).
    // Just yield briefly so we don't block the UI and we let WS flush.
    await new Promise((r) => setTimeout(r, 0));
  }

  async function speakText(text) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      log("Not connected");
      return;
    }
    if (!ttsProxyUrl) throw new Error("Missing ttsProxyUrl");

    interruptSpeaking(); // abort + clear ONCE

    // create a controller for THIS utterance and keep a reference for Stop button
    const controller = new AbortController();
    abortSpeak = controller;

    const { voice, instructions } = getTtsSettings() || {};
    log("TTS start voice=", voice);

    const res = await fetch(ttsProxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ text, voice, instructions }),
    });

    if (!res.ok || !res.body) {
      log("TTS proxy failed:", res.status);
      stopSpeaking();
      return;
    }

    const reader = res.body.getReader();

    const sampleRate = 24000;
    const bytesPerSample = 2;
    const chunkMs = 200;
    const targetBytes = Math.floor(
      sampleRate * (chunkMs / 1000) * bytesPerSample
    );

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
          await sendPcmChunk(chunk, sampleRate, bytesPerSample, controller);
        }
      }

      if (buf.length) {
        await sendPcmChunk(buf, sampleRate, bytesPerSample, controller);
        buf = new Uint8Array(0);
      }

      // ✅ add a short silence tail so last word doesn't get chopped
      const tail = makeSilencePcm(sampleRate, 350); // try 250–500ms
      await sendPcmChunk(tail, sampleRate, bytesPerSample, controller);

      commitNavTalkAudioBuffer();

      // give navtalk jitter buffer time to drain last frames
      await new Promise((r) => setTimeout(r, 600));

      log("TTS done");
    } catch (e) {
      if (controller.signal.aborted) log("TTS aborted");
      else log("test TTS error:", e?.message || e);
    } finally {
      // only clear if this is still the current one
      if (abortSpeak === controller) {
        abortSpeak = null; // just release the controller reference
      }
    }
  }

  return {
    connect,
    disconnect() {
      interruptSpeaking();
      cleanupPeer();
      cleanupSocket();
    },
    speakText,
    stopSpeaking: interruptSpeaking,
    isConnected() {
      return !!socket && socket.readyState === WebSocket.OPEN;
    },
  };
}
