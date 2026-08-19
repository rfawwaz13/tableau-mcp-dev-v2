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

Modul ini JUGA men-scope filter dashboard PER DATASOURCE ASAL-nya (lihat
parse_datasource_names & _filter_applies_to_datasource). Dashboard dengan
banyak sub-page/tab yang masing-masing memakai datasource BERBEDA (mis.
sub-page "Online" dengan skema/konvensi berbeda dari sub-page "All"/
"Offline") rawan salah kalau filter dipaksakan secara GLOBAL by nama field:
dua datasource bisa punya field dengan nama sama tapi konvensi nilai
berbeda (contoh nyata: literal "ALL" sebagai baris rollup di datasource
ber-CUBE, yang TIDAK PERNAH ada di datasource non-CUBE) — kalau filter
semacam ini dipaksakan ke datasource yang salah, hasilnya 0 baris meski
field-nya sendiri valid (jadi TIDAK tertangkap oleh mekanisme
"field tidak dikenal" di tableau_client.py). Tiap filter dari
tableau-extension.js kini membawa properti opsional `sourceDatasources`
(daftar nama datasource asal worksheet yang berkontribusi filter itu) —
filter hanya dipaksakan ke query_datasource kalau target datasource-nya
cocok, atau kalau sourceDatasources kosong (mis. Parameter, yang levelnya
workbook bukan per-worksheet) sebagai fail-open/broadcast seperti perilaku
lama.

Modul ini JUGA membaca filter_exclusions.json (di root proyek, lihat file
itu untuk skema & contoh) supaya admin bisa MENGECUALIKAN field/parameter
tertentu dari pemaksaan filter secara manual — berguna untuk isolasi cepat
saat debug kasus "0 baris" yang akar masalahnya belum jelas field mana yang
bermasalah. File itu di-reload OTOMATIS berdasarkan mtime tiap kali
merge_dashboard_filters dipanggil, TANPA perlu restart server.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

# bool termasuk instance dari int di Python, jadi cukup taruh (str, bool, int, float).
_PRIMITIVE_TYPES = (str, bool, int, float)

_EXCLUSIONS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "filter_exclusions.json")
_EMPTY_EXCLUSIONS = {"global": [], "per_datasource": {}, "skip_all_dashboard_filters_for_datasource": []}


def _load_exclusions() -> dict:
    """
    Baca filter_exclusions.json langsung dari disk SETIAP dipanggil (TANPA
    cache) — dipanggil paling sering sekali per panggilan tool
    query_datasource, jadi biayanya dapat diabaikan dibanding round-trip
    jaringan ke Tableau yang menyusul, dan ini menjamin perubahan pada file
    (mis. saat admin sedang debug interaktif, edit-simpan-tanya lagi)
    SELALU langsung kepakai tanpa perlu restart server ataupun risiko cache
    basi karena resolusi mtime filesystem.

    Kalau file tidak ada / isinya tidak valid JSON, dianggap "tidak ada
    pengecualian apa pun" (fail-open), BUKAN error yang menghentikan query.
    """
    try:
        with open(_EXCLUSIONS_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        return {
            "global": raw.get("global") or [],
            "per_datasource": raw.get("per_datasource") or {},
            "skip_all_dashboard_filters_for_datasource": raw.get(
                "skip_all_dashboard_filters_for_datasource"
            )
            or [],
        }
    except (json.JSONDecodeError, OSError, AttributeError):
        print(f"[dashboard_filters] Gagal membaca {_EXCLUSIONS_PATH}, mengabaikan (tidak ada filter dikecualikan).")
        return _EMPTY_EXCLUSIONS


def _exclusion_entry_matches(entry: Any, field_caption: str, filter_dict: dict) -> bool:
    """
    Cocokkan SATU entry pengecualian dari filter_exclusions.json terhadap
    SATU filter dashboard. Entry boleh berupa:

    - string -> nama field, exclude filter ini UNCONDITIONAL (apa pun
      nilainya). Cocok untuk field yang memang tidak relevan sama sekali
      untuk datasource ini.
    - dict {"field": ..., "when_values_include": [...]} -> exclude HANYA
      kalau filter field ini bertipe SET dan salah satu nilai yang dipilih
      ADA di daftar when_values_include (mis. field tetap dipaksakan kalau
      pengguna pilih nilai lain seperti "Jakarta", tapi di-skip kalau
      nilainya termasuk "ALL"). Kalau dict tidak punya key
      "when_values_include" sama sekali, berlaku UNCONDITIONAL juga (sama
      seperti string biasa) — berguna kalau ingin menambahkan catatan lewat
      key lain nantinya tanpa mengubah perilaku.
    """
    if isinstance(entry, str):
        return entry == field_caption
    if isinstance(entry, dict) and entry.get("field") == field_caption:
        when_values = entry.get("when_values_include")
        if when_values is None:
            return True
        filter_values = filter_dict.get("values")
        if not isinstance(filter_values, list):
            return False
        return any(v in when_values for v in filter_values)
    return False


def _is_field_excluded(
    field_caption: Optional[str],
    target_datasource_name: Optional[str],
    exclusions: dict,
    filter_dict: dict,
) -> bool:
    """Cek satu filter terhadap 'global' dan 'per_datasource' di filter_exclusions.json."""
    if not field_caption:
        return False
    for entry in exclusions["global"]:
        if _exclusion_entry_matches(entry, field_caption, filter_dict):
            return True
    if target_datasource_name:
        for ds_name, entries in exclusions["per_datasource"].items():
            if not _datasource_name_matches(ds_name, target_datasource_name):
                continue
            for entry in entries or []:
                if _exclusion_entry_matches(entry, field_caption, filter_dict):
                    return True
    return False


def parse_datasource_names(list_datasources_result: str) -> dict[str, str]:
    """
    Uraikan hasil teks tool list_datasources (JSON list objek datasource dari
    Tableau REST API, tiap item punya "id" = datasourceLuid dan "name") jadi
    mapping {datasourceLuid: nama_datasource}.

    Dipakai backend untuk menerjemahkan `datasource_luid` di panggilan
    query_datasource kembali ke NAMA datasource-nya, supaya
    merge_dashboard_filters bisa mencocokkan filter yang sudah ditag per-
    datasource (lihat sourceDatasources) ke datasource yang BENAR-BENAR
    sedang di-query.

    Return {} kalau hasil tool tidak bisa diparse (mis. respons error dari
    server) — pemanggil harus menganggap itu sebagai "belum tahu", bukan
    error yang menghentikan apa pun.
    """
    try:
        items = json.loads(list_datasources_result)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(items, list):
        return {}
    names: dict[str, str] = {}
    for item in items:
        if isinstance(item, dict) and item.get("id") and item.get("name"):
            names[item["id"]] = item["name"]
    return names


def _datasource_name_matches(candidate: str, target: str) -> bool:
    """
    Bandingkan nama datasource secara toleran: sama persis (case-insensitive)
    ATAU salah satu adalah awalan dari yang lain — menangani variasi akhiran
    yang umum di Tableau Server (mis. "temp_member_kpi_plu_dummy" vs
    "temp_member_kpi_plu_dummy Extract").
    """
    c = candidate.strip().lower()
    t = target.strip().lower()
    if not c or not t:
        return False
    return c == t or c.startswith(t) or t.startswith(c)


def datasource_in_scope(target_datasource_name: Optional[str], allowed_datasource_names: list[str]) -> bool:
    """
    Cek apakah target_datasource_name (nama datasource yang SEDANG di-query,
    hasil resolve dari datasource_luid) cocok dengan salah satu nama di
    allowed_datasource_names — daftar "Datasource: ..." dari konteks
    dashboard SAAT INI (dikirim ulang oleh frontend di setiap pesan).

    Dipakai sebagai jaring pengaman DETERMINISTIK terhadap LLM yang keliru
    memilih datasourceLuid dari GILIRAN CHAT SEBELUMNYA (mis. riwayat
    percakapan masih menyimpan datasourceLuid dari saat pengguna berada di
    sub-page/dashboard lain sebelum berpindah) — instruksi lewat prompt saja
    terbukti tidak selalu cukup diandalkan LLM untuk kasus ini, jadi
    dipaksakan di sini seperti halnya mekanisme filter di atas.

    Fail-open (True) kalau allowed_datasource_names kosong (mis. mode Web
    Page tanpa embed dashboard, jadi tidak ada scope untuk dibatasi) atau
    target_datasource_name belum diketahui (mis. list_datasources belum
    pernah dipanggil) — supaya tidak ada regresi untuk kasus yang memang
    tidak butuh pembatasan ini.
    """
    if not allowed_datasource_names:
        return True
    if not target_datasource_name:
        return True
    return any(
        _datasource_name_matches(target_datasource_name, name)
        for name in allowed_datasource_names
        if isinstance(name, str)
    )


def _filter_applies_to_datasource(f: dict, target_datasource_name: Optional[str]) -> bool:
    """
    Tentukan apakah SATU filter dashboard boleh dipaksakan ke query yang
    menyasar `target_datasource_name`.

    - `sourceDatasources` kosong/None pada filter -> asalnya tidak terikat
      ke worksheet tertentu (mis. Parameter level-workbook) atau tidak
      diketahui -> selalu diterapkan (broadcast), sama seperti perilaku
      lama sebelum fitur scoping ini ada.
    - `target_datasource_name` None (backend belum tahu nama datasource
      yang di-query, mis. list_datasources belum pernah dipanggil di sesi
      ini) -> fail-open, terapkan semua filter seperti perilaku lama,
      supaya tidak ada regresi.
    - Selain itu -> filter HANYA diterapkan kalau target_datasource_name
      cocok (toleran) dengan salah satu nama di sourceDatasources filter
      ini. Inilah yang mencegah filter dari datasource lain (mis. filter
      dengan konvensi nilai spesifik seperti literal "ALL" milik datasource
      ber-CUBE) "bocor" ke datasource lain yang skemanya berbeda.
    """
    source_datasources = f.get("sourceDatasources")
    if not source_datasources:
        return True
    if not target_datasource_name:
        return True
    return any(
        _datasource_name_matches(name, target_datasource_name)
        for name in source_datasources
        if isinstance(name, str)
    )


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

        # `sourceDatasources` adalah metadata INTERNAL (dipakai
        # _filter_applies_to_datasource untuk scoping, lihat
        # merge_dashboard_filters) — bukan bagian dari skema filter VDS
        # resmi, jadi harus dibuang sebelum dikirim ke Tableau.
        if "sourceDatasources" in f:
            f = {k: v for k, v in f.items() if k != "sourceDatasources"}

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


def merge_dashboard_filters(
    query_json_str: str,
    dashboard_filters: list[dict[str, Any]],
    target_datasource_name: Optional[str] = None,
) -> str:
    """
    Ambil query_json (string JSON dari argumen tool query_datasource),
    lalu timpa/tambahkan filter dashboard ke dalamnya, dan SELALU sanitasi
    hasil akhirnya (lihat _sanitize_filters) sebelum dikembalikan.

    `target_datasource_name` (opsional) adalah nama datasource yang SEDANG
    di-query (di-resolve pemanggil dari datasource_luid, lihat
    parse_datasource_names) — dipakai untuk membuang dashboard_filters yang
    sourceDatasources-nya tidak cocok dengan datasource ini SEBELUM proses
    override di bawah berjalan (lihat _filter_applies_to_datasource). Kalau
    None atau filter tidak ditag sourceDatasources sama sekali, filter tetap
    diterapkan seperti biasa (fail-open, tidak ada regresi untuk dashboard
    single-datasource).

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

    exclusions = _load_exclusions()

    # "Matikan total" untuk datasource ini via filter_exclusions.json ->
    # jangan paksakan filter dashboard APA PUN, LLM tetap bebas menambah
    # filter sendiri kalau diminta pengguna. Berguna untuk isolasi cepat
    # saat debug 0-baris.
    skip_all = any(
        _datasource_name_matches(name, target_datasource_name)
        for name in exclusions["skip_all_dashboard_filters_for_datasource"]
        if target_datasource_name and isinstance(name, str)
    )

    # Buang dulu filter dashboard yang tidak relevan untuk datasource yang
    # SEDANG di-query ini (lihat docstring _filter_applies_to_datasource),
    # DAN field yang secara manual dikecualikan lewat filter_exclusions.json
    # — SEBELUM logika override/exclude-breakdown di bawah berjalan, supaya
    # filter dari datasource lain / field yang dikecualikan tidak ikut
    # menimpa filter LLM ataupun ikut dihitung sebagai "field yang jadi
    # dimensi output".
    if skip_all:
        print(
            f"[dashboard_filters] '{target_datasource_name}' ada di "
            f"skip_all_dashboard_filters_for_datasource (filter_exclusions.json) "
            f"-> SEMUA filter dashboard dilewati untuk query ini."
        )
        scoped_dashboard_filters: list[dict] = []
    else:
        excluded_field_names = [
            f.get("field", {}).get("fieldCaption")
            for f in dashboard_filters
            if isinstance(f, dict)
            and _filter_applies_to_datasource(f, target_datasource_name)
            and _is_field_excluded(f.get("field", {}).get("fieldCaption"), target_datasource_name, exclusions, f)
        ]
        if excluded_field_names:
            print(
                f"[dashboard_filters] Field dikecualikan via filter_exclusions.json "
                f"untuk datasource '{target_datasource_name}': {excluded_field_names}"
            )

        scoped_dashboard_filters = [
            f
            for f in dashboard_filters
            if isinstance(f, dict)
            and _filter_applies_to_datasource(f, target_datasource_name)
            and not _is_field_excluded(f.get("field", {}).get("fieldCaption"), target_datasource_name, exclusions, f)
        ]

    if scoped_dashboard_filters:
        print(
            f"[dashboard_filters] Filter dashboard dipaksakan ke datasource "
            f"'{target_datasource_name}': "
            f"{[f.get('field', {}).get('fieldCaption') for f in scoped_dashboard_filters]}"
        )
        # Field dashboard yang BENAR-BENAR akan diterapkan (bukan yang
        # di-skip karena jadi dimensi output) — hanya field inilah yang
        # boleh menimpa/menggantikan filter yang disusun LLM sendiri.
        overriding_field_names = {
            f.get("field", {}).get("fieldCaption")
            for f in scoped_dashboard_filters
            if f.get("field", {}).get("fieldCaption")
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
            for f in scoped_dashboard_filters
            if f.get("field", {}).get("fieldCaption") not in output_field_names
        ]
        merged = kept_llm_filters + applicable_dashboard_filters
    else:
        merged = existing_filters

    query["filters"] = _sanitize_filters(merged)
    return json.dumps(query)
