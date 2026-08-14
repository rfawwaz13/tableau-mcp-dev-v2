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
let currentTraceEl = null;
let thinkingEl = null;

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
  thread.appendChild(currentAssistantEl);
}

function showThinking() {
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  thinkingEl.innerHTML = "<span></span><span></span><span></span>";
  thread.appendChild(thinkingEl);
  scrollToBottom();
}

function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function addToolCall(name, args) {
  removeThinking();
  const trace = document.createElement("div");
  trace.className = "trace";

  const line = document.createElement("div");
  line.className = "trace-line";
  line.innerHTML = `<span class="trace-arrow">→</span><span class="trace-name">${escapeHtml(
    name
  )}</span><span class="trace-args">${escapeHtml(JSON.stringify(args))}</span>`;
  trace.appendChild(line);

  thread.appendChild(trace);
  currentTraceEl = trace;
  scrollToBottom();
  showThinking();
}

function addToolResult(result) {
  if (!currentTraceEl) return;
  const resultEl = document.createElement("div");
  resultEl.className = "trace-result";
  resultEl.textContent = result;
  currentTraceEl.appendChild(resultEl);

  if (result.length > 260) {
    const toggle = document.createElement("button");
    toggle.className = "trace-toggle";
    toggle.textContent = "tampilkan semua";
    toggle.addEventListener("click", () => {
      resultEl.classList.toggle("expanded");
      toggle.textContent = resultEl.classList.contains("expanded")
        ? "sembunyikan"
        : "tampilkan semua";
    });
    currentTraceEl.appendChild(toggle);
  }
  scrollToBottom();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
        addToolCall(data.name, data.args);
        break;

      case "tool_result":
        addToolResult(data.result);
        break;

      case "final":
        removeThinking();
        if (!currentAssistantEl) startAssistantMessage();
        currentAssistantEl.textContent = data.text;
        currentAssistantEl = null;
        currentTraceEl = null;
        setComposerEnabled(true);
        scrollToBottom();
        break;

      case "error":
        removeThinking();
        setStatus("error", "terjadi kesalahan");
        startAssistantMessage();
        currentAssistantEl.textContent = `⚠ ${data.message}`;
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

let hasSentFirstMessage = false;

async function submitMessage() {
  const text = input.value.trim();
  if (!text || ws.readyState !== WebSocket.OPEN) return;

  addUserMessage(text);
  input.value = "";
  input.style.height = "auto";
  setComposerEnabled(false);
  suggestionsBox.innerHTML = "";
  showThinking();

  // PESAN PERTAMA dalam sesi ini: JANGAN percaya cache sama sekali (walau
  // stale === false), paksa baca ulang langsung dari dashboard. Ini jaring
  // pengaman terhadap race condition di awal load — snapshot pertama saat
  // extension baru dimuat kadang belum mencerminkan state final Tableau
  // (lihat catch-up read di tableau-extension.js), jadi demi akurasi di
  // interaksi paling penting ini, kita tidak ambil risiko pakai cache.
  if (!hasSentFirstMessage && window.__isTableauExtension) {
    window.__dashboardContextStale = true;
  }
  hasSentFirstMessage = true;

  // Baca filter dashboard SEKARANG, tepat sebelum dikirim — bukan pakai
  // nilai yang sudah basi dari saat extension pertama dimuat. Kalau tidak
  // ada perubahan filter sejak terakhir dibaca (window.__dashboardContextStale
  // === false), ini langsung return cache tanpa panggilan API apa pun.
  if (window.__dashboardContextStale && !contextRow.hidden) setSyncState("syncing");
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
