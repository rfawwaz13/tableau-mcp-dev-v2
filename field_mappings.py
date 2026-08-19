"""
field_mappings.py
-------------------
Helper untuk membaca field_mappings.json (panduan pemilihan field untuk LLM,
PER DATASOURCE — lihat file itu untuk skema & contoh) dan menyusunnya jadi
satu blok teks yang disisipkan ke SYSTEM_INSTRUCTION di backends/*.py.

Kenapa perlu ini (bukan cukup satu aturan global lewat env var FIELD_HINTS
seperti sebelumnya): dashboard makin banyak memakai BANYAK datasource yang
masing-masing punya konvensi penamaan kolom BERBEDA untuk konsep bisnis yang
sama (mis. "sales" -> field "Mkpd Net" di satu datasource, "Sales Net" di
datasource lain). Satu aturan global pasti SALAH untuk sebagian datasource
begitu jumlah konvensi penamaan lebih dari satu — itu yang menyebabkan LLM
memaksakan field dari datasource A ke datasource B dan gagal karena field
itu tidak ada di sana. File ini membiarkan admin memetakan panduan field
SECARA TERPISAH per nama datasource, dibaca ULANG OTOMATIS tiap giliran chat
(TANPA restart server) supaya admin bisa iterasi cepat saat menambah
datasource baru.
"""

from __future__ import annotations

import json
import os

_MAPPINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "field_mappings.json")


def _load_field_mappings() -> dict:
    """
    Baca field_mappings.json langsung dari disk SETIAP dipanggil (TANPA
    cache) — dipanggil paling sering sekali per pesan chat, jadi biayanya
    dapat diabaikan, dan ini menjamin perubahan pada file (admin sedang
    iterasi menambah datasource baru) SELALU langsung kepakai tanpa perlu
    restart server. Kalau file tidak ada / isinya tidak valid JSON,
    dianggap "tidak ada panduan apa pun" (fail-open), BUKAN error yang
    menghentikan apa pun.
    """
    try:
        with open(_MAPPINGS_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        return {
            "global": (raw.get("global") or "").strip(),
            "per_datasource": raw.get("per_datasource") or {},
        }
    except (json.JSONDecodeError, OSError, AttributeError):
        print(f"[field_mappings] Gagal membaca {_MAPPINGS_PATH}, mengabaikan (tidak ada panduan field khusus).")
        return {"global": "", "per_datasource": {}}


def build_field_hints_block() -> str:
    """
    Susun blok teks panduan field dari field_mappings.json, dikelompokkan
    per datasource, siap disisipkan ke SYSTEM_INSTRUCTION.

    Return string kosong kalau tidak ada panduan sama sekali (file tidak
    ada, atau per_datasource & global kosong dua-duanya) — supaya pemanggil
    bisa skip menambahkannya, tidak ada regresi untuk setup yang belum
    mengisi file ini.
    """
    mappings = _load_field_mappings()
    per_datasource = mappings["per_datasource"]
    global_hint = mappings["global"]

    entries = [
        (ds_name, (hint or "").strip())
        for ds_name, hint in per_datasource.items()
        if isinstance(hint, str) and hint.strip()
    ]

    if not entries and not global_hint:
        return ""

    lines = [
        "PANDUAN FIELD KHUSUS DARI ADMIN PER DATASOURCE (WAJIB DIIKUTI, "
        "MENGALAHKAN TEBAKANMU SENDIRI) — cocokkan nama datasource yang "
        "SEDANG kamu query (dari list_datasources/get_datasource_metadata, "
        "pencocokan boleh mendekati) ke daftar di bawah, lalu ikuti panduan "
        "untuk datasource itu SAJA. Kalau sebuah datasource TIDAK disebut "
        "di bawah, tidak ada panduan khusus untuknya — pakai aturan default "
        "di atas (hindari field berakhiran \"_all\"/\" All\" kecuali diminta "
        "eksplisit) seperti biasa."
    ]
    for ds_name, hint in entries:
        lines.append(f'- Datasource "{ds_name}": {hint}')

    if global_hint:
        lines.append(f"Panduan tambahan yang berlaku untuk SEMUA datasource: {global_hint}")

    return "\n".join(lines)
