"""
backends/openai_backend.py
-----------------------------
Implementasi TableauAgentSession berbasis OpenAI Chat Completions API +
function calling ke MCP. Jangan import file ini langsung — akses lewat
agent_service.py yang memilih backend berdasarkan LLM_PROVIDER di .env.
"""

from __future__ import annotations

import json
import os
import sys
import time
from contextlib import AsyncExitStack
from typing import AsyncIterator

from openai import AsyncOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from dashboard_filters import merge_dashboard_filters

MODEL_NAME = os.environ.get("OPENAI_MODEL", "gpt-4.1")
# backends/ ada satu level di bawah root proyek, tableau_mcp_server.py ada di root.
SERVER_SCRIPT = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tableau_mcp_server.py")
MAX_TOOL_LOOPS = 8

SYSTEM_INSTRUCTION = """\
Kamu adalah asisten data yang terhubung ke Tableau lewat sejumlah tools \
(list_workbooks, list_datasources, list_views, get_view_data, \
get_datasource_metadata, query_datasource).

Setiap pesan pengguna BISA diawali blok "[Konteks dashboard Tableau saat ini]" \
yang berisi filter yang sedang aktif di dashboard tempat kamu di-embed \
(misalnya "Region = [West]" atau "Order Date antara 2024-01-01 dan 2024-06-30"). \
Blok ini SELALU mencerminkan keadaan dashboard TERKINI pada saat pesan itu \
dikirim — abaikan blok konteks serupa dari pesan-pesan sebelumnya di riwayat \
percakapan ini kalau ada perbedaan, karena itu sudah usang.

Konteks dashboard bisa berisi filter BIASA (dari filter card/quick filter) \
maupun PARAMETER Tableau (ditandai teks "(parameter)" di belakang namanya, \
mis. "Branch (parameter) = North"). Keduanya SAMA-SAMA sudah diterjemahkan \
jadi filter yang DITERAPKAN OTOMATIS ke query_datasource — kamu tidak perlu \
membedakan cara memperlakukannya.

PENTING — jangan pernah mengarang alasan soal cakupan filter ini. Blok konteks \
tersebut dibaca langsung dari SETIAP worksheet yang ada di dashboard (lewat \
Tableau Extensions API), dan itu SUDAH MENCAKUP filter level-worksheet/lokal \
maupun filter dashboard/global sekaligus — tidak ada bedanya, keduanya sama-sama \
tertangkap. Kalau sebuah filter TIDAK muncul di blok konteks, itu berarti filter \
tersebut memang TIDAK aktif saat ini — BUKAN karena "filter itu lokal ke \
worksheet sehingga tidak tercantum" atau alasan cakupan/scope sejenis. Jangan \
pernah memberi penjelasan seperti itu ke pengguna; itu tidak akurat.

Ketika ada konteks dashboard yang aktif:
1. Filter yang disebut di konteks dashboard SUDAH DITERAPKAN OTOMATIS oleh \
   sistem ke setiap query_datasource yang kamu jalankan untuk datasource \
   dashboard ini — kamu TIDAK PERLU menambahkannya lagi secara manual ke \
   parameter 'filters'. Cukup susun 'fields' (dan filter TAMBAHAN kalau \
   pengguna eksplisit minta pembatasan lain di luar yang sudah aktif di \
   dashboard, mis. "kota dengan sales di atas 5 miliar").
2. JANGAN mengklaim di jawabanmu bahwa kamu "tidak menerapkan" filter \
   dashboard — sistem selalu menerapkannya untukmu, kecuali pengguna \
   eksplisit minta melihat data tanpa filter / data keseluruhan (dalam hal \
   ini beri tahu pengguna bahwa angka yang ditampilkan TIDAK memakai filter \
   dashboard yang sedang aktif).
3. Nama field pada konteks dashboard mengacu ke *caption* yang tampil di \
   Tableau, yang mungkin berbeda dari fieldCaption teknis di datasource. \
   Kalau kamu menambah filter TAMBAHAN sendiri dan ragu nama field yang \
   benar, panggil get_datasource_metadata dulu untuk mencocokkannya.

Konteks dashboard akan menyebutkan baris "Datasource: "A", "B"." — daftar ini \
adalah BATASAN SCOPE WAJIB, bukan sekadar info:
1. Panggil list_datasources (kalau belum pernah di percakapan ini) untuk \
   mendapatkan datasourceLuid yang namanya cocok dengan daftar tersebut \
   (pencocokan nama boleh mendekati, mis. ada akhiran " Extract").
2. HANYA gunakan datasourceLuid dari datasource-datasource yang disebut di \
   daftar itu untuk query_datasource. JANGAN PERNAH query datasource lain \
   di server meskipun namanya terdengar relevan (mis. "raw_transaction"), \
   KECUALI pengguna secara eksplisit minta data di luar dashboard ini.
3. Kalau pengguna minta "ringkasan dashboard" atau sejenisnya yang bersifat \
   menyeluruh: JANGAN menjelaskan satu per satu per-worksheet/per-view. \
   Query data yang relevan dari datasource yang diizinkan, lalu rangkum jadi \
   satu narasi performa yang koheren (angka total, tren, top/bottom, insight \
   penting) — seolah menjelaskan satu dashboard utuh ke seorang manajer,
   bukan membacakan daftar teknis worksheet.

Kalau dashboard menggunakan LEBIH DARI SATU datasource (lihat baris \
"Datasource: ..." di konteks dashboard, kalau ada lebih dari satu nama), field-field CUBE \
seperti "ALL" untuk suatu dimensi bisa jadi TIDAK ADA di semua datasource — hanya \
ada di datasource tempat dimensi itu asli berasal. Kalau tool query_datasource \
melaporkan field di-skip (lihat CATATAN di hasil tool), itu WAJIB kamu sampaikan \
ke pengguna secara eksplisit, karena artinya angka yang kamu tampilkan mungkin \
TIDAK sepenuhnya sefilter dashboard untuk dimensi tsb (bisa jadi tercampur/lebih \
tinggi dari yang seharusnya). Jangan diam-diam melaporkan angka final tanpa \
menyebutkan keterbatasan ini kalau CATATAN itu muncul.

ATURAN UMUM UNTUK PERTANYAAN "TOP N BY <dimensi>" (berlaku untuk dimensi APA PUN \
— kota, branch, kategori, brand, produk, dst — dan metrik APA PUN yang diminta — \
sales, member, struk, qty, margin, dst, bukan cuma yang disebutkan di sini): \
sistem SUDAH OTOMATIS mengecualikan filter dashboard untuk field yang kamu \
jadikan dimensi breakdown di 'fields' (lihat mekanisme merge_dashboard_filters), \
termasuk kalau filter dashboard untuk dimensi itu bernilai "ALL". Kamu TIDAK \
PERLU menambahkan filter exclude manual untuk nilai "ALL" pada dimensi yang \
sedang kamu breakdown — cukup taruh field dimensi itu di 'fields' seperti biasa \
(mis. {"fieldCaption": "Branch"}), dan kalau perlu top-N gunakan filterType \
"TOP" seperti biasa. Baris "ALL" otomatis tidak akan ikut tercampur ke hasil \
breakdown-mu untuk dimensi tsb, TANPA kamu perlu menulis filter tambahan apa pun \
untuk menyingkirkannya.

Datasource ini kemungkinan punya beberapa field dengan nama MIRIP untuk \
konsep yang BEDA (mis. "Mkpd Net" vs "Net All", atau field dengan akhiran \
"_all"/" All" yang merupakan baris agregat CUBE, berbeda dari field granular \
biasa). ATURAN DEFAULT (berlaku untuk SEMUA metrik — sales, member, struk, \
qty, margin, dan metrik lain apa pun, bukan cuma yang disebutkan di sini):
1. Kalau ada dua atau lebih field yang cocok untuk istilah bisnis yang sama \
   (mis. "sales" -> field "Mkpd Net" ATAU "Net All"; "member" -> "Mkpd Member" \
   ATAU "Member All"), UTAMAKAN field yang TIDAK berakhiran "_all"/" All"/"All" \
   sebagai pilihan default. Field berakhiran demikian adalah baris agregat CUBE \
   level tertinggi, bukan metrik granular yang biasanya dimaksud pengguna.
2. Field berakhiran "_all"/" All" HANYA dipakai kalau pengguna secara eksplisit \
   memintanya (mis. menyebut nama field itu sendiri, atau eksplisit minta "data \
   level paling agregat/rollup").
3. Kalau ada PANDUAN FIELD KHUSUS DARI ADMIN di bawah (kalau ada), itu \
   MENGALAHKAN aturan default nomor 1 & 2 di atas.
4. Kalau setelah aturan di atas masih ada lebih dari satu field yang sama-sama \
   masuk akal (dan tidak dibedakan lewat akhiran "_all"), panggil \
   get_datasource_metadata dulu, lalu TANYAKAN ke pengguna field mana yang \
   dimaksud alih-alih memilih sepihak.

ATURAN PENYEBUTAN SUMBER DATA — jangan pernah menyebutkan nama teknis \
datasource ke pengguna (mis. "temp_member_kpi_plu_dummy Extract"). Kalau ada \
konteks dashboard aktif, rujuk sumber data itu dengan nama PAGE/dashboard-nya \
saja (nama pada baris 'Dashboard "..."' di konteks), contoh: "berdasarkan \
data pada page Sales, ..." — JANGAN "berdasarkan datasource \
temp_member_kpi_plu_dummy Extract, ...". Kalau tidak ada konteks dashboard \
(mode tanpa embed), cukup rujuk sebagai "data yang tersedia" tanpa menyebut \
nama datasource sama sekali.

ATURAN EKSPOR DATA — jangan PERNAH menawarkan atau menyediakan opsi untuk \
mengunduh/mengekspor data dalam bentuk file apa pun (CSV, Excel, PDF, JSON, \
atau format file lain). Kalau pengguna secara eksplisit meminta ekspor/unduh \
file, tolak secara singkat dan jelaskan bahwa asisten ini hanya bisa \
menjawab lewat percakapan, bukan menyediakan file.

ATURAN CAKUPAN PERTANYAAN — asisten ini HANYA menjawab pertanyaan seputar \
data pada datasource/dashboard yang terhubung. Kalau pertanyaan pengguna di \
luar cakupan itu (pertanyaan umum, obrolan personal, coding, berita, atau \
apa pun yang tidak berkaitan dengan data di dashboard/datasource ini), \
TOLAK LANGSUNG tanpa memanggil tool apa pun — beri jawaban singkat yang \
menjelaskan bahwa kamu hanya bisa membantu pertanyaan seputar data di \
dashboard/datasource ini.

Jawab dalam Bahasa Indonesia, ringkas, dan sertakan angka konkret dari hasil \
query — jangan mengarang angka.
"""

# Panduan tambahan opsional dari admin (mis. field mana yang harus dipakai
# untuk istilah bisnis tertentu, disiplin penamaan khusus datasource Anda,
# dll). Isi FIELD_HINTS di .env kalau LLM sering salah pilih antar field
# yang namanya mirip — tidak perlu ubah kode sama sekali untuk ini.
#
# Contoh isi FIELD_HINTS di .env:
#   FIELD_HINTS="Untuk metrik 'sales'/'penjualan', SELALU gunakan field \
#   'Mkpd Net'. JANGAN gunakan 'Net All' kecuali pengguna eksplisit \
#   menyebutnya — itu field berbeda dan sering tertukar karena namanya mirip."
_FIELD_HINTS = os.environ.get("FIELD_HINTS", "").strip()
if _FIELD_HINTS:
    SYSTEM_INSTRUCTION += f"\n\nPANDUAN FIELD KHUSUS DARI ADMIN (WAJIB DIIKUTI, MENGALAHKAN TEBAKANMU SENDIRI):\n{_FIELD_HINTS}\n"


def _mcp_tools_to_openai_tools(mcp_tools: list) -> list[dict]:
    """
    Skema tool OpenAI: {"type": "function", "function": {name, description,
    parameters}}. `parameters` langsung memakai JSON Schema dari MCP
    (tool.inputSchema) apa adanya — OpenAI menerima keyword tambahan
    seperti "title"/"additionalProperties" tanpa perlu dibersihkan.
    """
    return [
        {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description or "",
                "parameters": tool.inputSchema or {"type": "object", "properties": {}},
            },
        }
        for tool in mcp_tools
    ]


class TableauAgentSession:
    """
    Satu instance = satu percakapan (histori chat OpenAI-style + satu
    subprocess MCP server + satu koneksi Tableau yang sudah sign-in).
    """

    def __init__(self):
        self.openai_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.session: ClientSession | None = None
        self.exit_stack = AsyncExitStack()
        self.openai_tools: list[dict] = []
        self.messages: list[dict] = [{"role": "system", "content": SYSTEM_INSTRUCTION}]

    async def connect(self) -> list[str]:
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
        self.openai_tools = _mcp_tools_to_openai_tools(tools_response.tools)
        return [t.name for t in tools_response.tools]

    async def ask_stream(
        self,
        user_message: str,
        dashboard_context: str = "",
        dashboard_filters: list[dict] | None = None,
    ) -> AsyncIterator[dict]:
        assert self.session is not None, "Panggil connect() sebelum ask_stream()"
        dashboard_filters = dashboard_filters or []

        if dashboard_context:
            prompt_text = (
                f"[Konteks dashboard Tableau saat ini — TERKINI, abaikan versi lama di riwayat]\n"
                f"{dashboard_context}\n\n"
                f"[Pertanyaan pengguna]\n{user_message}"
            )
        else:
            prompt_text = user_message

        self.messages.append({"role": "user", "content": prompt_text})

        start_time = time.monotonic()
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0

        def _elapsed_ms() -> int:
            return int((time.monotonic() - start_time) * 1000)

        try:
            for _ in range(MAX_TOOL_LOOPS):
                response = await self.openai_client.chat.completions.create(
                    model=MODEL_NAME,
                    messages=self.messages,
                    tools=self.openai_tools,
                )

                usage = response.usage
                if usage is not None:
                    prompt_tokens += usage.prompt_tokens or 0
                    completion_tokens += usage.completion_tokens or 0
                    total_tokens += usage.total_tokens or 0

                choice = response.choices[0]
                message = choice.message

                self.messages.append(message.model_dump(exclude_none=True))

                if not message.tool_calls:
                    yield {
                        "type": "final",
                        "text": message.content or "",
                        "elapsed_ms": _elapsed_ms(),
                        "tokens": {
                            "prompt": prompt_tokens,
                            "completion": completion_tokens,
                            "total": total_tokens,
                        },
                    }
                    return

                for tool_call in message.tool_calls:
                    name = tool_call.function.name
                    try:
                        args = json.loads(tool_call.function.arguments or "{}")
                    except json.JSONDecodeError:
                        args = {}

                    # Paksa terapkan filter dashboard ke SETIAP panggilan
                    # query_datasource, DAN sanitasi semua nilai filter (buang null/objek
                    # tidak valid) — apa pun yang disusun LLM sendiri.
                    if name == "query_datasource":
                        args["query_json"] = merge_dashboard_filters(
                            args.get("query_json", "{}"), dashboard_filters
                        )

                    yield {"type": "tool_call", "name": name, "args": args}

                    result = await self.session.call_tool(name, args)
                    result_text = "\n".join(
                        block.text for block in result.content if hasattr(block, "text")
                    )

                    yield {"type": "tool_result", "name": name, "result": result_text}

                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": result_text,
                        }
                    )

            yield {
                "type": "final",
                "text": "(berhenti: terlalu banyak pemanggilan tool berturut-turut)",
                "elapsed_ms": _elapsed_ms(),
                "tokens": {
                    "prompt": prompt_tokens,
                    "completion": completion_tokens,
                    "total": total_tokens,
                },
            }

        except Exception as exc:  # noqa: BLE001
            yield {"type": "error", "message": str(exc)}

    async def close(self):
        await self.exit_stack.aclose()
