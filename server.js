// server.js
// OpenAI TTS streaming proxy (keeps your OpenAI key off the browser)

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Very small in-memory chat sessions (good enough for a demo).
// If you restart the server, sessions are lost.
const chatSessions = new Map();
const MAX_TURNS = 20; // keep last N user/assistant messages

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * Streams raw PCM audio from OpenAI TTS to the browser.
 * Browser forwards PCM bytes to NavTalk in near real-time.
 */
app.post("/tts", async (req, res) => {
  try {
    const { text, voice = "marin", model = "gpt-4o-mini-tts" } = req.body || {};
    const audio = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      response_format: "pcm",
    });

    // audio is a Response-like object; convert to ArrayBuffer
    const buf = Buffer.from(await audio.arrayBuffer());
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(buf);
  } catch (err) {
    console.error("OpenAI TTS ERROR:", err);
    res.status(500).json({
      error: "tts_failed",
      message: err?.message,
      status: err?.status,
      code: err?.code,
      type: err?.type,
    });
  }
});

/**
 * Simple AI conversation endpoint.
 * Client sends: { sessionId, message, model? }
 * Server keeps the message history per sessionId in memory.
 */
app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message, model = "gpt-4o-mini" } = req.body || {};

    if (!sessionId || typeof sessionId !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing sessionId" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing message" });
    }

    let history = chatSessions.get(sessionId);
    if (!history) {
      history = [
        {
          role: "system",
          content:
            "You are a helpful, concise assistant. Keep answers clear and natural. Avoid long rambles.",
        },
      ];
      chatSessions.set(sessionId, history);
    }

    history.push({ role: "user", content: message });

    // Keep only the last MAX_TURNS (plus system).
    const system = history[0];
    const tail = history.slice(-MAX_TURNS * 2);
    history = [system, ...tail.filter((m) => m.role !== "system")];
    chatSessions.set(sessionId, history);

    const completion = await openai.chat.completions.create({
      model,
      messages: history,
      temperature: 0.7,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "";
    history.push({ role: "assistant", content: reply });
    chatSessions.set(sessionId, history);

    res.json({ reply });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({
      error: "chat_failed",
      message: err?.message,
      status: err?.status,
      code: err?.code,
      type: err?.type,
    });
  }
});

const port = process.env.PORT || 5179;
app.listen(port, () => {
  console.log(`TTS proxy running on http://localhost:${port}`);
  console.log("Set OPENAI_API_KEY in your environment.");
});
