"""
tableau_mcp_server.py
----------------------
MCP Server custom untuk Tableau, dibangun dengan Python MCP SDK (FastMCP).
Menjalankan server ini lewat stdio, sehingga bisa dipasang ke client MCP
manapun (Claude Desktop, atau client custom berbasis Gemini di gemini_client.py).

Jalankan:
    python tableau_mcp_server.py

Environment variables yang dibutuhkan (lihat .env.example):
    TABLEAU_SERVER, TABLEAU_SITE, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET
"""

from __future__ import annotations

import json
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from tableau_client import TableauClient, TableauConfig

mcp = FastMCP("tableau-mcp")

# Satu instance client dipakai ulang selama server hidup (auth token di-cache).
_config = TableauConfig.from_env()
_client = TableauClient(_config)
_signed_in = False


async def _ensure_signed_in() -> TableauClient:
    global _signed_in
    if not _signed_in:
        await _client.sign_in()
        _signed_in = True
    return _client


@mcp.tool()
async def list_workbooks(filter_expr: Optional[str] = None) -> str:
    """
    Daftar workbook di site Tableau.
    filter_expr contoh: "name:eq:Superstore" atau "projectName:eq:Finance"
    """
    tc = await _ensure_signed_in()
    workbooks = await tc.list_workbooks(filter_expr=filter_expr)
    return json.dumps(workbooks, indent=2)


@mcp.tool()
async def list_datasources(filter_expr: Optional[str] = None) -> str:
    """Daftar published data source di site Tableau."""
    tc = await _ensure_signed_in()
    datasources = await tc.list_datasources(filter_expr=filter_expr)
    return json.dumps(datasources, indent=2)


@mcp.tool()
async def list_views(filter_expr: Optional[str] = None) -> str:
    """
    Daftar view (sheet/dashboard) di site Tableau.
    filter_expr contoh: "workbookName:eq:Revamp Sample Dummy3"
    """
    tc = await _ensure_signed_in()
    views = await tc.list_views(filter_expr=filter_expr)
    return json.dumps(views, indent=2)


@mcp.tool()
async def get_view_data(view_id: str) -> str:
    """Ambil data CSV mentah dari sebuah view Tableau berdasarkan view LUID."""
    tc = await _ensure_signed_in()
    return await tc.get_view_data_csv(view_id)


@mcp.tool()
async def get_datasource_metadata(datasource_luid: str) -> str:
    """Ambil metadata field (nama, tipe data, dimensi/measure) dari sebuah datasource."""
    tc = await _ensure_signed_in()
    result = await tc.get_datasource_metadata(datasource_luid)
    return json.dumps(result, indent=2)


@mcp.tool()
async def query_datasource(datasource_luid: str, query_json: str) -> str:
    """
    Jalankan query VizQL terstruktur ke sebuah published datasource.

    query_json adalah string JSON dengan skema:
    {
      "fields": [
        {"fieldCaption": "Category"},
        {"fieldCaption": "Sales", "function": "SUM", "fieldAlias": "Total Sales"}
      ],
      "filters": [ ... ]
    }

    ATURAN PENTING UNTUK "filterType" (SERING SALAH — BACA DULU SEBELUM QUERY):

    "filterType" di level atas HANYA BOLEH salah satu dari 6 nilai ini.
    TIDAK ADA nilai "RANGE" sebagai filterType — itu SELALU salah dan akan
    membuat request gagal dengan error "Could not resolve type id 'RANGE'".
    "RANGE" hanya valid sebagai isi field "quantitativeFilterType" DI DALAM
    filter numerik/tanggal (lihat poin 2 & 3 di bawah).

    1. "SET" — filter kategorikal berdasarkan daftar nilai diskrit:
       {"field": {"fieldCaption": "Region"}, "filterType": "SET",
        "values": ["West", "East"], "exclude": false}

    2. "QUANTITATIVE_NUMERICAL" — filter rentang/ambang angka. Field wajib
       "quantitativeFilterType": salah satu dari "RANGE" | "MIN" | "MAX" |
       "ONLY_NULL" | "ONLY_NON_NULL". Nilai batasnya di "min"/"max" (angka),
       BUKAN di "values":
       {"field": {"fieldCaption": "Sales"}, "filterType": "QUANTITATIVE_NUMERICAL",
        "quantitativeFilterType": "RANGE", "min": 1000, "max": 50000}

    3. "QUANTITATIVE_DATE" — sama seperti nomor 2 tapi untuk field bertanggal,
       nilai batasnya di "minDate"/"maxDate" (string tanggal "YYYY-MM-DD"),
       BUKAN "min"/"max":
       {"field": {"fieldCaption": "Order Date"}, "filterType": "QUANTITATIVE_DATE",
        "quantitativeFilterType": "RANGE", "minDate": "2024-01-01", "maxDate": "2024-12-31"}

    4. "DATE" — filter tanggal RELATIF terhadap hari ini/anchor (mis. "12 bulan
       terakhir"), field wajib "periodType" dan "dateRangeType" (LASTN/NEXTN/
       CURRENT/dst.), plus "rangeN" kalau dipakai LASTN/NEXTN:
       {"field": {"fieldCaption": "Order Date"}, "filterType": "DATE",
        "periodType": "MONTHS", "dateRangeType": "LASTN", "rangeN": 12}

    5. "MATCH" — filter pencocokan string (contains/startsWith/endsWith):
       {"field": {"fieldCaption": "Product Name"}, "filterType": "MATCH",
        "contains": "Chair"}

    6. "TOP" — filter N teratas/terbawah berdasarkan sebuah measure:
       {"field": {"fieldCaption": "Category"}, "filterType": "TOP",
        "direction": "TOP", "howMany": 5,
        "fieldToMeasure": {"fieldCaption": "Sales", "function": "SUM"}}

    Kalau ragu field mana yang bertipe tanggal vs angka vs kategorikal,
    panggil get_datasource_metadata dulu sebelum menyusun filter.
    """
    tc = await _ensure_signed_in()
    query = json.loads(query_json)
    try:
        result, skipped = await tc.query_datasource(datasource_luid, query)
    except Exception as exc:  # noqa: BLE001 - kirim error sebagai teks ke LLM, jangan crash
        return f"Error saat query_datasource: {exc}. Perbaiki query_json sesuai aturan filterType di atas, lalu coba lagi."

    output = json.dumps(result, indent=2)
    if skipped:
        note = (
            f"⚠️ PENTING — WAJIB kamu sebutkan ke pengguna, JANGAN dilewatkan: "
            f"{', '.join(skipped)} diabaikan otomatis dari query ini karena ditolak "
            f"server (field tidak dikenal di DATASOURCE INI SPESIFIK — kemungkinan "
            f"besar field itu hanya ada di worksheet lain yang memakai datasource "
            f"BERBEDA dalam dashboard yang sama, bukan bug). Query di atas TETAP "
            f"dijalankan tanpa filter tersebut, jadi hasilnya mungkin TIDAK SEPENUHNYA "
            f"cocok dengan tampilan dashboard untuk dimensi yang di-skip itu. Katakan ini "
            f"secara eksplisit ke pengguna (jangan cuma diam-diam melaporkan angkanya saja), "
            f"idealnya di awal jawabanmu.\n\n"
        )
        output = note + output
    return output


if __name__ == "__main__":
    # stdio transport -> cocok dipanggil sebagai subprocess oleh client MCP mana pun.
    mcp.run(transport="stdio")
