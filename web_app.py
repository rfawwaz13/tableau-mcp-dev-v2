"""
web_app.py
-----------
Web app FastAPI: menyajikan UI chat statis (folder static/) dan sebuah
WebSocket endpoint yang menjembatani browser <-> agent_service.TableauAgentSession
(yang di baliknya menjalankan tableau_mcp_server.py sebagai subprocess MCP
dan memanggil Gemini untuk function calling).

Jalankan:
    uvicorn web_app:app --host 0.0.0.0 --port 8000 --timeout-graceful-shutdown 10

Lalu buka http://localhost:8000 di browser, atau embed URL tersebut
(via HTTPS reverse proxy saat production) ke dalam Tableau dashboard
lewat objek "Web Page".
"""

from __future__ import annotations

import json
import logging
import os
import sys
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from agent_service import TableauAgentSession, LLM_PROVIDER

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("web_app")

if sys.platform == "win32":
    # Silence bug lama & terdokumentasi di asyncio ProactorEventLoop Windows
    # (https://github.com/python/cpython/issues/83413): kalau koneksi
    # WebSocket di-reset paksa oleh client (mis. tab browser ditutup/
    # di-refresh tanpa handshake close yang rapi), _call_connection_lost
    # memanggil socket.shutdown() pada socket yang sudah mati dan melempar
    # ConnectionResetError yang TIDAK tertangkap oleh siapa pun -- event
    # loop cuma mencetaknya sebagai traceback lewat default exception
    # handler. Ini murni KOSMETIK (server tetap jalan normal, tidak crash),
    # tapi mengotori log. Kita TIDAK bisa pindah ke SelectorEventLoop untuk
    # menghindari bug ini karena tableau_mcp_server.py dijalankan sebagai
    # subprocess (lewat stdio_client MCP), dan di Windows subprocess asyncio
    # HANYA didukung oleh ProactorEventLoop -- jadi cukup silence exception
    # spesifik ini saja (workaround umum untuk bug ini).
    from asyncio.proactor_events import _ProactorBasePipeTransport

    _orig_call_connection_lost = _ProactorBasePipeTransport._call_connection_lost

    def _call_connection_lost_silenced(self, exc):
        try:
            _orig_call_connection_lost(self, exc)
        except ConnectionResetError:
            pass

    _ProactorBasePipeTransport._call_connection_lost = _call_connection_lost_silenced

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Menyimpan satu TableauAgentSession + objek WebSocket per koneksi (per
# tab/user), dikunci oleh session_id yang sama.
active_sessions: dict[str, TableauAgentSession] = {}
active_websockets: dict[str, WebSocket] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # SHUTDOWN: tutup semua koneksi WebSocket + sesi MCP yang masih aktif
    # SECARA EKSPLISIT. Tanpa ini, task websocket_endpoint yang sedang idle
    # (menunggu di `await websocket.receive_text()`) tidak akan pernah
    # selesai dengan sendirinya kalau client (mis. tab browser/Tableau)
    # tidak mengirim frame close duluan -- itulah penyebab uvicorn macet
    # tanpa batas di pesan "Waiting for background tasks to complete" saat
    # Ctrl+C. Menutup WebSocket di sini dari sisi server memaksa
    # receive_text() melempar WebSocketDisconnect, sehingga handler-nya
    # selesai dan subprocess MCP (tableau_mcp_server.py) ikut dimatikan
    # lewat agent.close() alih-alih jadi proses menggantung/orphan.
    for ws in list(active_websockets.values()):
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
    for agent in list(active_sessions.values()):
        try:
            await agent.close()
        except Exception:  # noqa: BLE001
            pass
    active_websockets.clear()
    active_sessions.clear()


app = FastAPI(title="Tableau Data Assistant", lifespan=lifespan)

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
    active_websockets[session_id] = websocket

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
                dashboard_datasources = payload.get("context_datasources", [])
            except (json.JSONDecodeError, KeyError):
                await websocket.send_json(
                    {"type": "error", "message": "Format pesan tidak valid. Kirim {\"message\": \"...\"}"}
                )
                continue

            async for event in agent.ask_stream(
                user_message, dashboard_context, dashboard_filters, dashboard_datasources
            ):
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
        active_websockets.pop(session_id, None)
