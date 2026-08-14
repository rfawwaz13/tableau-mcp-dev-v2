"""
agent_service.py
------------------
Factory tipis: memilih implementasi TableauAgentSession (Gemini atau
OpenAI) berdasarkan environment variable LLM_PROVIDER, lalu re-export
supaya kode pemanggil (web_app.py, gemini_client.py) tidak perlu tahu
atau berubah sama sekali soal LLM apa yang sedang dipakai.

Set di .env:
    LLM_PROVIDER=gemini     # default kalau tidak di-set
atau
    LLM_PROVIDER=openai

Menambah provider baru di masa depan tinggal:
    1. Buat backends/<nama>_backend.py dengan class TableauAgentSession
       yang method-nya identik (connect(), ask_stream(), close()).
    2. Tambahkan satu cabang elif di bawah.
"""

from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()

LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").strip().lower()

if LLM_PROVIDER == "gemini":
    from backends.gemini_backend import TableauAgentSession
elif LLM_PROVIDER == "openai":
    from backends.openai_backend import TableauAgentSession
else:
    raise ValueError(
        f"LLM_PROVIDER='{LLM_PROVIDER}' tidak dikenali. "
        f"Gunakan 'gemini' atau 'openai' di file .env Anda."
    )

__all__ = ["TableauAgentSession", "LLM_PROVIDER"]
