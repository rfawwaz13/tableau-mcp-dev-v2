"""
web_app.py
-----------
Web app FastAPI: menyajikan UI chat statis (folder static/) dan sebuah
WebSocket endpoint yang menjembatani browser <-> agent_service.TableauAgentSession
(yang di baliknya menjalankan tableau_mcp_server.py sebagai subprocess MCP
dan memanggil Gemini untuk function calling).

Jalankan:
    uvicorn web_app:app --host 0.0.0.0 --port 8000

Lalu buka http://localhost:8000 di browser, atau embed URL tersebut
(via HTTPS reverse proxy saat production) ke dalam Tableau dashboard
lewat objek "Web Page".
"""

from __future__ import annotations

import json
import logging
import os
import uuid

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agent_service import TableauAgentSession, LLM_PROVIDER

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("web_app")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

app = FastAPI(title="Tableau Data Assistant")

# Dibuka lebar untuk demo. Untuk production, ganti "*" dengan origin
# domain Tableau Server/Cloud Anda (mis. https://my-tableau-server.com)
# agar hanya dashboard tersebut yang boleh memanggil backend ini.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Menyimpan satu TableauAgentSession per koneksi WebSocket (per tab/user).
active_sessions: dict[str, TableauAgentSession] = {}


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "llm_provider": LLM_PROVIDER, "active_sessions": len(active_sessions)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())
    agent = TableauAgentSession()
    active_sessions[session_id] = agent

    try:
        tool_names = await agent.connect()
        await websocket.send_json({"type": "ready", "tools": tool_names, "llm_provider": LLM_PROVIDER})

        while True:
            raw = await websocket.receive_text()
            try:
                payload = json.loads(raw)
                user_message = payload["message"]
                dashboard_context = payload.get("context", "")
                dashboard_filters = payload.get("context_filters", [])
            except (json.JSONDecodeError, KeyError):
                await websocket.send_json(
                    {"type": "error", "message": "Format pesan tidak valid. Kirim {\"message\": \"...\"}"}
                )
                continue

            async for event in agent.ask_stream(user_message, dashboard_context, dashboard_filters):
                await websocket.send_json(event)

    except WebSocketDisconnect:
        logger.info("Client terputus (session %s)", session_id)
    except Exception:  # noqa: BLE001
        logger.exception("Kesalahan tak terduga pada session %s", session_id)
        try:
            await websocket.send_json({"type": "error", "message": "Terjadi kesalahan pada server."})
        except Exception:  # noqa: BLE001
            pass
    finally:
        await agent.close()
        active_sessions.pop(session_id, None)
