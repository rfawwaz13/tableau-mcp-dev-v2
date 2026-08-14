"""
tableau_client.py
------------------
Wrapper tipis di atas Tableau REST API + VizQL Data Service.
Menangani sign-in (Personal Access Token), sign-out, dan beberapa
operasi umum: list workbooks, list datasources, list views,
get view data (CSV), dan query datasource (VizQL Data Service).

Dokumentasi resmi:
- REST API: https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref.htm
- VizQL Data Service: https://help.tableau.com/current/api/vizql-data-service/en-us/index.html
"""

from __future__ import annotations

import os
import json
import re
import httpx
from dataclasses import dataclass
from typing import Any, Optional


class TableauAuthError(Exception):
    pass


class TableauAPIError(Exception):
    pass


@dataclass
class TableauConfig:
    server: str            # contoh: https://my-tableau-server.com
    site_content_url: str  # nama site di URL Tableau, "" untuk Default site
    pat_name: str
    pat_secret: str
    api_version: str = "3.22"  # sesuaikan dengan versi server Anda

    @classmethod
    def from_env(cls) -> "TableauConfig":
        return cls(
            server=os.environ["TABLEAU_SERVER"].rstrip("/"),
            site_content_url=os.environ.get("TABLEAU_SITE", ""),
            pat_name=os.environ["TABLEAU_PAT_NAME"],
            pat_secret=os.environ["TABLEAU_PAT_SECRET"],
            api_version=os.environ.get("TABLEAU_API_VERSION", "3.22"),
        )


class TableauClient:
    """
    Contoh pemakaian:

        async with TableauClient(TableauConfig.from_env()) as tc:
            workbooks = await tc.list_workbooks()
    """

    def __init__(self, config: TableauConfig):
        self.config = config
        self._http = httpx.AsyncClient(timeout=60.0)
        self.token: Optional[str] = None
        self.site_id: Optional[str] = None
        self.user_id: Optional[str] = None
        # Cache field caption yang benar-benar ada per datasource (diisi
        # sekali per datasource_luid, dipakai untuk membuang field yang
        # jelas tidak dikenal SEBELUM query dikirim — lihat query_datasource.
        self._datasource_fields_cache: dict[str, Optional[set]] = {}

    # ---------- lifecycle ----------

    async def __aenter__(self) -> "TableauClient":
        await self.sign_in()
        return self

    async def __aexit__(self, *exc):
        await self.sign_out()
        await self._http.aclose()

    async def sign_in(self) -> None:
        url = f"{self.config.server}/api/{self.config.api_version}/auth/signin"
        body = {
            "credentials": {
                "personalAccessTokenName": self.config.pat_name,
                "personalAccessTokenSecret": self.config.pat_secret,
                "site": {"contentUrl": self.config.site_content_url},
            }
        }
        resp = await self._http.post(url, json=body, headers={"Accept": "application/json"})
        if resp.status_code != 200:
            raise TableauAuthError(f"Sign-in gagal ({resp.status_code}): {resp.text}")

        data = resp.json()["credentials"]
        self.token = data["token"]
        self.site_id = data["site"]["id"]
        self.user_id = data["user"]["id"]

    async def sign_out(self) -> None:
        if not self.token:
            return
        url = f"{self.config.server}/api/{self.config.api_version}/auth/signout"
        await self._http.post(url, headers=self._auth_headers())
        self.token = None

    def _auth_headers(self) -> dict:
        return {"X-Tableau-Auth": self.token or "", "Accept": "application/json"}

    async def _get(self, path: str, params: Optional[dict] = None) -> dict:
        url = f"{self.config.server}/api/{self.config.api_version}/sites/{self.site_id}{path}"
        resp = await self._http.get(url, headers=self._auth_headers(), params=params)
        if resp.status_code != 200:
            raise TableauAPIError(f"GET {path} gagal ({resp.status_code}): {resp.text}")
        return resp.json()

    # ---------- REST API: content discovery ----------

    async def list_workbooks(self, filter_expr: Optional[str] = None, page_size: int = 100) -> list[dict]:
        params = {"pageSize": page_size}
        if filter_expr:
            params["filter"] = filter_expr
        data = await self._get("/workbooks", params=params)
        return data.get("workbooks", {}).get("workbook", [])

    async def list_datasources(self, filter_expr: Optional[str] = None, page_size: int = 100) -> list[dict]:
        params = {"pageSize": page_size}
        if filter_expr:
            params["filter"] = filter_expr
        data = await self._get("/datasources", params=params)
        return data.get("datasources", {}).get("datasource", [])

    async def list_views(self, filter_expr: Optional[str] = None, page_size: int = 100) -> list[dict]:
        params = {"pageSize": page_size}
        if filter_expr:
            params["filter"] = filter_expr
        data = await self._get("/views", params=params)
        return data.get("views", {}).get("view", [])

    async def get_view_data_csv(self, view_id: str) -> str:
        """Ambil data CSV mentah dari sebuah view (mirip export data view)."""
        url = f"{self.config.server}/api/{self.config.api_version}/sites/{self.site_id}/views/{view_id}/data"
        resp = await self._http.get(url, headers=self._auth_headers())
        if resp.status_code != 200:
            raise TableauAPIError(f"get_view_data_csv gagal ({resp.status_code}): {resp.text}")
        return resp.text

    # ---------- VizQL Data Service: query terstruktur ke datasource ----------

    _VALID_FILTER_TYPES = {"SET", "MATCH", "QUANTITATIVE_NUMERICAL", "QUANTITATIVE_DATE", "DATE", "TOP"}
    _VALID_QUANTITATIVE_SUBTYPES = {"RANGE", "MIN", "MAX", "ONLY_NULL", "ONLY_NON_NULL"}

    def _validate_query(self, query: dict) -> None:
        """
        Validasi ringan sebelum request dikirim, supaya kesalahan skema filter
        (paling sering: filterType yang tidak valid, mis. "RANGE" dipakai
        langsung sebagai filterType padahal seharusnya jadi nilai
        quantitativeFilterType di dalam QUANTITATIVE_NUMERICAL/QUANTITATIVE_DATE)
        menghasilkan pesan error yang jelas dan bisa dikoreksi otomatis oleh
        LLM di percobaan berikutnya — bukan error 400 mentah dari Tableau.
        """
        for i, f in enumerate(query.get("filters", [])):
            filter_type = f.get("filterType")
            if filter_type not in self._VALID_FILTER_TYPES:
                raise TableauAPIError(
                    f"filters[{i}].filterType='{filter_type}' tidak valid. "
                    f"Nilai yang diterima Tableau VizQL Data Service HANYA: "
                    f"{sorted(self._VALID_FILTER_TYPES)}. "
                    f"Kalau maksudnya filter rentang, filterType yang benar adalah "
                    f"'QUANTITATIVE_NUMERICAL' (untuk angka) atau 'QUANTITATIVE_DATE' "
                    f"(untuk tanggal), lalu taruh 'RANGE' di dalam field "
                    f"'quantitativeFilterType', bukan di 'filterType'."
                )

            if filter_type in ("QUANTITATIVE_NUMERICAL", "QUANTITATIVE_DATE"):
                sub_type = f.get("quantitativeFilterType")
                if sub_type not in self._VALID_QUANTITATIVE_SUBTYPES:
                    raise TableauAPIError(
                        f"filters[{i}].quantitativeFilterType='{sub_type}' tidak valid "
                        f"untuk filterType='{filter_type}'. Nilai yang diterima: "
                        f"{sorted(self._VALID_QUANTITATIVE_SUBTYPES)}."
                    )

    # PENTING: greedy (.+) + anchor ke akhir string ($), BUKAN non-greedy
    # (.+?). Nama field/parameter Tableau bisa mengandung titik di
    # TENGAHNYA (mis. parameter "P.Age_Trend") — kalau non-greedy, regex
    # berhenti di titik PERTAMA yang ditemukan (cuma menangkap "P", bukan
    # "P.Age_Trend"), sehingga _strip_field/_strip_path gagal mencocokkan
    # dan self-healing tidak pernah terpicu. Greedy + $ memaksa regex
    # mengambil sebanyak mungkin lalu mundur secukupnya supaya titik
    # PENUTUP KALIMAT di ujung string yang dipakai sebagai batas, bukan
    # titik pertama yang kebetulan ada di tengah nama field.
    _UNKNOWN_FIELD_PATTERN = re.compile(r"Unknown Field:\s*(.+)\.\s*$", re.IGNORECASE)
    _UNRECOGNIZED_PATH_PATTERN = re.compile(
        r"Unrecognized field in request:\s*(.+)\.\s*$", re.IGNORECASE
    )
    _PATH_SEGMENT_PATTERN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(\[(\d+)\])?$")

    def _extract_unknown_field(self, error_body: str) -> str | None:
        """
        Tableau VizQL Data Service mengembalikan error seperti:
            {"errorCode":"400803","message":"Unknown Field: Branch Change."}
        ketika sebuah field (paling sering: field di 'filters', kadang calculated
        field yang cuma ada di worksheet/datasource lain, atau field turunan
        Parameter seperti "P.Age_Trend") tidak dikenal oleh datasource yang
        di-query. Fungsi ini mengekstrak nama field-nya dari pesan error itu
        supaya bisa otomatis dibuang & di-retry.
        """
        message = self._extract_error_message(error_body)
        match = self._UNKNOWN_FIELD_PATTERN.search(message)
        return match.group(1) if match else None

    def _extract_unrecognized_path(self, error_body: str) -> str | None:
        """
        Menangani error BERBEDA dari 'Unknown Field': ini soal STRUKTUR/skema
        query-nya sendiri yang ditolak, mis.:
            {"errorCode":"404934","message":"Unrecognized field in request: query->includeAllFields."}
        Terjadi kalau LLM menambahkan key yang tidak ada di skema VDS resmi
        (mis. mengarang parameter "includeAllFields" yang sebenarnya tidak
        pernah ada). Fungsi ini mengekstrak PATH key-nya (mis.
        "query->includeAllFields") supaya bisa dihapus otomatis & di-retry.
        """
        message = self._extract_error_message(error_body)
        match = self._UNRECOGNIZED_PATH_PATTERN.search(message)
        return match.group(1) if match else None

    @staticmethod
    def _extract_error_message(error_body: str) -> str:
        try:
            body = json.loads(error_body)
            return body.get("message", "")
        except (json.JSONDecodeError, AttributeError, TypeError):
            return error_body

    @staticmethod
    def _strip_field(query: dict, field_caption: str) -> bool:
        """
        Buang semua referensi ke field_caption dari query['filters'] (paling
        umum) dan query['fields'] (jaga-jaga). Return True kalau ada yang
        benar-benar dibuang, supaya pemanggil tahu retry ada gunanya.
        """
        removed = False

        new_filters = []
        for f in query.get("filters", []):
            if f.get("field", {}).get("fieldCaption") == field_caption:
                removed = True
                continue
            new_filters.append(f)
        query["filters"] = new_filters

        new_fields = []
        for fld in query.get("fields", []):
            if fld.get("fieldCaption") == field_caption:
                removed = True
                continue
            new_fields.append(fld)
        query["fields"] = new_fields

        return removed

    @classmethod
    def _parse_path_segment(cls, segment: str) -> tuple[str, int | None]:
        """'filters[0]' -> ('filters', 0); 'includeAllFields' -> ('includeAllFields', None)."""
        match = cls._PATH_SEGMENT_PATTERN.match(segment.strip())
        if not match:
            return segment.strip(), None
        key = match.group(1)
        idx = int(match.group(3)) if match.group(3) is not None else None
        return key, idx

    @classmethod
    def _strip_path(cls, query: dict, path: str) -> bool:
        """
        Hapus satu key di struktur `query` berdasarkan path dari pesan error,
        mis. "query->includeAllFields" atau "query->filters[0]->badKey".
        Segmen pertama ("query") merujuk ke root, jadi dilewati.
        Return True kalau ada key yang benar-benar terhapus.
        """
        segments = [s for s in path.split("->") if s.strip()]
        if segments and segments[0].strip().lower() == "query":
            segments = segments[1:]
        if not segments:
            return False

        node: Any = query
        for seg in segments[:-1]:
            key, idx = cls._parse_path_segment(seg)
            if not isinstance(node, dict) or key not in node:
                return False
            node = node[key]
            if idx is not None:
                if not isinstance(node, list) or not (0 <= idx < len(node)):
                    return False
                node = node[idx]

        last_key, last_idx = cls._parse_path_segment(segments[-1])
        if not isinstance(node, dict):
            return False

        if last_idx is not None:
            target = node.get(last_key)
            if isinstance(target, list) and 0 <= last_idx < len(target):
                del target[last_idx]
                return True
            return False

        if last_key in node:
            del node[last_key]
            return True
        return False

    @staticmethod
    def _normalize_caption(caption: str) -> str:
        """Normalisasi untuk pencocokan longgar: lowercase, buang spasi/underscore."""
        return caption.lower().replace(" ", "").replace("_", "")

    async def _get_known_field_captions(self, datasource_luid: str) -> Optional[dict]:
        """
        Ambil (dan cache) daftar fieldCaption yang BENAR-BENAR ada di sebuah
        datasource, lewat get_datasource_metadata. Dipakai untuk membuang
        field yang jelas tidak dikenal (paling sering: field turunan
        Parameter dashboard yang tidak berlaku untuk datasource tertentu)
        SEBELUM query pertama kali dikirim — supaya tidak perlu belasan
        round-trip "coba-gagal-buang satu-retry" seperti sebelumnya.

        Return dict {normalized_caption: original_caption}, BUKAN sekadar
        set caption asli — supaya pencocokan bisa case/format-insensitive.
        Ini penting karena PARAMETER_FIELD_MAP di tableau-extension.js diisi
        MANUAL oleh pengguna, dan gampang salah kapitalisasi/spasi (mis.
        menulis "mkpd_branch" padahal caption asli "Mkpd Branch") — tanpa
        normalisasi, field yang SEBENARNYA ADA bisa salah dibuang secara
        DIAM-DIAM (tanpa error), yang jauh lebih membingungkan daripada
        error biasa.

        Return None kalau gagal mengambil metadata (mis. error jaringan) —
        artinya "tidak tahu", dan query_datasource akan tetap jalan seperti
        biasa mengandalkan mekanisme retry reaktif sebagai fallback, BUKAN
        memblokir apa pun karena metadata gagal diambil.
        """
        if datasource_luid in self._datasource_fields_cache:
            return self._datasource_fields_cache[datasource_luid]

        try:
            metadata = await self.get_datasource_metadata(datasource_luid)
            # Skema respons VDS read-metadata: {"data": [{"fieldCaption": "...", ...}, ...]}
            entries = metadata.get("data", metadata) if isinstance(metadata, dict) else metadata
            lookup = {
                self._normalize_caption(e["fieldCaption"]): e["fieldCaption"]
                for e in entries
                if isinstance(e, dict) and e.get("fieldCaption")
            }
            self._datasource_fields_cache[datasource_luid] = lookup or None
            return self._datasource_fields_cache[datasource_luid]
        except Exception:  # noqa: BLE001 - metadata gagal diambil bukan alasan memblokir query
            self._datasource_fields_cache[datasource_luid] = None
            return None

    def _resolve_field_caption(self, caption: str, known_fields: dict) -> tuple[Optional[str], bool]:
        """
        Cocokkan `caption` ke daftar field yang benar-benar ada di datasource.
        Return (caption_yang_dipakai, ditemukan_lewat_normalisasi).
        - Match PERSIS -> (caption asli, False)
        - Match SETELAH dinormalisasi (beda kapitalisasi/spasi/underscore)
          -> (caption ASLI dari datasource — DIKOREKSI otomatis, True)
        - Tidak match sama sekali -> (None, False) -> field ini baru dibuang.
        """
        if caption in known_fields.values():
            return caption, False
        normalized = self._normalize_caption(caption)
        if normalized in known_fields:
            return known_fields[normalized], True
        return None, False

    async def query_datasource(self, datasource_luid: str, query: dict) -> tuple[dict, list[str]]:
        """
        Menjalankan query VizQL terhadap sebuah published datasource.
        Lihat skema `query` (fields, filters, parameters) di dokumentasi
        VizQL Data Service.

        Query ini SELF-HEALING lewat dua lapis:
        1. PROAKTIF: sebelum dikirim sama sekali, field di 'filters'/'fields'
           dicocokkan ke metadata datasource ini (di-cache per
           datasource_luid). Field yang cocok SETELAH dinormalisasi (beda
           kapitalisasi/spasi/underscore saja) DIKOREKSI otomatis ke caption
           yang benar — bukan dibuang. Field yang BENAR-BENAR tidak ada baru
           dibuang di sini, sebelum kirim sama sekali (menghindari belasan
           round-trip bolak-balik ke server).
        2. REAKTIF (fallback): kalau setelah itu server MASIH menolak karena
           field lain yang tidak tertangkap di metadata (mis. metadata basi/
           tidak lengkap), field itu dibuang & di-retry, sama seperti
           sebelumnya — lihat _extract_unknown_field / _extract_unrecognized_path.

        Return: (hasil_json, daftar_hal_yang_di-skip) supaya pemanggil bisa
        memberi tahu pengguna apa saja yang diabaikan.
        """
        query = json.loads(json.dumps(query))  # deep copy, supaya aman dimutasi
        self._validate_query(query)

        skipped: list[str] = []
        corrected: list[str] = []

        # --- Lapis 1: proaktif, sebelum kirim sama sekali ---
        known_fields = await self._get_known_field_captions(datasource_luid)
        if known_fields:
            kept_filters = []
            for f in query.get("filters", []):
                caption = f.get("field", {}).get("fieldCaption")
                if not caption:
                    kept_filters.append(f)
                    continue
                resolved, was_normalized = self._resolve_field_caption(caption, known_fields)
                if resolved is None:
                    skipped.append(f"field '{caption}' (dibuang proaktif, tidak ada di datasource ini)")
                    continue
                if was_normalized:
                    corrected.append(f"'{caption}' -> '{resolved}'")
                    f = dict(f)
                    f["field"] = dict(f["field"])
                    f["field"]["fieldCaption"] = resolved
                kept_filters.append(f)
            query["filters"] = kept_filters

            kept_output_fields = []
            for fld in query.get("fields", []):
                caption = fld.get("fieldCaption")
                if not caption:
                    kept_output_fields.append(fld)
                    continue
                resolved, was_normalized = self._resolve_field_caption(caption, known_fields)
                if resolved is None:
                    skipped.append(f"field '{caption}' (dibuang proaktif, tidak ada di datasource ini)")
                    continue
                if was_normalized:
                    corrected.append(f"'{caption}' -> '{resolved}'")
                    fld = dict(fld)
                    fld["fieldCaption"] = resolved
                kept_output_fields.append(fld)
            query["fields"] = kept_output_fields

            if corrected:
                print(f"[tableau_client] Auto-koreksi nama field (beda kapitalisasi/spasi): {'; '.join(corrected)}")

        url = f"{self.config.server}/api/v1/vizql-data-service/query-datasource"
        max_attempts = 15  # jaring pengaman lapis 2 (reaktif), jangan sampai loop tanpa henti

        for _ in range(max_attempts):
            body = {
                "datasource": {"datasourceLuid": datasource_luid},
                "query": query,
            }
            resp = await self._http.post(url, json=body, headers=self._auth_headers())
            if resp.status_code == 200:
                return resp.json(), skipped

            unknown_field = self._extract_unknown_field(resp.text)
            if unknown_field and self._strip_field(query, unknown_field):
                skipped.append(f"field '{unknown_field}'")
                continue  # retry dengan query yang sudah dibersihkan

            unrecognized_path = self._extract_unrecognized_path(resp.text)
            if unrecognized_path and self._strip_path(query, unrecognized_path):
                skipped.append(f"parameter '{unrecognized_path}'")
                continue  # retry dengan query yang sudah dibersihkan

            # Bukan error yang kita kenali, atau tidak ada lagi yang bisa dibuang.
            raise TableauAPIError(f"query_datasource gagal ({resp.status_code}): {resp.text}")

        raise TableauAPIError(
            f"query_datasource tetap gagal setelah membuang {len(skipped)} item "
            f"yang tidak dikenal ({', '.join(skipped)}). Periksa query_json Anda."
        )

    async def get_datasource_metadata(self, datasource_luid: str) -> dict:
        url = f"{self.config.server}/api/v1/vizql-data-service/read-metadata"
        body = {"datasource": {"datasourceLuid": datasource_luid}}
        resp = await self._http.post(url, json=body, headers=self._auth_headers())
        if resp.status_code != 200:
            raise TableauAPIError(f"get_datasource_metadata gagal ({resp.status_code}): {resp.text}")
        return resp.json()
