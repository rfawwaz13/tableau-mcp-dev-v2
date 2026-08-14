"""
gemini_client.py
-----------------
Client chat berbasis Gemini yang terhubung ke tableau_mcp_server.py lewat
protokol MCP (stdio transport), dan menggunakan Gemini function calling
untuk memanggil tools Tableau tersebut secara otomatis.

Install dependencies:
    pip install mcp google-genai python-dotenv

Jalankan:
    python gemini_client.py

Environment variables (lihat .env.example):
    GEMINI_API_KEY
    TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import AsyncExitStack

from dotenv import load_dotenv
from google import genai
from google.genai import types as genai_types
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

load_dotenv()

MODEL_NAME = "gemini-2.5-pro"  # ganti sesuai model Gemini yang ingin dipakai
SERVER_SCRIPT = os.path.join(os.path.dirname(__file__), "tableau_mcp_server.py")


def mcp_tools_to_gemini_tools(mcp_tools: list) -> list[genai_types.Tool]:
    """
    Mengonversi daftar tool MCP (nama, deskripsi, JSON schema input) menjadi
    format `Tool`/`FunctionDeclaration` yang dipahami Gemini function calling.
    """
    function_declarations = []
    for tool in mcp_tools:
        function_declarations.append(
            genai_types.FunctionDeclaration(
                name=tool.name,
                description=tool.description or "",
                parameters=_clean_schema(tool.inputSchema),
            )
        )
    return [genai_types.Tool(function_declarations=function_declarations)]


def _clean_schema(schema: dict) -> dict:
    """Gemini tidak menerima beberapa keyword JSON Schema (mis. 'title', '$schema')."""
    if not isinstance(schema, dict):
        return schema
    cleaned = {}
    for key, value in schema.items():
        if key in ("title", "$schema", "additionalProperties"):
            continue
        if isinstance(value, dict):
            cleaned[key] = _clean_schema(value)
        elif isinstance(value, list):
            cleaned[key] = [_clean_schema(v) if isinstance(v, dict) else v for v in value]
        else:
            cleaned[key] = value
    return cleaned


class TableauGeminiAgent:
    def __init__(self):
        self.genai_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        self.session: ClientSession | None = None
        self.exit_stack = AsyncExitStack()
        self.gemini_tools: list[genai_types.Tool] = []
        self.chat_history: list[genai_types.Content] = []
        # Melindungi self.session.call_tool dari concurrent access ketika
        # agent yang sama dipakai bergantian oleh banyak sesi web (lihat app.py).
        self.tool_lock = asyncio.Lock()

    async def connect(self):
        server_params = StdioServerParameters(
            command=sys.executable,
            args=[SERVER_SCRIPT],
            env=os.environ.copy(),
        )
        stdio_transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
        stdio, write = stdio_transport
        self.session = await self.exit_stack.enter_async_context(ClientSession(stdio, write))
        await self.session.initialize()

        tools_response = await self.session.list_tools()
        self.gemini_tools = mcp_tools_to_gemini_tools(tools_response.tools)
        print(f"[connected] {len(tools_response.tools)} tools tersedia: "
              f"{', '.join(t.name for t in tools_response.tools)}")

    async def ask(self, user_message: str, history: list | None = None) -> dict:
        """
        Kirim satu pesan user dan jalankan loop function-calling sampai
        Gemini memberi jawaban final.

        `history` opsional: list `genai_types.Content` yang dipakai/di-mutasi
        sebagai riwayat percakapan. Kalau tidak diberikan, pakai
        `self.chat_history` (dipakai oleh CLI di `main()`). Ini memungkinkan
        server web (app.py) menyimpan riwayat terpisah per sesi/user
        sementara tetap berbagi satu koneksi MCP + satu subprocess Tableau.

        Return dict: {"text": str, "tool_calls": [{"name": str, "args": dict}, ...]}
        """
        if history is None:
            history = self.chat_history

        history.append(
            genai_types.Content(role="user", parts=[genai_types.Part(text=user_message)])
        )

        tool_calls_log: list[dict] = []

        # Loop function-calling: Gemini boleh memanggil tool berkali-kali
        # sebelum memberi jawaban akhir.
        for _ in range(8):
            response = self.genai_client.models.generate_content(
                model=MODEL_NAME,
                contents=history,
                config=genai_types.GenerateContentConfig(tools=self.gemini_tools),
            )

            candidate = response.candidates[0]
            history.append(candidate.content)

            function_calls = [
                part.function_call for part in candidate.content.parts if part.function_call
            ]

            if not function_calls:
                final_text = "".join(
                    part.text for part in candidate.content.parts if part.text
                )
                return {"text": final_text, "tool_calls": tool_calls_log}

            response_parts = []
            for fc in function_calls:
                args = dict(fc.args)
                print(f"  -> memanggil tool: {fc.name}({args})")
                tool_calls_log.append({"name": fc.name, "args": args})

                async with self.tool_lock:
                    result = await self.session.call_tool(fc.name, args)

                result_text = "\n".join(
                    block.text for block in result.content if hasattr(block, "text")
                )
                response_parts.append(
                    genai_types.Part.from_function_response(
                        name=fc.name,
                        response={"result": result_text},
                    )
                )

            history.append(genai_types.Content(role="user", parts=response_parts))

        return {
            "text": "(berhenti: terlalu banyak pemanggilan tool berturut-turut)",
            "tool_calls": tool_calls_log,
        }

    async def close(self):
        await self.exit_stack.aclose()


async def main():
    agent = TableauGeminiAgent()
    await agent.connect()
    print("Ketik pertanyaan Anda tentang data Tableau (ketik 'exit' untuk keluar).\n")
    try:
        while True:
            user_message = input("Anda: ").strip()
            if user_message.lower() in ("exit", "quit"):
                break
            answer = await agent.ask(user_message)
            print(f"\nGemini: {answer}\n")
    finally:
        await agent.close()


if __name__ == "__main__":
    asyncio.run(main())
