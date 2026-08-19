# Tableau Data Assistant — Gemini + MCP + Web Chat

Paket lengkap end-to-end:

1. **`tableau_client.py`** — wrapper REST API + VizQL Data Service Tableau (auth PAT, list workbook/datasource/view, query datasource).
2. **`tableau_mcp_server.py`** — membungkus wrapper di atas jadi **MCP tools** (`@mcp.tool()`), dijalankan lewat stdio.
3. **`agent_service.py`** — **factory**: memilih backend LLM (Gemini atau OpenAI) berdasarkan `LLM_PROVIDER` di `.env`. Interface publiknya (`connect()`, `ask_stream()`) sama persis untuk kedua provider, jadi `web_app.py` dan `gemini_client.py` tidak perlu tahu/berubah soal LLM apa yang dipakai.
   - **`backends/gemini_backend.py`** — implementasi pakai Gemini (`google-genai`).
   - **`backends/openai_backend.py`** — implementasi pakai OpenAI (Chat Completions API).
4. **`gemini_client.py`** — CLI chat (terminal) untuk testing cepat.
5. **`web_app.py`** — server FastAPI + WebSocket yang menyajikan UI chat dan menjembatani browser ⇄ `agent_service`.
6. **`static/`** — UI chat (HTML/CSS/JS statis, tanpa framework) yang bisa di-embed ke dashboard Tableau.

```
Browser (embed di Tableau dashboard)
        │  WebSocket (/ws)
        ▼
   web_app.py (FastAPI)
        │  ask_stream()
        ▼
  agent_service.py ── Gemini function calling
        │  MCP (stdio, subprocess)
        ▼
 tableau_mcp_server.py
        │  REST API + VizQL Data Service
        ▼
   Tableau Server / Cloud
```

## 1. Instalasi

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Konfigurasi

```bash
cp env.example.txt .env
```

Isi `.env`:

```
TABLEAU_SERVER=https://my-tableau-server.com
TABLEAU_SITE=my_site_content_url        # kosongkan "" jika Default site
TABLEAU_PAT_NAME=...
TABLEAU_PAT_SECRET=...
TABLEAU_API_VERSION=3.22

GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-pro              # opsional, default gemini-2.5-pro
```

PAT dibuat di: Tableau → Account Settings → Personal Access Tokens.

## 2b. Ganti LLM provider (Gemini ⇄ OpenAI)

Cukup ubah satu baris di `.env`:

```
LLM_PROVIDER=gemini     # atau: openai
```

Lalu isi kunci API yang sesuai (`GEMINI_API_KEY`/`GEMINI_MODEL` atau `OPENAI_API_KEY`/`OPENAI_MODEL` — lihat `env.example.txt`). Tidak ada file lain yang perlu diedit; `agent_service.py` otomatis meng-import backend yang tepat, dan status bar di UI chat juga otomatis menampilkan provider yang sedang aktif (mis. "siap · gemini · 6 tools").

Kalau nanti ingin menambah provider lain (mis. Claude via Anthropic API, atau model lokal), cukup buat `backends/<nama>_backend.py` baru dengan class `TableauAgentSession` yang method-nya identik (`connect()`, `ask_stream()`, `close()`), lalu tambahkan satu cabang `elif` di `agent_service.py`.

## 3. Menjalankan

**a) CLI (cepat untuk testing):**
```bash
python gemini_client.py
```

**b) Web app (untuk di-embed ke dashboard):**
```bash
uvicorn web_app:app --host 0.0.0.0 --port 8000 --reload --timeout-graceful-shutdown 10
```
Buka `http://localhost:8000` — chat box siap dipakai. Setiap tab browser = satu sesi percakapan independen (satu `TableauAgentSession` per koneksi WebSocket).

> `--timeout-graceful-shutdown 10`: batas waktu (detik) server menunggu koneksi WebSocket yang masih aktif sebelum dipaksa berhenti saat Ctrl+C. Tanpa ini, kalau ada tab browser/dashboard yang masih terbuka, uvicorn bisa macet tanpa batas di pesan "Waiting for background tasks to complete". `--reload` menjalankan uvicorn lewat proses supervisor (mengawasi perubahan file) + proses worker terpisah — normal kalau Anda melihat dua `python.exe` di Task Manager selama server berjalan.

## 4. Meng-embed ke dashboard Tableau

### Opsi A — Objek "Web Page" (paling sederhana)
1. Deploy `web_app.py` ke server yang bisa diakses via **HTTPS** (browser modern mewajibkan HTTPS untuk konten campuran di dalam iframe dashboard Tableau Cloud/Server).
2. Di Tableau Desktop/Web Edit, buka dashboard Anda → seret objek **Web Page** ke canvas.
3. Isi URL dengan alamat app Anda, mis. `https://assistant.perusahaan-anda.com/`.
4. Atur ukuran objek sesuai kebutuhan (chat box didesain responsif, nyaman mulai lebar ~360px).
5. Publish dashboard. Chat box akan tampil sebagai panel di sisi dashboard.

### Opsi B — Tableau Extensions API (sudah tersedia lengkap di paket ini)

File yang terlibat:
- **`static/tableau-extension.js`** — inisialisasi `tableau.extensions`, membaca semua worksheet + filter aktif di dashboard, menyimpannya di `window.__dashboardContext`, dan mendengarkan event `FilterChanged` supaya konteks selalu ter-update.
- **`static/index.html`** — memuat SDK `tableau.extensions.1.latest.js` yang **di-self-host** di `static/vendor/` (bukan dari CDN eksternal — banyak jaringan Tableau Server korporat memblokir domain seperti `extensions.tableau.com`, menyebabkan `net::ERR_NAME_NOT_RESOLVED` dan extension gagal total), lalu `tableau-extension.js`, lalu `app.js`. Ada juga badge kecil (`#context-badge`) yang menampilkan filter aktif secara visual di atas chat.
- **`static/vendor/tableau.extensions.1.latest.js`** — salinan resmi SDK dari repo `tableau/extensions-api` di GitHub. Untuk update ke versi lebih baru:
  ```bash
  curl -sL -o static/vendor/tableau.extensions.1.latest.js \
    https://raw.githubusercontent.com/tableau/extensions-api/master/lib/tableau.extensions.1.latest.js
  ```
- **`static/app.js`** — setiap kali user mengirim pesan, `window.__dashboardContext` ikut dikirim ke backend sebagai field `context` (selain `message`).
- **`web_app.py`** & **`agent_service.py`** — menerima `context` dari WebSocket dan menyisipkannya ke prompt Gemini, jadi assistant otomatis tahu filter yang sedang aktif tanpa Anda ketik manual.
- **`tableau-data-assistant.trex`** — manifest extension.

**Catatan penting:** kalau halaman ini dibuka sebagai objek **Web Page biasa** (Opsi A), `tableau.extensions` tidak akan pernah tersedia — semua kode di atas otomatis no-op dan chat tetap berfungsi normal tanpa konteks dashboard. Jadi satu paket ini mendukung kedua opsi sekaligus, tidak perlu versi terpisah.

**Langkah setup:**

1. Sunting `tableau-data-assistant.trex`:
   - Ganti `<url>https://assistant.perusahaan-anda.com/</url>` dengan alamat HTTPS tempat `web_app.py` Anda benar-benar di-deploy.
   - Untuk testing lokal, Tableau Desktop mengizinkan `http://localhost:8000` selama opsi **"Allow the extension to run local content"** (kadang disebut "Extensions - localhost only") diaktifkan di Tableau Desktop → Help → Settings and Performance, atau saat menambahkan extension pertama kali Desktop akan menampilkan dialog konfirmasi ini.
   - Sesuaikan `id`, `name`, `author`, `email`, `organization`, `website` sesuai perusahaan Anda.

2. Di Tableau Desktop, buka dashboard Anda → seret objek **Extension** (bukan Web Page) ke canvas.

3. Pada dialog yang muncul, pilih **"My Extensions"** → **"Access Local Extensions"** → arahkan ke file `tableau-data-assistant.trex` di komputer Anda (atau file share/URL tempat manifest itu di-host, tergantung workflow tim Anda).

4. Tableau akan menampilkan dialog izin ("This extension can access all data in the workbook") — ini karena manifest meminta `<full-data/>` supaya assistant bisa membaca filter secara lengkap. Klik **Allow**.

5. Extension akan memuat `index.html` Anda di dalam iframe khusus extension. Coba ubah filter di worksheet lain pada dashboard — badge konteks di atas chat akan otomatis update, dan pertanyaan berikutnya ke assistant akan otomatis menyertakan info filter tersebut.

6. Untuk publish ke Tableau Server/Cloud: upload `.trex` sebagai bagian dari dashboard saat di-publish (Tableau akan menyimpannya bersama workbook), dan pastikan admin site Anda mengizinkan **"Run on Tableau Server/Cloud"** untuk extension dengan source URL Anda (di Server: Settings → Extensions → Allowed list; kadang perlu ditambahkan admin jika site Anda mode "safe list only").

## 5. Catatan produksi (penting)

- **Jangan expose `GEMINI_API_KEY` atau PAT Tableau ke browser** — pada arsitektur ini keduanya sudah aman karena hanya dipakai di backend (`agent_service.py`, `tableau_mcp_server.py`); browser hanya bicara ke `web_app.py` lewat WebSocket teks biasa.
- Set `allow_origins` di `web_app.py` (CORS) ke domain Tableau Server/Cloud Anda, jangan biarkan `"*"` di production.
- Satu `TableauAgentSession` = satu subprocess MCP + histori chat in-memory. Untuk trafik tinggi, pertimbangkan: batas jumlah sesi aktif, timeout idle-session, atau kembangkan `agent_service.py` agar satu subprocess MCP dipakai bersama (pool) alih-alih satu per user.
- Jalankan di belakang reverse proxy (nginx/Caddy) dengan TLS untuk HTTPS + WSS.
- Tambahkan autentikasi (mis. cek session/cookie SSO perusahaan) di `web_app.py` sebelum membuka WebSocket, supaya tidak semua orang bisa memanggil Tableau & Gemini API Anda.

## 6. Struktur file lengkap

```
tableau-mcp-gemini/
├── tableau_client.py       # REST API + VizQL Data Service wrapper
├── tableau_mcp_server.py   # MCP tools (list_workbooks, query_datasource, dst.)
├── agent_service.py        # Factory: pilih backend LLM sesuai LLM_PROVIDER
├── backends/
│   ├── gemini_backend.py   # Implementasi LLM: Gemini
│   └── openai_backend.py   # Implementasi LLM: OpenAI
├── gemini_client.py        # CLI chat (khusus Gemini, testing cepat)
├── web_app.py              # FastAPI + WebSocket server
├── static/
│   ├── index.html          # shell UI chat
│   ├── style.css           # styling (console-style trace, bukan bubble generik)
│   └── app.js              # koneksi WebSocket + render pesan/trace
├── requirements.txt
├── env.example.txt         # salin jadi .env
└── README.md
```

## 8. Troubleshooting: assistant tidak "menyadari" perubahan filter

Kalau assistant tetap menjawab seolah tidak ada filter aktif setelah Anda ubah filter di dashboard:

0. **Cek dulu console browser untuk error `net::ERR_NAME_NOT_RESOLVED` pada `tableau.extensions.1.latest.js`.** Ini penyebab paling umum: jaringan tempat Tableau Server Anda berjalan biasanya jaringan internal/korporat yang tidak boleh akses domain luar, sehingga CDN SDK gagal dimuat sama sekali dan `window.tableau` tidak pernah ada — akibatnya `tableau-extension.js` langsung berhenti di baris pengecekan paling awal. **Paket ini sudah memakai SDK yang di-self-host** di `static/vendor/tableau.extensions.1.latest.js` (bukan CDN) justru untuk menghindari masalah ini — pastikan Anda pakai versi `index.html` terbaru yang me-reference `/static/vendor/...`, bukan versi lama yang masih menunjuk ke `https://extensions.tableau.com/...`.
1. **Buka console browser** (klik-kanan panel extension → Inspect di Tableau Desktop, atau F12 di web edit) dan cari log `[tableau-extension] konteks diperbarui: ...`. Kalau log ini tidak muncul sama sekali saat Anda ganti filter → berarti `FilterChanged` event tidak sampai ke script (biasanya karena extension belum ter-load penuh, atau Anda sedang menguji lewat mode Web Page biasa, bukan mode Extension).
2. Kalau log muncul tapi isinya `"tidak ada filter aktif saat ini"` walau Anda yakin sudah mengubah filter → cek tipe filter yang dipakai. Versi terbaru `tableau-extension.js` sudah menangani filter **categorical**, **range**, **relative-date**, dan **hierarchical**; kalau dashboard Anda memakai tipe filter lain yang tidak dikenali, filter tetap dicatat tapi tanpa detail nilainya — cek juga apakah filter itu diterapkan di *worksheet* yang datanya sedang dibaca (extension hanya membaca filter per-worksheet lewat `getFiltersAsync()`, bukan filter yang cuma ada di level dashboard tanpa terhubung ke worksheet mana pun).
3. Kalau badge di atas chat **sudah** menampilkan filter yang benar, tapi jawaban assistant tetap mengabaikannya → itu bukan soal pembacaan filter lagi, melainkan soal bagaimana Gemini memakainya. Pastikan Anda pakai `agent_service.py` versi terbaru (ada `SYSTEM_INSTRUCTION` yang secara eksplisit mewajibkan model menerapkan filter dari konteks ke query `query_datasource`, dan menandai konteks sebagai "TERKINI" supaya tidak bingung dengan konteks lama di riwayat chat).
4. Untuk mengetes cepat tanpa bolak-balik ke dashboard: buka `/` langsung di browser (mode Web Page biasa), lalu di console jalankan `window.__dashboardContext = 'Dashboard "Test" — filter aktif:\nWorksheet "Sales": Region = [West]'` sebelum mengirim pesan — ini mensimulasikan konteks tanpa perlu Extensions API sungguhan.

## 9. Menambah tool baru

1. Tambah method di `tableau_client.py`.
2. Bungkus jadi `@mcp.tool()` di `tableau_mcp_server.py`.
3. Restart `web_app.py` / `gemini_client.py` — tool baru otomatis terdeteksi lewat `session.list_tools()`, tidak perlu ubah `agent_service.py`, `web_app.py`, atau UI.
