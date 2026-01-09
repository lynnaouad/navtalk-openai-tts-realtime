# NavTalk Avatar + OpenAI TTS (Realtime Lip Sync) + AI Chat

This project is a simple demo with two pages:

- **TTS page (/index.html)**: type text -> OpenAI TTS (PCM) -> forwarded to NavTalk for lip sync
- **AI Chat page (/chat.html)**: text chat -> OpenAI chat -> auto-speak assistant replies through the avatar

## Prereqs

- Node.js 18+ (recommended)
- NavTalk API key + a valid `characterName`
- OpenAI API key

## Setup

### 1) Install server deps
```bash
npm install
```

### 2) Set OpenAI key
**Windows PowerShell**
```powershell
$env:OPENAI_API_KEY="YOUR_OPENAI_KEY"
```

**macOS/Linux**
```bash
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
```

### 3) Run the TTS proxy
```bash
npm run server
```

Check:
- http://localhost:5179/health  ->  { "ok": true }

### 4) Run the static site server
```bash
npm run web
```

Open:
- http://localhost:5178

Pages:
- http://localhost:5178/index.html  (TTS)
- http://localhost:5178/chat.html   (AI Chat)

## Notes / Troubleshooting

- Don't open `index.html` via `file:///...`. Use the web server. It avoids CSP/connect issues.
- The UI asks for NavTalk key: that's fine for local demo, but don't ship that in client code.
  In production, proxy NavTalk too.

### API endpoints (server)
- `POST http://localhost:5179/tts` body: `{ text, voice }` -> raw PCM bytes
- `POST http://localhost:5179/chat` body: `{ sessionId, message, model }` -> `{ reply }`

The chat endpoint stores conversation history in memory per `sessionId` (it resets on server restart).
