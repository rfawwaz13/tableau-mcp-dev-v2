"""
dashboard_filters.py
----------------------
Helper yang dipakai bersama oleh backends/gemini_backend.py dan
backends/openai_backend.py untuk MEMAKSA filter dashboard Tableau (dikirim
dari tableau-extension.js lewat WebSocket sebagai `context_filters`) supaya
selalu diterapkan ke setiap panggilan tool query_datasource — TIDAK
bergantung pada LLM menerjemahkan/mengulang filter itu sendiri dari teks.

Kenapa perlu ini (bukan cukup lewat prompt saja): LLM cenderung menerapkan
filter dashboard secara PARSIAL (hanya sebagian field) atau salah format,
terutama kalau field-nya banyak. Menyisipkan filter secara programatik di
sini menjamin konsistensi data yang ditarik Agent dengan yang tampil di
dashboard, terlepas dari seberapa bagus LLM "menurut" instruksinya.

Modul ini JUGA men-sanitasi SEMUA filter (baik dari dashboard maupun yang
disusun sendiri oleh LLM) sebelum dikirim ke Tableau, karena VizQL Data
Service menolak SET filter yang salah satu nilainya bukan string/boolean/
angka (mis. null, list bersarang, objek) dengan error 400 yang tidak bisa
diperbaiki otomatis oleh LLM kalau sumbernya adalah filter dashboard yang
memang di luar kendali LLM.

Modul ini JUGA otomatis MENGECUALIKAN filter dashboard untuk field yang
sedang dijadikan dimensi output/breakdown di query (lihat docstring
merge_dashboard_filters) — supaya permintaan seperti "top 5 kota by sales"
tidak dibatasi jadi 1 baris gara-gara filter dashboard "Kota = ALL" ikut
dipaksakan ke field yang sama yang justru ingin di-breakdown.
"""

from __future__ import annotations

import json
from typing import Any

# bool termasuk instance dari int di Python, jadi cukup taruh (str, bool, int, float).
_PRIMITIVE_TYPES = (str, bool, int, float)


def _sanitize_filters(filters: list[Any]) -> list[dict]:
    """
    Buang nilai non-primitif (null, list bersarang, objek/dict) dari setiap
    filter SET/MATCH, dan buang filter yang jadi tidak punya nilai valid
    sama sekali sesudahnya (daripada dikirim kosong dan tetap error).
    """
    sanitized: list[dict] = []

    for f in filters:
        if not isinstance(f, dict):
            continue

        filter_type = f.get("filterType")

        if filter_type == "SET":
            values = f.get("values", [])
            if not isinstance(values, list):
                continue
            clean_values = [v for v in values if isinstance(v, _PRIMITIVE_TYPES)]
            if not clean_values:
                # Semua nilai filter ini tidak valid -> filter ini dibuang
                # sepenuhnya, dianggap sama dengan "tidak ada filter" untuk
                # field tsb, daripada mengirim SET filter kosong ke Tableau.
                continue
            f = dict(f)
            f["values"] = clean_values

        elif filter_type == "QUANTITATIVE_NUMERICAL":
            if f.get("min") is None and f.get("max") is None:
                continue

        elif filter_type == "QUANTITATIVE_DATE":
            if f.get("minDate") is None and f.get("maxDate") is None:
                continue

        sanitized.append(f)

    return sanitized


def merge_dashboard_filters(query_json_str: str, dashboard_filters: list[dict[str, Any]]) -> str:
    """
    Ambil query_json (string JSON dari argumen tool query_datasource),
    lalu timpa/tambahkan filter dashboard ke dalamnya, dan SELALU sanitasi
    hasil akhirnya (lihat _sanitize_filters) sebelum dikembalikan.

    Filter dashboard SELALU otoritatif: kalau LLM sudah menambahkan filter
    untuk field yang sama, versi LLM dibuang dan diganti versi dashboard.

    PENGECUALIAN PENTING: filter dashboard untuk sebuah field TIDAK
    diterapkan kalau field itu SEDANG DIJADIKAN DIMENSI OUTPUT di query ini
    (ada di parameter 'fields'). Contoh: kalau dashboard punya filter
    "Mkpd Kota = ALL" tapi pertanyaan pengguna adalah "top 5 kota by sales"
    (field "Mkpd Kota" ada di 'fields' untuk breakdown per kota), memaksa
    filter "Kota = ALL" akan membuat hasilnya cuma 1 baris (baris agregat)
    alih-alih breakdown per kota — kontradiktif dengan tujuan query-nya
    sendiri. Jadi kalau sebuah field dipilih sebagai dimensi output, filter
    dashboard untuk field itu SENGAJA di-skip untuk query spesifik ini saja
    (filter dashboard lain yang tidak terkait tetap diterapkan seperti biasa).

    Field lain yang LLM tambahkan sendiri (untuk field yang TIDAK ada di
    dashboard_filters) tetap dipertahankan apa adanya (setelah disanitasi)
    — ini penting supaya LLM masih bisa menambah filter tambahan sesuai
    pertanyaan pengguna (mis. "kota apa saja di atas 5 miliar").

    Kalau query_json_str tidak valid JSON, dikembalikan apa adanya supaya
    tetap gagal secara normal di lapisan pemanggil (bukan disembunyikan
    di sini).
    """
    try:
        query = json.loads(query_json_str)
    except (json.JSONDecodeError, TypeError):
        return query_json_str

    if not isinstance(query, dict):
        return query_json_str

    existing_filters = query.get("filters", [])
    if not isinstance(existing_filters, list):
        existing_filters = []

    output_field_names = {
        fld.get("fieldCaption")
        for fld in query.get("fields", [])
        if isinstance(fld, dict) and fld.get("fieldCaption")
    }

    if dashboard_filters:
        # Field dashboard yang BENAR-BENAR akan diterapkan (bukan yang
        # di-skip karena jadi dimensi output) — hanya field inilah yang
        # boleh menimpa/menggantikan filter yang disusun LLM sendiri.
        overriding_field_names = {
            f.get("field", {}).get("fieldCaption")
            for f in dashboard_filters
            if isinstance(f, dict)
            and f.get("field", {}).get("fieldCaption")
            and f.get("field", {}).get("fieldCaption") not in output_field_names
        }
        kept_llm_filters = [
            f
            for f in existing_filters
            if not (isinstance(f, dict) and f.get("field", {}).get("fieldCaption") in overriding_field_names)
        ]
        # Filter dashboard TIDAK diterapkan untuk field yang sedang jadi
        # dimensi output (breakdown) di query ini.
        applicable_dashboard_filters = [
            f
            for f in dashboard_filters
            if isinstance(f, dict) and f.get("field", {}).get("fieldCaption") not in output_field_names
        ]
        merged = kept_llm_filters + applicable_dashboard_filters
    else:
        merged = existing_filters

    query["filters"] = _sanitize_filters(merged)
    return json.dumps(query)
