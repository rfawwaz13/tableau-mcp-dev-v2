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
    api_version: str = "3.27"  # sesuaikan dengan versi server Anda

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

    _UNKNOWN_FIELD_PATTERN = re.compile(r"Unknown Field:\s*(.+?)\s*\.", re.IGNORECASE)

    def _extract_unknown_field(self, error_body: str) -> str | None:
        """
        Tableau VizQL Data Service mengembalikan error seperti:
            {"errorCode":"400803","message":"Unknown Field: Branch Change."}
        ketika sebuah field (paling sering: field di 'filters', kadang calculated
        field yang cuma ada di worksheet/datasource lain) tidak dikenal oleh
        datasource yang di-query. Fungsi ini mengekstrak nama field-nya dari
        pesan error itu supaya bisa otomatis dibuang & di-retry.
        """
        try:
            body = json.loads(error_body)
            message = body.get("message", "")
        except (json.JSONDecodeError, AttributeError):
            message = error_body

        match = self._UNKNOWN_FIELD_PATTERN.search(message)
        return match.group(1) if match else None

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

    async def query_datasource(self, datasource_luid: str, query: dict) -> tuple[dict, list[str]]:
        """
        Menjalankan query VizQL terhadap sebuah published datasource.
        Lihat skema `query` (fields, filters, parameters) di dokumentasi
        VizQL Data Service.

        Kalau server menolak query karena field tertentu tidak dikenal
        (umum terjadi kalau filter dashboard menyertakan calculated field
        yang cuma ada di worksheet/datasource lain, bukan di datasource yang
        sedang di-query), field itu OTOMATIS DIBUANG dan query di-retry,
        alih-alih langsung gagal total. Ini penting karena kita memang
        sengaja "memaksa" semua filter dashboard ke setiap query — tidak
        semua datasource di dashboard punya field yang sama persis.

        Return: (hasil_json, daftar_field_yang_di-skip) supaya pemanggil bisa
        memberi tahu pengguna field mana saja yang diabaikan.
        """
        query = json.loads(json.dumps(query))  # deep copy, supaya aman dimutasi
        self._validate_query(query)

        url = f"{self.config.server}/api/v1/vizql-data-service/query-datasource"
        skipped_fields: list[str] = []
        max_attempts = 10  # jaring pengaman, jangan sampai loop tanpa henti

        for _ in range(max_attempts):
            body = {
                "datasource": {"datasourceLuid": datasource_luid},
                "query": query,
            }
            resp = await self._http.post(url, json=body, headers=self._auth_headers())
            if resp.status_code == 200:
                return resp.json(), skipped_fields

            unknown_field = self._extract_unknown_field(resp.text)
            if unknown_field and self._strip_field(query, unknown_field):
                skipped_fields.append(unknown_field)
                continue  # retry dengan query yang sudah dibersihkan

            # Bukan error "Unknown Field", atau tidak ada lagi yang bisa dibuang.
            raise TableauAPIError(f"query_datasource gagal ({resp.status_code}): {resp.text}")

        raise TableauAPIError(
            f"query_datasource tetap gagal setelah membuang {len(skipped_fields)} field "
            f"yang tidak dikenal ({', '.join(skipped_fields)}). Periksa query_json Anda."
        )

    async def get_datasource_metadata(self, datasource_luid: str) -> dict:
        url = f"{self.config.server}/api/v1/vizql-data-service/read-metadata"
        body = {"datasource": {"datasourceLuid": datasource_luid}}
        resp = await self._http.post(url, json=body, headers=self._auth_headers())
        if resp.status_code != 200:
            raise TableauAPIError(f"get_datasource_metadata gagal ({resp.status_code}): {resp.text}")
        return resp.json()
