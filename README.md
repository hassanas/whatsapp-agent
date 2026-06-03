# WhatsApp AI Agent

![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111-009688?style=flat-square&logo=fastapi&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Web.js-25D366?style=flat-square&logo=whatsapp&logoColor=white)
![LangChain](https://img.shields.io/badge/LangChain-0.3-1C3C3C?style=flat-square&logo=chainlink&logoColor=white)
![AI](https://img.shields.io/badge/AI-OpenAI%20%7C%20Ollama-7C3AED?style=flat-square&logo=openai&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)

A Docker-based WhatsApp auto-reply project with two services:

- `bridge`: connects to WhatsApp Web and sends/receives messages
- `agent`: calls the LLM and returns reply text over HTTP

## Project structure

```text
whatsapp-agent/
├── config.yaml
├── docker-compose.yml
├── agent/
│   ├── Dockerfile
│   ├── llm_chain.py
│   ├── main.py
│   └── requirements.txt
└── bridge/
    ├── Dockerfile
    ├── index.js
    └── package.json
```

## Message Flow

```text
WhatsApp User sends message
        ↓
[bridge - index.js]
  • message / message_create event fires
  • Dedup check (processedMessageIds)
  • Group message? → ignore
  • fromMe? → ignore
  • isTargetMessage() → phone/JID matches target_contact?
      └── No match → log NON_TARGET_IGNORED, stop
      └── Match → continue
  • Log [IN] message
        ↓
  axios.post → http://agent:8000/message
        ↓
[agent - main.py]
  • FastAPI receives POST /message
  • calls get_reply(msg.body)
        ↓
[agent - llm_chain.py]
  • chain.invoke({ input, history })
        ↓
[LLM - Ollama/OpenAI]
  • system_prompt from config.yaml
  • conversation history (sliding window)
  • generates response
        ↓
  • sanitize_reply() — cleans robotic phrases
  • appends to history
  • returns reply_text
        ↓
[agent - main.py]
  • returns { reply: reply_text }
        ↓
[bridge - index.js]
  • receives reply from agent
  • normalizeReply() — trims whitespace
  • client.sendMessage(msg.from, replyText)
        ↓
WhatsApp User receives reply
```

## Prerequisites

Make sure these are installed on your machine:

- Docker
- Docker Compose plugin (`docker compose`)

## Configuration

### 1) Configure `config.yaml`

Edit `config.yaml` at the project root.

Current example:

```yaml
# config.yaml
target_contact: "+966567490345, +15551234567"   # Comma-separated E.164 numbers or WhatsApp JIDs
llm:
  provider: "openai"              # "openai" or "ollama"
  openai_model: "gpt-4o"
  ollama_model: "llama3"
  ollama_base_url: "http://localhost:11434"
openai_api_key: ""                # Or set as env var OPENAI_API_KEY
system_prompt: |
  You are a helpful assistant replying on behalf of the phone owner.
  Be concise and friendly. Never reveal you are an AI unless asked directly.
memory_window: 10                 # Number of messages to keep in context
bridge_port: 3000
agent_port: 8000
```

Important fields:

- `target_contact`: one or more comma-separated contacts allowed in strict mode
- `llm.provider`: use `openai` or `ollama`
- `openai_model`: model name for OpenAI mode
- `ollama_base_url`: only used if provider is `ollama`
- `system_prompt`: assistant behavior
- `memory_window`: chat history size

Examples:

```yaml
target_contact: "+966567490345"
target_contact: "+966567490345, +15551234567"
target_contact: "+966567490345, 1234567890@c.us"
```

### 2) Set your OpenAI API key

You can export it in your shell:

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Or create a local `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` and replace the placeholder value.

## Run the project

All commands below should be run from the project root:

```bash
cd "/home/hassan/D/work/agenticai/whatsapp-agent"
```

### Option 1: Strict mode

Only replies to the contact or contacts defined in `config.yaml` under `target_contact`.
If your own linked WhatsApp number is included there, strict mode also supports messaging yourself without needing debug mode.

```bash
docker compose up -d --build bridge
```

### Option 2: Debug mode

Accepts all private chats.

```bash
DEBUG_ACCEPT_ALL_PRIVATE=true docker compose up -d --build bridge
```

## First-time QR login

After starting the project, watch the bridge logs:

```bash
docker compose logs -f bridge
```

On first startup, the bridge will print a QR code in the terminal.

To link WhatsApp:

1. Open WhatsApp on your phone
2. Go to **Linked Devices**
3. Tap **Link a device**
4. Scan the QR code shown in the terminal

When login succeeds, logs should show messages similar to:

```text
[bridge] Authenticated with WhatsApp Web session
[bridge] Ready as <your-number>@c.us (<your-name>)
```

The login session is stored in the Docker volume `wwebjs_session`, so you usually do not need to rescan after restarts.

## View logs

### Bridge logs

```bash
docker compose logs -f bridge
```

### Agent logs

```bash
docker compose logs -f agent
```

### Both services

```bash
docker compose logs -f
```

## Stop the project

```bash
docker compose down
```

## Restart after code or config changes

```bash
docker compose up -d --build
```

If you only changed the bridge code:

```bash
docker compose up -d --build bridge
```

## How message routing works

### Strict mode

- replies only to the configured `target_contact` values from `config.yaml`
- ignores all group messages
- supports self-chat too if your own linked number is included in `target_contact`
- does not intentionally accept every private chat

### Debug mode

- replies to all private chats
- still ignores group messages

## Test checklist

### Strict mode test

1. Start strict mode
2. Send a message from one of the configured `target_contact` values
3. Check logs:

```bash
docker compose logs -f bridge
```

Expected flow:

```text
[IN]  Hello
[OUT] Hi there! How can I help you today?
[bridge] Sent WhatsApp message ...
[bridge] Ack ...
```

### Self-chat in strict mode

If your linked WhatsApp number is included in `target_contact`, you can message yourself in strict mode and it will still work.

Example:

```yaml
target_contact: "+966567490345"
```

Then start strict mode and message yourself in WhatsApp.

## Troubleshooting

### No QR code appears

Check bridge logs:

```bash
docker compose logs -f bridge
```

If you already authenticated before, the saved session may be reused and no QR will appear.

### QR scanned but no replies

Check whether the bridge is connected:

```text
[bridge] Authenticated with WhatsApp Web session
[bridge] Ready as ...
[bridge] Startup state check after 30s: state=CONNECTED
```

### API works but WhatsApp does not reply

Watch bridge logs and agent logs together:

```bash
docker compose logs -f bridge agent
```

If the bridge shows `[IN]` and `[OUT]` but no send confirmation, the problem is in the WhatsApp send path.

### Reset WhatsApp session

If authentication gets stuck and you want to relink the QR from scratch:

```bash
docker compose down -v
```

Then start again:

```bash
docker compose up -d --build bridge
```

Note: `down -v` removes the saved WhatsApp session volume.

## Useful commands summary

### Strict mode

```bash
cd "/home/hassan/D/work/agenticai/whatsapp-agent"
docker compose up -d --build bridge
```

### Debug mode

```bash
cd "/home/hassan/D/work/agenticai/whatsapp-agent"
DEBUG_ACCEPT_ALL_PRIVATE=true docker compose up -d --build bridge
```

### Logs

```bash
cd "/home/hassan/D/work/agenticai/whatsapp-agent"
docker compose logs -f bridge
```

### Stop

```bash
cd "/home/hassan/D/work/agenticai/whatsapp-agent"
docker compose down
```

