/* tableau-extension.js
 * -----------------------------------------------------------------------
 * Berjalan HANYA kalau halaman ini dimuat sebagai Tableau Dashboard
 * Extension (bukan mode "Web Page" biasa). Tugasnya:
 *   1. initializeAsync() ke Tableau Extensions API.
 *   2. Membaca semua worksheet di dashboard + filter yang sedang aktif,
 *      dan MENERJEMAHKANNYA LANGSUNG ke objek filter skema VizQL Data
 *      Service (bukan cuma teks) — supaya backend bisa MEMAKSA menerapkan
 *      filter ini ke query_datasource tanpa bergantung pada LLM yang
 *      "menerjemahkan" teks secara manual (rawan salah/parsial).
 *   3. Menyimpan:
 *        - window.__dashboardContext        (string, untuk badge & prompt)
 *        - window.__dashboardFilters        (array objek VDS, untuk backend)
 *   4. Mendengarkan perubahan filter, lalu memancarkan event
 *      "dashboardContextUpdated" supaya app.js bisa memperbarui badge UI
 *      dan mengirim ulang window.__dashboardFilters ke backend.
 *
 * Jika script `tableau.extensions.1.latest.js` tidak ada (mis. saat
 * dijalankan mandiri lewat opsi A / Web Page biasa), semua fungsi di sini
 * langsung no-op sehingga chat tetap berfungsi normal tanpa konteks
 * dashboard.
 * ------------------------------------------------------------------- */

window.__dashboardContext = "";
window.__dashboardFilters = [];
window.__isTableauExtension = false;

// ---------------------------------------------------------------------
// PETA NAMA PARAMETER -> FIELD CAPTION SEBENARNYA DI DATASOURCE.
//
// Tableau Parameter itu objek TERPISAH dari Filter (API-nya beda:
// getParametersAsync(), bukan getFiltersAsync()), dan levelnya di
// WORKBOOK/DASHBOARD — TIDAK otomatis terikat ke kolom datasource mana pun.
//
// POLA UMUM: dashboard sering pakai parameter (mis. "P.Branch List") di
// dalam CALCULATED FIELD boolean gate (mis. "Branch Change" = ([P.Branch
// List] = [Mkpd Branch Name])) yang lalu dipakai sebagai filter worksheet.
// JANGAN petakan parameter ke calculated field gate itu (mis. JANGAN
// "P.Branch List": "Branch Change") — VizQL Data Service TIDAK bisa
// mengevaluasi calculated field itu dengan nilai parameter LIVE yang
// sedang Anda pilih di browser (VDS cuma tahu nilai parameter versi
// PUBLISHED/default), jadi memaksakan filter pada calculated field gate
// itu akan memberi hasil SALAH atau NOL BARIS.
//
// YANG BENAR: petakan parameter LANGSUNG ke field TARGET yang sebenarnya
// ingin difilter (mis. "Mkpd Branch Name"), supaya sistem membuat filter
// "Mkpd Branch Name = <nilai parameter saat ini>" sendiri — ini valid
// untuk nilai APA PUN termasuk "ALL", tanpa bergantung pada evaluasi
// calculated field sama sekali:
//
//   const PARAMETER_FIELD_MAP = {
//     "P.Branch List": "Mkpd Branch Name",
//   };
//
// KALAU nama parameter di Tableau SAMA PERSIS dengan field caption target,
// tidak perlu diisi di sini (otomatis dipakai apa adanya).
//
// Edit langsung di sini kapan pun Anda menemukan parameter yang tidak
// ter-refleksi dengan benar ke query — tidak perlu ubah file Python/env.
// const PARAMETER_FIELD_MAP = {};
const PARAMETER_FIELD_MAP = {
  "P.Branch List": "Mkpd Branch Name",
};

// ---------------------------------------------------------------------
// FIELD FILTER YANG DIKECUALIKAN dari force-apply ke query_datasource.
//
// Isi dengan nama calculated field boolean GATE yang dibangun dari
// parameter (contoh di atas: "Branch Change"). Field seperti ini muncul
// sebagai filter worksheet biasa (mis. "Branch Change = True") tapi
// TIDAK BOLEH ikut dipaksakan ke query bersamaan dengan filter dari
// PARAMETER_FIELD_MAP — karena VDS mengevaluasinya pakai nilai parameter
// PUBLISHED/default (bukan live), yang bisa BERTENTANGAN dengan filter
// target yang benar (mis. "Branch Change=True" tersirat "Mkpd Branch Name
// = ALL" kalau default parameter-nya "ALL", padahal Anda sedang pilih
// "CIKOKOL" — dikombinasikan, hasilnya NOL baris).
//
// Field ini TETAP ditampilkan di teks konteks (transparansi), TAPI tidak
// pernah dikirim sebagai filter VDS sungguhan.
//
//   const EXCLUDED_FILTER_FIELDS = new Set(["Branch Change"]);
//
// const EXCLUDED_FILTER_FIELDS = new Set([]);
const EXCLUDED_FILTER_FIELDS = new Set(["Branch Change", "Mkpd Branch"]);

// Batas waktu per-panggilan API ke satu worksheet. Kalau Tableau lambat
// merespons untuk worksheet tertentu (mis. worksheet tersembunyi yang
// jarang di-render), kita TIDAK menunggu tanpa batas — anggap saja
// worksheet itu "tidak berkontribusi filter" untuk request ini, daripada
// membuat seluruh proses menggantung berpuluh detik/menit.
const WORKSHEET_FETCH_TIMEOUT_MS = 60000;

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), ms)),
  ]);
}

/**
 * Baca semua Parameter dashboard (level workbook, BUKAN per-worksheet) dan
 * terjemahkan jadi objek filter VDS, sama seperti Filter biasa. Parameter
 * SELALU bernilai tunggal (tidak seperti Filter yang bisa multi-value),
 * jadi diterjemahkan sebagai kesetaraan (SET satu nilai, atau RANGE dengan
 * min=max untuk angka/tanggal).
 */
async function collectParameterFilters(dashboard) {
  const results = [];
  let parameters = [];
  try {
    parameters = await withTimeout(dashboard.getParametersAsync(), WORKSHEET_FETCH_TIMEOUT_MS, []);
  } catch (err) {
    console.warn("[tableau-extension] Gagal membaca parameters:", err);
    return results;
  }

  // Log MENTAH semua parameter yang ditemukan (nama persis + nilai persis)
  // SEBELUM disaring — supaya kalau ada parameter yang ternyata tidak
  // masuk ke hasil akhir (mis. karena currentValue kosong), Anda tetap bisa
  // lihat nama persisnya di sini untuk diisi ke PARAMETER_FIELD_MAP.
  console.debug(
    "[tableau-extension] Semua parameter ditemukan (mentah):",
    parameters.map((p) => ({ name: p.name, dataType: p.dataType, currentValue: p.currentValue }))
  );

  for (const param of parameters) {
    const cv = param.currentValue;
    if (!cv || cv.value === null || cv.value === undefined) continue;

    const fieldCaption = PARAMETER_FIELD_MAP[param.name] || param.name;
    const displayText = `${param.name} (parameter) = ${cv.formattedValue}`;

    let vds;
    if (cv.value instanceof Date || param.dataType === "date" || param.dataType === "date-time") {
      const d = cv.value instanceof Date ? cv.value : new Date(cv.value);
      const iso = isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      if (!iso) continue;
      vds = {
        field: { fieldCaption },
        filterType: "QUANTITATIVE_DATE",
        quantitativeFilterType: "RANGE",
        minDate: iso,
        maxDate: iso,
      };
    } else {
      // string / int / float / bool -> SET dengan satu nilai (RAW, bukan
      // formattedValue), sama seperti filter kategorikal biasa.
      vds = {
        field: { fieldCaption },
        filterType: "SET",
        values: [cv.value],
        exclude: false,
      };
    }

    results.push({ field: param.name, text: displayText, vds });
  }

  return results;
}

/**
 * Dashboard.worksheets berisi SEMUA worksheet termasuk yang tersembunyi
 * (dipakai sebagai "helper" kalkulasi KPI di balik layar, tidak pernah
 * ditampilkan). Worksheet tersembunyi ini seringkali LAMBAT/BASI dalam
 * melaporkan state filter terbarunya (karena tidak sedang di-render Tableau)
 * dan bisa memenuhi mayoritas suara di mekanisme voting sehingga filter
 * yang benar (dari worksheet yang terlihat) malah kalah suara. Fungsi ini
 * mempersempit ke worksheet yang BENAR-BENAR TAMPIL di layout dashboard
 * saja — lebih cepat dibaca DAN lebih akurat (mencerminkan apa yang
 * pengguna lihat).
 */
function getVisibleWorksheets(dashboard) {
  try {
    const visibleObjects = (dashboard.objects || []).filter(
      (obj) => obj.type === "worksheet" && obj.isVisible !== false && obj.worksheet
    );
    if (visibleObjects.length === 0) return dashboard.worksheets; // fallback aman
    const visibleNames = new Set(visibleObjects.map((obj) => obj.worksheet.name));
    const filtered = dashboard.worksheets.filter((ws) => visibleNames.has(ws.name));
    return filtered.length > 0 ? filtered : dashboard.worksheets;
  } catch (err) {
    console.warn("[tableau-extension] Gagal menentukan worksheet visible, pakai semua:", err);
    return dashboard.worksheets;
  }
}

// Nama-nama datasource yang benar-benar dipakai dashboard ini, dikumpulkan
// sekali saat init (tidak berubah saat filter di-ubah, jadi tidak perlu
// di-refetch tiap kali seperti filter).
let cachedDatasourceNames = [];

/**
 * Kumpulkan nama SEMUA datasource yang dipakai oleh worksheet mana pun di
 * dashboard ini (bisa lebih dari satu worksheet memakai datasource yang
 * sama -> di-dedupe). Ini yang dipakai untuk MEMBATASI scope agent supaya
 * tidak query datasource lain di server yang tidak relevan dengan
 * dashboard yang sedang ditampilkan.
 */
async function collectDashboardDatasourceNames(dashboard) {
  const names = new Set();
  const worksheets = getVisibleWorksheets(dashboard);

  // Promise.all, BUKAN for...of sequential -> semua worksheet di-fetch
  // BERSAMAAN, bukan satu-satu menunggu yang sebelumnya selesai. Untuk
  // dashboard dengan banyak worksheet, ini bisa >10x lebih cepat.
  await Promise.all(
    worksheets.map(async (worksheet) => {
      try {
        const datasources = await withTimeout(
          worksheet.getDataSourcesAsync(),
          WORKSHEET_FETCH_TIMEOUT_MS,
          []
        );
        datasources.forEach((ds) => names.add(ds.name));
      } catch (err) {
        console.warn(`Gagal membaca datasource worksheet "${worksheet.name}":`, err);
      }
    })
  );

  return Array.from(names);
}

/**
 * Interpretasi SATU objek Filter Tableau jadi DUA representasi sekaligus:
 *   - text: baris ringkasan untuk badge UI / prompt LLM (konteks bacaan)
 *   - vds: objek filter siap-pakai skema VizQL Data Service, dengan bentuk
 *     PERSIS seperti yang diharapkan oleh endpoint query-datasource
 *     (field.fieldCaption, filterType, dst). vds bernilai null HANYA kalau
 *     Tableau sendiri melaporkan tidak ada anggota spesifik yang dipilih
 *     (isAllSelected) — literal nilai "ALL" TIDAK termasuk kasus ini, dan
 *     diperlakukan sebagai nilai filter biasa (lihat catatan penting di
 *     buildSetOrDateFilter di bawah).
 *
 * Lihat: https://tableau.github.io/extensions-api/docs/interfaces/filter.html
 * dan: https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html
 */

/**
 * Tableau VizQL Data Service MENOLAK filterType "SET" untuk kolom yang
 * bertipe Date/DateTime (error: "Invalid Set Filter value, only string,
 * boolean and numbers are supported") — walaupun secara UI filter itu
 * tampil sebagai dropdown biasa (categorical). Fungsi ini menerjemahkan
 * appliedValues sebuah filter kategorikal/hierarkis jadi objek VDS yang
 * BENAR sesuai tipe data ASLI-nya (bukan cuma teks tampilannya):
 *   - Kalau nilainya berupa objek Date         -> QUANTITATIVE_DATE (RANGE)
 *   - Kalau nilainya string/number/boolean     -> SET (pakai nilai RAW,
 *     bukan formattedValue, supaya cocok persis tipe data kolom)
 */
function buildSetOrDateFilter(fieldName, appliedValues) {
  const withValue = (appliedValues || []).filter(
    (v) => v.value !== null && v.value !== undefined
  );
  if (withValue.length === 0) return null;

  const sample = withValue[0].value;
  const displayText = `${fieldName} = [${withValue.map((v) => v.formattedValue).join(", ")}]`;

  if (sample instanceof Date) {
    const isoDates = withValue
      .map((v) => {
        const d = v.value instanceof Date ? v.value : new Date(v.value);
        return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      })
      .filter((d) => d !== null);
    if (isoDates.length === 0) return null;

    const minDate = isoDates.reduce((a, b) => (a < b ? a : b));
    const maxDate = isoDates.reduce((a, b) => (a > b ? a : b));

    return {
      text: displayText,
      vds: {
        field: { fieldCaption: fieldName },
        filterType: "QUANTITATIVE_DATE",
        quantitativeFilterType: "RANGE",
        minDate,
        maxDate,
      },
    };
  }

  // String / number / boolean -> SET, pakai nilai RAW (bukan formattedValue
  // yang cuma teks tampilan, mis. dengan pemisah ribuan) supaya tipe & isi
  // datanya cocok persis dengan kolom di datasource.
  //
  // PENTING: nilai literal "ALL" DIPERLAKUKAN SAMA seperti nilai lain (BUKAN
  // di-skip). Datasource di sini adalah hasil GROUP BY CUBE (mis. di
  // BigQuery), di mana "ALL" adalah baris agregat/rollup yang SUDAH
  // di-precompute untuk kombinasi dimensi tsb. Kalau filter "ALL" tidak
  // diterapkan, query akan mengambil SEMUA baris (breakdown granular +
  // baris agregat) sekaligus, menyebabkan double-counting. Jadi memilih
  // "ALL" di sebuah dropdown filter dashboard itu SAMA validnya dengan
  // memilih kategori spesifik — keduanya harus diteruskan apa adanya.
  const rawValues = withValue.map((v) => v.value);

  return {
    text: displayText,
    vds: {
      field: { fieldCaption: fieldName },
      filterType: "SET",
      values: rawValues,
      exclude: false,
    },
  };
}

function interpretFilter(filter) {
  // Field yang secara eksplisit dikecualikan (lihat EXCLUDED_FILTER_FIELDS
  // di atas) — biasanya calculated boolean gate yang dibangun dari
  // parameter. TETAP ditampilkan di teks (transparansi), TAPI TIDAK PERNAH
  // diterapkan sebagai filter VDS, supaya tidak bertentangan dengan filter
  // yang benar dari parameter aslinya (lihat PARAMETER_FIELD_MAP).
  if (EXCLUDED_FILTER_FIELDS.has(filter.fieldName)) {
    const valueText =
      filter.appliedValues && filter.appliedValues.length > 0
        ? filter.appliedValues.map((v) => v.formattedValue).join(", ")
        : "?";
    return {
      field: filter.fieldName,
      text: `${filter.fieldName} = [${valueText}] (dikecualikan dari filter query — lihat EXCLUDED_FILTER_FIELDS)`,
      vds: null,
    };
  }

  let result;
  try {
    switch (filter.filterType) {
      case "categorical": {
        // isAllSelected = state BAWAAN Tableau di mana TIDAK ADA anggota
        // spesifik yang dipilih (beda dari memilih literal member "ALL" —
        // itu ditangani normal sebagai nilai SET biasa di buildSetOrDateFilter).
        // Kondisi ini jarang terjadi di dashboard yang datasource-nya CUBE
        // (biasanya selalu ada satu member eksplisit terpilih, termasuk
        // "ALL"), tapi kalau terjadi, tidak ada nilai pasti untuk dikirim
        // sebagai filter -> tidak diterapkan, cuma dicatat untuk transparansi.
        result = filter.isAllSelected
          ? {
              text: `${filter.fieldName}: tidak ada anggota spesifik dipilih (filter Tableau dalam kondisi default/tidak membatasi)`,
              vds: null,
            }
          : buildSetOrDateFilter(filter.fieldName, filter.appliedValues);
        break;
      }

      case "range": {
        const minVal = filter.minValue ? filter.minValue.value : null;
        const maxVal = filter.maxValue ? filter.maxValue.value : null;
        const minText = filter.minValue ? filter.minValue.formattedValue : null;
        const maxText = filter.maxValue ? filter.maxValue.formattedValue : null;
        if (minVal === null && maxVal === null) {
          result = null;
          break;
        }

        // Field bertipe tanggal juga bisa muncul sebagai filter "range"
        // (mis. slider tanggal) -> gunakan QUANTITATIVE_DATE, bukan
        // QUANTITATIVE_NUMERICAL, kalau nilainya objek Date.
        const isDateRange = minVal instanceof Date || maxVal instanceof Date;
        const toIso = (d) => {
          if (d === null) return null;
          const dateObj = d instanceof Date ? d : new Date(d);
          return isNaN(dateObj.getTime()) ? null : dateObj.toISOString().slice(0, 10);
        };

        result = {
          text: `${filter.fieldName} antara ${minText ?? "-∞"} dan ${maxText ?? "∞"}`,
          vds: isDateRange
            ? {
                field: { fieldCaption: filter.fieldName },
                filterType: "QUANTITATIVE_DATE",
                quantitativeFilterType: "RANGE",
                minDate: toIso(minVal),
                maxDate: toIso(maxVal),
              }
            : {
                field: { fieldCaption: filter.fieldName },
                filterType: "QUANTITATIVE_NUMERICAL",
                quantitativeFilterType: "RANGE",
                min: minVal,
                max: maxVal,
              },
        };
        break;
      }

      case "relative-date": {
        result = {
          text: `${filter.fieldName} = relative date (${filter.periodType}, rentang ${filter.rangeType}, anchor ${filter.anchorDate})`,
          vds: {
            field: { fieldCaption: filter.fieldName },
            filterType: "DATE",
            periodType: filter.periodType,
            dateRangeType: filter.rangeType,
          },
        };
        break;
      }

      case "hierarchical": {
        result = buildSetOrDateFilter(filter.fieldName, filter.appliedValues);
        break;
      }

      default:
        // Tipe filter yang tidak dikenali: tetap dicatat di teks supaya
        // terlihat, tapi TIDAK dibuatkan objek VDS (daripada mengirim
        // filter yang salah bentuk ke Tableau).
        result = {
          text: `${filter.fieldName} (filter tipe "${filter.filterType}" aktif, detail tidak dibaca)`,
          vds: null,
        };
    }
  } catch (err) {
    console.warn("Gagal menginterpretasi filter:", filter, err);
    return null;
  }

  if (!result) return null;
  result.field = filter.fieldName;
  return result;
}

async function buildDashboardState() {
  const dashboard = tableau.extensions.dashboardContent.dashboard;

  // Field APA SAJA yang punya filter card (baik yang membatasi data maupun
  // yang cuma "= ALL"), untuk ringkasan jumlah total di badge.
  const allFilterFieldsSeen = new Set();

  // Per field, kumpulkan SEMUA nilai berbeda yang muncul di berbagai
  // worksheet + berapa kali & di worksheet mana saja. PENTING: kita TIDAK
  // langsung "menimpa" kalau ada worksheet lain dengan nilai berbeda untuk
  // field yang sama (itu bug sebelumnya — worksheet yang diproses terakhir
  // menang secara acak, sehingga filter yang sebenarnya konsisten di
  // MAYORITAS worksheet malah bisa hilang/tertimpa satu worksheet yang
  // beda sendiri).
  const fieldValueVotes = new Map(); // fieldCaption -> Map<serializedValue, {vds, count, worksheets: []}>

  const worksheets = getVisibleWorksheets(dashboard);

  // Promise.all, BUKAN for...of sequential -> getFiltersAsync() untuk semua
  // worksheet dipanggil BERSAMAAN. Dengan banyak worksheet, loop sequential
  // sebelumnya jadi penyumbang utama lag saat filter diubah (worksheet ke-N
  // baru mulai di-fetch setelah worksheet ke-(N-1) selesai). Timeout per
  // worksheet mencegah SATU worksheet lambat (mis. tersembunyi/jarang
  // di-render) menahan seluruh proses berpuluh detik.
  const perWorksheetResults = await Promise.all(
    worksheets.map(async (worksheet) => {
      let filters = [];
      try {
        filters = await withTimeout(worksheet.getFiltersAsync(), WORKSHEET_FETCH_TIMEOUT_MS, null);
        if (filters === null) {
          console.warn(`[tableau-extension] Timeout membaca filter worksheet "${worksheet.name}", dilewati.`);
          filters = [];
        }
      } catch (err) {
        console.warn(`Gagal membaca filter worksheet "${worksheet.name}":`, err);
        return { worksheetName: worksheet.name, interpreted: [] };
      }
      const interpreted = filters.map(interpretFilter).filter((f) => f !== null);
      return { worksheetName: worksheet.name, interpreted };
    })
  );

  // Teks tampilan per field (untuk transparansi di badge/prompt) — HANYA
  // untuk display, bukan otoritatif untuk filtering (itu tugas
  // fieldValueVotes/vdsFiltersByField di bawah).
  const fieldDisplayText = new Map();

  for (const { interpreted } of perWorksheetResults) {
    if (interpreted.length === 0) continue;

    interpreted.forEach((f) => {
      allFilterFieldsSeen.add(f.field);
      if (!fieldDisplayText.has(f.field)) {
        fieldDisplayText.set(f.field, f.text);
      }
      if (!f.vds) return;

      const fieldCaption = f.vds.field.fieldCaption;
      const serialized = JSON.stringify(f.vds);

      if (!fieldValueVotes.has(fieldCaption)) {
        fieldValueVotes.set(fieldCaption, new Map());
      }
      const votesForField = fieldValueVotes.get(fieldCaption);
      if (!votesForField.has(serialized)) {
        votesForField.set(serialized, { vds: f.vds, count: 0 });
      }
      votesForField.get(serialized).count += 1;
    });
  }

  console.debug(`[tableau-extension] ${worksheets.length} worksheet visible dibaca`);

  // Untuk tiap field, pilih nilai yang paling sering muncul (mayoritas) di
  // seluruh worksheet VISIBLE sebagai filter yang DIPAKSA-terapkan. Field
  // dengan >1 nilai berbeda (jarang terjadi sekarang karena sudah dibatasi
  // ke worksheet visible saja) dicatat singkat sebagai catatan, bukan
  // dijadikan filter yang dipaksakan.
  const vdsFiltersByField = new Map();
  const conflictNotes = [];

  for (const [fieldCaption, votesForField] of fieldValueVotes) {
    const entries = Array.from(votesForField.values());
    entries.sort((a, b) => b.count - a.count);
    vdsFiltersByField.set(fieldCaption, entries[0].vds);
    if (entries.length > 1) {
      conflictNotes.push(`${fieldCaption} (nilai tidak konsisten antar-worksheet, dipakai yang mayoritas)`);
    }
  }

  // Parameter dashboard (BUKAN filter — lihat collectParameterFilters di
  // atas untuk penjelasan bedanya). Selalu OTORITATIF untuk field yang
  // dipetakan lewat PARAMETER_FIELD_MAP: menimpa hasil voting filter biasa
  // kalau kebetulan menyasar field yang sama, karena parameter cuma punya
  // SATU sumber nilai per dashboard (tidak ada konsep "mayoritas worksheet"
  // yang relevan untuknya).
  const parameterFilters = await collectParameterFilters(dashboard);
  for (const p of parameterFilters) {
    allFilterFieldsSeen.add(p.field);
    fieldDisplayText.set(p.field, p.text);
    vdsFiltersByField.set(p.vds.field.fieldCaption, p.vds);
  }

  console.debug(`[tableau-extension] ${parameterFilters.length} parameter dibaca:`, parameterFilters.map(p => p.text));

  // ---------- teks kompak untuk badge UI & prompt LLM ----------
  // Ringkas dengan sengaja (hemat token): penjelasan lengkap soal cara
  // filter ini harus dipakai sudah ada SEKALI di SYSTEM_INSTRUCTION backend,
  // tidak perlu diulang di sini setiap giliran chat.

  const datasourceLine =
    cachedDatasourceNames.length > 0
      ? `Datasource: ${cachedDatasourceNames.map((n) => `"${n}"`).join(", ")}.`
      : "";

  let filterLine;
  if (allFilterFieldsSeen.size === 0) {
    filterLine = "Tidak ada filter aktif.";
  } else {
    const parts = [];
    for (const field of allFilterFieldsSeen) {
      parts.push(fieldDisplayText.get(field) || field);
    }
    filterLine = `Filter: ${parts.join("; ")}`;
    if (conflictNotes.length > 0) {
      filterLine += ` [${conflictNotes.join("; ")}]`;
    }
  }

  let contextText = `Dashboard "${dashboard.name}". ${datasourceLine} ${filterLine}`.trim();
  const MAX_LENGTH = 1200;
  if (contextText.length > MAX_LENGTH) {
    contextText = contextText.slice(0, MAX_LENGTH) + " …(dipotong)";
  }

  return {
    contextText,
    dashboardFilters: Array.from(vdsFiltersByField.values()),
    totalFilterCount: allFilterFieldsSeen.size,
    appliedFilterCount: vdsFiltersByField.size,
  };
}

async function refreshContext() {
  let totalFilterCount = 0;
  try {
    const state = await buildDashboardState();
    window.__dashboardContext = state.contextText;
    window.__dashboardFilters = state.dashboardFilters;
    totalFilterCount = state.totalFilterCount;
  } catch (err) {
    console.error("Gagal membaca konteks dashboard:", err);
    window.__dashboardContext = "";
    window.__dashboardFilters = [];
  }
  window.__dashboardContextStale = false;
  console.debug("[tableau-extension] konteks diperbarui:", window.__dashboardContext);
  console.debug("[tableau-extension] filter VDS siap-pakai:", window.__dashboardFilters);
  window.dispatchEvent(
    new CustomEvent("dashboardContextUpdated", {
      detail: {
        text: window.__dashboardContext,
        filters: window.__dashboardFilters,
        totalFilterCount,
      },
    })
  );
  return { text: window.__dashboardContext, filters: window.__dashboardFilters, totalFilterCount };
}

// ---------------------------------------------------------------------
// STRATEGI PERFORMA: LAZY, BUKAN EAGER.
//
// Percobaan sebelumnya (debounce + Promise.all) TETAP bikin dashboard lag,
// karena akar masalahnya bukan "berapa banyak pemanggilan API", tapi KAPAN
// pemanggilan itu terjadi: begitu filter diubah, dashboard Tableau SENDIRI
// langsung sibuk re-query & re-render semua worksheet-nya. Kalau extension
// IKUT memanggil getFiltersAsync()/getDataSourcesAsync() ke banyak worksheet
// PERSIS di momen yang sama (walau sudah di-debounce jadi 1 batch), request
// itu tetap REBUTAN kapasitas query dengan proses render dashboard yang
// sedang berlangsung -> keduanya jadi terasa lebih lambat bersama-sama.
//
// Solusinya: JANGAN lakukan apa pun yang mahal saat filter berubah. Event
// FilterChanged di sini HANYA menandai state "basi" (operasi sinkron,
// hampir tanpa biaya, tidak ada panggilan API sama sekali). Pembacaan
// filter yang SESUNGGUHNYA (buildDashboardState -> getFiltersAsync dst.)
// baru dijalankan LAZY, tepat sebelum benar-benar dibutuhkan:
//   1. Saat pengguna MENGIRIM pesan chat (lihat app.js) — ini yang paling
//      penting, karena di titik inilah filter HARUS akurat.
//   2. Saat pengguna KLIK badge untuk membuka detail filter.
// Di kedua kasus itu, dashboard biasanya sudah selesai re-render (pengguna
// perlu waktu untuk mulai mengetik/klik), jadi tidak lagi rebutan resource
// dengan proses loading dashboard itu sendiri.
// ---------------------------------------------------------------------

window.__dashboardContextStale = true;

function markDashboardContextStale() {
  window.__dashboardContextStale = true;
  // Event ringan (TANPA data filter) sekadar memberi tahu UI bahwa filter
  // mungkin sudah berubah, supaya app.js bisa menampilkan badge dalam
  // state "belum sinkron" kalau perlu — TIDAK memicu pembacaan filter apa
  // pun di sini.
  window.dispatchEvent(new CustomEvent("dashboardContextStale"));
}

/**
 * Dipanggil dari app.js. Kalau context masih valid (belum ada filter yang
 * berubah sejak terakhir dibaca), langsung kembalikan cache tanpa
 * memanggil API apa pun. Kalau basi, baru benar-benar membaca ulang.
 */
window.__ensureFreshDashboardContext = async function () {
  if (!window.__isTableauExtension) {
    return { text: "", filters: [], totalFilterCount: 0 };
  }
  if (!window.__dashboardContextStale) {
    return {
      text: window.__dashboardContext,
      filters: window.__dashboardFilters,
      totalFilterCount: window.__dashboardContext ? undefined : 0,
    };
  }
  return refreshContext();
};

async function initTableauExtension() {
  if (typeof tableau === "undefined" || !tableau.extensions) {
    // Bukan dijalankan sebagai extension (mis. dibuka sebagai objek Web Page
    // biasa, atau dites langsung di browser) — biarkan chat tetap jalan
    // tanpa konteks dashboard.
    return;
  }

  await tableau.extensions.initializeAsync();
  window.__isTableauExtension = true;

  const dashboard = tableau.extensions.dashboardContent.dashboard;

  // Datasource yang dipakai dashboard hampir tidak pernah berubah selama
  // sesi berjalan (beda dengan filter), jadi cukup dibaca sekali di awal.
  cachedDatasourceNames = await collectDashboardDatasourceNames(dashboard);
  console.debug("[tableau-extension] datasource dashboard:", cachedDatasourceNames);

  // Baca sekali di awal (dashboard belum sibuk re-render apa pun saat baru
  // dimuat, jadi tidak ada resource contention di titik ini) supaya badge
  // langsung terisi begitu extension tampil.
  await refreshContext();

  // CATCH-UP READ: dashboard yang baru dimuat kadang belum benar-benar
  // "settle" persis di momen initializeAsync() resolve (mis. state filter/
  // parameter default masih diterapkan Tableau di belakang layar sesaat
  // setelah itu). Kalau kita cuma baca SEKALI tepat di awal, ada risiko
  // snapshot pertama itu tidak akurat dan TIDAK PERNAH dikoreksi lagi
  // (karena tidak ada event FilterChanged susulan — nilainya memang "sudah
  // dari sono-nya" begitu, bukan hasil perubahan pengguna). Baca ulang
  // sekali lagi beberapa detik kemudian untuk menangkap keadaan yang benar-
  // benar final, SEBELUM pengguna sempat bertanya apa pun.
  setTimeout(() => {
    refreshContext();
  }, 2500);

  // Setiap kali filter di worksheet mana pun berubah, HANYA tandai basi
  // (operasi sinkron, TIDAK ada panggilan API) — TIDAK langsung membaca
  // ulang filter di sini. Pembacaan sungguhan terjadi lazy lewat
  // window.__ensureFreshDashboardContext(), dipanggil app.js pas user kirim
  // pesan atau klik badge. Lihat penjelasan lengkap di atas.
  dashboard.worksheets.forEach((worksheet) => {
    worksheet.addEventListener(tableau.TableauEventType.FilterChanged, markDashboardContextStale);
    // Redundan dengan listener ParameterChanged di level dashboard di
    // bawah — beberapa versi Tableau kadang tidak konsisten memancarkan
    // event ParameterChanged di level dashboard untuk semua jenis
    // parameter, jadi kita pasang juga di tiap worksheet sebagai jaring
    // pengaman. Biaya menandai "basi" dua kali untuk perubahan yang sama
    // (dari dashboard + worksheet) nyaris nol, jadi aman untuk redundan.
    try {
      worksheet.addEventListener(tableau.TableauEventType.ParameterChanged, markDashboardContextStale);
    } catch (err) {
      // Diamkan — sebagian versi API memang tidak mendukung ParameterChanged
      // di level worksheet, itu bukan masalah selama listener dashboard
      // (atau safety-net poll di bawah) tetap menangkapnya.
    }
  });

  // Parameter itu objek level DASHBOARD (bukan per-worksheet), jadi
  // listener-nya dipasang sekali di dashboard, bukan per-worksheet.
  try {
    dashboard.addEventListener(tableau.TableauEventType.ParameterChanged, markDashboardContextStale);
  } catch (err) {
    console.warn("[tableau-extension] Gagal memasang listener ParameterChanged:", err);
  }

  // JARING PENGAMAN TERAKHIR: kalau karena alasan apa pun (versi Tableau,
  // timing, dll.) event ParameterChanged/FilterChanged tidak pernah
  // terpicu untuk suatu perubahan, poll ringan setiap 20 detik untuk
  // membandingkan nilai parameter TERAKHIR yang diketahui vs yang
  // sekarang — HANYA baca via getParametersAsync (murah, bukan seluruh
  // buildDashboardState), dan cuma tandai basi kalau BENAR-BENAR beda.
  let lastKnownParamSignature = "";
  try {
    const initialParams = await dashboard.getParametersAsync();
    lastKnownParamSignature = JSON.stringify(
      initialParams.map((p) => [p.name, p.currentValue && p.currentValue.value])
    );
  } catch (err) {
    // Abaikan — poll berikutnya akan tetap jalan dan menangkap signature awal.
  }
  setInterval(async () => {
    try {
      const params = await dashboard.getParametersAsync();
      const signature = JSON.stringify(params.map((p) => [p.name, p.currentValue && p.currentValue.value]));
      if (signature !== lastKnownParamSignature) {
        lastKnownParamSignature = signature;
        markDashboardContextStale();
      }
    } catch (err) {
      // Diamkan — coba lagi di interval berikutnya.
    }
  }, 20000);
}

initTableauExtension();
