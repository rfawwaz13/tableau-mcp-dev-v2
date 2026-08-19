/* app.js — logika chat: koneksi WebSocket, render pesan & jejak tool-call. */

const thread = document.getElementById("thread");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusDot = document.getElementById("status-dot");
const statusLabel = document.getElementById("status-label");
const suggestionsBox = document.getElementById("suggestions");
const contextRow = document.getElementById("context-row");
const contextBadge = document.getElementById("context-badge");
const syncDot = document.getElementById("sync-dot");
const contextSummary = document.getElementById("context-summary");
const contextPanel = document.getElementById("context-panel");
const contextText = document.getElementById("context-text");
const contextRefreshBtn = document.getElementById("context-refresh");

const DEFAULT_SUGGESTIONS = [
  "Ringkas performa dashboard ini",
  "Kota mana yang sales-nya tertinggi?",
  "Bandingkan online vs offline",
];

let ws = null;
let currentAssistantEl = null;
let thinkingEl = null;
let thinkingStartTime = null;
let thinkingInterval = null;

function scrollToBottom() {
  thread.scrollTop = thread.scrollHeight;
}

function showEmptyState() {
  thread.innerHTML = "";
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `<span class="glyph">◈</span>Tanyakan apa saja tentang data pada dashboard ini — assistant akan membaca datasource Tableau secara langsung.`;
  thread.appendChild(el);
}

function clearEmptyState() {
  const el = thread.querySelector(".empty-state");
  if (el) el.remove();
}

function renderSuggestions(list) {
  suggestionsBox.innerHTML = "";
  list.forEach((text) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.textContent = text;
    chip.addEventListener("click", () => {
      input.value = text;
      submitMessage();
    });
    suggestionsBox.appendChild(chip);
  });
}

function addUserMessage(text) {
  clearEmptyState();
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  thread.appendChild(el);
  scrollToBottom();
}

function startAssistantMessage() {
  currentAssistantEl = document.createElement("div");
  currentAssistantEl.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  currentAssistantEl.appendChild(bubble);
  thread.appendChild(currentAssistantEl);
}

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function showThinking() {
  thinkingStartTime = performance.now();
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML =
    '<span class="thinking-dots"><span></span><span></span><span></span></span>' +
    '<span class="thinking-timer">0.0s</span>';
  thread.appendChild(thinkingEl);
  scrollToBottom();

  const timerEl = thinkingEl.querySelector(".thinking-timer");
  thinkingInterval = setInterval(() => {
    if (!timerEl) return;
    timerEl.textContent = formatDuration(performance.now() - thinkingStartTime);
  }, 100);
}

function removeThinking() {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function appendAssistantMeta(elapsedMs, tokens) {
  if (!currentAssistantEl) return;
  if (typeof elapsedMs !== "number" && !tokens) return;

  const total =
    tokens && typeof tokens.total === "number"
      ? tokens.total
      : tokens
      ? (tokens.prompt || 0) + (tokens.completion || 0)
      : null;

  const parts = [];
  if (typeof elapsedMs === "number") parts.push(`⏱ ${formatDuration(elapsedMs)}`);
  if (typeof total === "number" && total > 0) parts.push(`🔤 ${total.toLocaleString("id-ID")} token`);
  if (parts.length === 0) return;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  meta.textContent = parts.join("  ·  ");
  currentAssistantEl.appendChild(meta);
}

function setStatus(state, label) {
  statusDot.className = state;
  statusLabel.textContent = label;
}

function setComposerEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled || input.value.trim().length === 0;
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.onopen = () => setStatus("", "menghubungkan ke Tableau…");

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case "ready":
        setStatus("connected", `siap · ${data.llm_provider || "llm"} · ${data.tools.length} tools`);
        setComposerEnabled(true);
        renderSuggestions(DEFAULT_SUGGESTIONS);
        break;

      case "tool_call":
      case "tool_result":
        // Proses internal (pemanggilan tool) sengaja tidak ditampilkan ke
        // pengguna — indikator "thinking" tetap berjalan sampai jawaban final.
        break;

      case "final":
        removeThinking();
        if (!currentAssistantEl) startAssistantMessage();
        currentAssistantEl.querySelector(".bubble").textContent = data.text;
        appendAssistantMeta(data.elapsed_ms, data.tokens);
        currentAssistantEl = null;
        setComposerEnabled(true);
        scrollToBottom();
        break;

      case "error":
        removeThinking();
        setStatus("error", "terjadi kesalahan");
        startAssistantMessage();
        currentAssistantEl.querySelector(".bubble").textContent = `⚠ ${data.message}`;
        currentAssistantEl = null;
        setComposerEnabled(true);
        break;
    }
  };

  ws.onclose = () => {
    setStatus("error", "terputus — mencoba lagi…");
    setComposerEnabled(false);
    setTimeout(connect, 2000);
  };

  ws.onerror = () => ws.close();
}

async function submitMessage() {
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;

  addUserMessage(text);
  input.value = "";
  input.style.height = "auto";
  setComposerEnabled(false);
  suggestionsBox.innerHTML = "";
  showThinking();

  // SELALU paksa baca ulang konteks dashboard SUNGGUHAN sebelum TIAP pesan
  // dikirim — JANGAN percaya flag "stale" di sini sama sekali (beda dari
  // pemakaian __dashboardContextStale di tempat lain, mis. badge UI, yang
  // memang boleh mengandalkan flag itu).
  //
  // Alasan: Tableau Extensions API TIDAK punya event untuk mendeteksi
  // pengguna berpindah SUB-PAGE/tab di dalam satu dashboard (pola umum:
  // tombol Show/Hide Container yang menukar worksheet/datasource yang
  // ditampilkan). FilterChanged/ParameterChanged HANYA terpicu kalau nilai
  // filter/parameter sungguhan berubah — bukan saat container disembunyikan/
  // ditampilkan. Kalau kita mengandalkan flag stale di titik pengiriman
  // pesan, pengguna yang pindah sub-page (mis. dari "Sales" ke
  // "Sales Online", yang datasource-nya berbeda) lalu langsung bertanya
  // akan tetap dapat CONTEXT LAMA (termasuk daftar datasource & filter dari
  // sub-page sebelumnya) — itu penyebab agent salah tarik datasource.
  //
  // Baca ulang tepat di sini (sesaat sebelum kirim, bukan reaktif terhadap
  // event) murah dan aman dari resource contention: pengguna baru selesai
  // mengetik + klik kirim, jadi dashboard biasanya sudah selesai re-render
  // apa pun sebelumnya.
  if (window.__isTableauExtension) {
    window.__dashboardContextStale = true;
  }

  // Baca filter dashboard SEKARANG, tepat sebelum dikirim — bukan pakai
  // nilai yang sudah basi dari sub-page/pertanyaan sebelumnya.
  if (!contextRow.hidden) setSyncState("syncing");
  const context =
    typeof window.__ensureFreshDashboardContext === "function"
      ? await window.__ensureFreshDashboardContext()
      : { text: "", filters: [] };

  ws.send(
    JSON.stringify({
      message: text,
      // Konteks dashboard (filter aktif, versi teks untuk dibaca LLM) kalau
      // halaman ini dibuka sebagai Tableau Dashboard Extension. Kosong kalau
      // mode Web Page biasa.
      context: context.text || "",
      // Versi TERSTRUKTUR dari filter yang sama (skema VizQL Data Service
      // siap-pakai) — backend akan MEMAKSA menerapkan ini ke setiap
      // query_datasource, tidak bergantung pada LLM menerjemahkan teks.
      context_filters: context.filters || [],
      // Nama datasource yang benar-benar dipakai worksheet yang visible
      // SEKARANG — backend akan MENOLAK query_datasource yang menyasar
      // datasource di luar daftar ini (mis. sisa riwayat chat dari
      // sub-page sebelumnya), bukan cuma mengandalkan instruksi prompt.
      context_datasources: context.datasourceNames || [],
    })
  );
}

sendBtn.addEventListener("click", submitMessage);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
  sendBtn.disabled = input.disabled || input.value.trim().length === 0;
});

let contextExpanded = false;
let isSyncing = false;

function setContextExpanded(expanded) {
  contextExpanded = expanded;
  contextBadge.setAttribute("aria-expanded", String(expanded));
  contextPanel.hidden = !expanded;
}

function setSyncState(state) {
  // state: "synced" | "stale" | "syncing"
  syncDot.className = state === "synced" ? "" : state;
  const labels = {
    synced: "Filter tersinkron dengan dashboard",
    stale: "Filter dashboard mungkin sudah berubah — akan otomatis di-sync saat Anda kirim pesan, atau klik untuk sync sekarang",
    syncing: "Sedang membaca filter terbaru dari dashboard…",
  };
  syncDot.title = labels[state] || "";
}

async function performSync({ expandAfter = false, forceRefresh = false } = {}) {
  if (isSyncing || typeof window.__ensureFreshDashboardContext !== "function") return;
  isSyncing = true;
  setSyncState("syncing");
  contextRefreshBtn.classList.add("spinning");
  contextRefreshBtn.disabled = true;
  const previousSummary = contextSummary.textContent;
  contextSummary.textContent = "menyinkronkan filter…";

  // forceRefresh = true (dipakai tombol refresh manual): JANGAN percaya flag
  // "stale" sama sekali, paksa baca ulang sungguhan. Flag stale bergantung
  // pada event ParameterChanged/FilterChanged yang TIDAK SELALU reliable di
  // semua versi Tableau — kalau event itu gagal terpicu (mis. untuk
  // parameter tertentu), flag tetap "tidak basi" padahal datanya sudah
  // berubah, dan tombol manual jadi terasa "tidak ngefek" karena cuma
  // mengembalikan cache lama. Tombol manual harus SELALU menjamin data
  // benar-benar terbaru, apa pun status flag-nya.
  if (forceRefresh) window.__dashboardContextStale = true;

  try {
    const fresh = await window.__ensureFreshDashboardContext();
    updateContextBadge({ text: fresh.text, filters: fresh.filters, totalFilterCount: fresh.totalFilterCount });
    if (expandAfter) setContextExpanded(true);
  } catch (err) {
    console.error("Gagal sync filter dashboard:", err);
    contextSummary.textContent = previousSummary;
  } finally {
    isSyncing = false;
    contextRefreshBtn.classList.remove("spinning");
    contextRefreshBtn.disabled = false;
  }
}

// Klik badge: expand/collapse seperti biasa. Sync OTOMATIS terjadi kalau
// state basi — perilaku ini TIDAK berubah, tombol refresh di sebelahnya
// cuma tambahan cara MANUAL untuk memicu sync yang sama tanpa perlu expand.
contextBadge.addEventListener("click", async () => {
  const expanding = !contextExpanded;
  setContextExpanded(expanding);
  if (expanding && window.__dashboardContextStale) {
    await performSync({ expandAfter: false });
    if (contextExpanded) contextPanel.hidden = false;
  }
});

// Tombol refresh manual — OPSIONAL, tapi SELALU memaksa fetch sungguhan
// (forceRefresh: true) — beda dari klik badge yang cuma sync KALAU flag
// stale aktif. Ini memastikan tombol selalu berfungsi/"ngefek" walau
// event ParameterChanged/FilterChanged gagal terpicu untuk suatu alasan.
contextRefreshBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  performSync({ expandAfter: false, forceRefresh: true });
});

function updateContextBadge(detail) {
  const text = detail ? detail.text : "";
  const appliedCount = detail && Array.isArray(detail.filters) ? detail.filters.length : 0;
  const totalCount = detail && typeof detail.totalFilterCount === "number" ? detail.totalFilterCount : appliedCount;

  if (!text || totalCount === 0) {
    contextRow.hidden = true;
    setContextExpanded(false);
    contextText.textContent = "";
    return;
  }

  setSyncState(window.__dashboardContextStale ? "stale" : "synced");
  contextSummary.textContent =
    appliedCount === totalCount
      ? `${totalCount} filter dashboard diterapkan`
      : `${appliedCount} dari ${totalCount} filter dashboard diterapkan`;
  contextText.textContent = text;
  contextRow.hidden = false;
}

// Diisi oleh tableau-extension.js setelah pembacaan filter SUNGGUHAN terjadi
// (saat init, atau lazy lewat ensureFreshDashboardContext/performSync).
// TIDAK terpicu tiap kali filter dashboard berubah — lihat
// markDashboardContextStale untuk event yang ringan (tanpa data).
window.addEventListener("dashboardContextUpdated", (e) => updateContextBadge(e.detail));

// Event RINGAN (tanpa data) yang terpicu tiap filter dashboard berubah —
// cukup untuk memindahkan indikator ke state "stale" (kuning), TANPA
// memicu pembacaan filter apa pun di titik ini. Sync sungguhan tetap
// terjadi otomatis nanti: saat pengguna kirim pesan, klik badge, atau
// klik tombol refresh manual.
window.addEventListener("dashboardContextStale", () => {
  if (isSyncing) return;
  if (contextRow.hidden) {
    // Baris badge belum pernah tampil (mis. dashboard awalnya tidak punya
    // filter/parameter aktif sama sekali) — TETAP tampilkan sekarang dalam
    // state "stale" minimal, supaya tombol refresh SELALU ada untuk
    // diklik begitu ada perubahan terdeteksi, bukan tersembunyi selamanya.
    contextSummary.textContent = "Filter dashboard berubah — klik untuk sync";
    setSyncState("stale");
    contextRow.hidden = false;
  } else {
    setSyncState("stale");
  }
});

showEmptyState();
connect();
