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
 *        - window.__dashboardDatasources    (array nama datasource yang
 *          BENAR-BENAR dipakai worksheet yang visible SEKARANG, dikirim ke
 *          backend supaya query_datasource yang menyasar datasource DI LUAR
 *          daftar ini bisa ditolak deterministik -- lihat
 *          dashboard_filters.py::datasource_in_scope)
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
window.__dashboardDatasources = [];
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
  "P.Remark Online": "Mkpd Online",
};

// ---------------------------------------------------------------------
// PETA NILAI MENTAH PARAMETER -> NILAI SEBENARNYA DI KOLOM TARGET.
//
// Beberapa parameter Tableau memakai KODE ANGKA (mis. 1/2/3) sebagai nilai
// MENTAH-nya, padahal yang ditampilkan ke pengguna di UI Tableau adalah
// label lewat calculated field/alias (mis. "ALL"/"OFFLINE"/"ONLINE").
// param.currentValue.value SELALU nilai MENTAH (bukan label yang tampil)
// -- kalau kolom TARGET di datasource sebenarnya berisi STRING label itu
// (bukan angka kodenya), memaksakan filter dengan nilai mentah (1/2/3)
// TIDAK PERNAH cocok dengan isi kolom -> hasilnya 0 baris, meski nama
// field & scope datasource-nya sudah benar.
//
// Isi di sini kalau menemukan kasus begini: key = nama parameter (SAMA
// PERSIS seperti di PARAMETER_FIELD_MAP), value = objek {nilai_mentah:
// "label_yang_benar_di_kolom"}. Kalau parameter tidak terdaftar di sini,
// nilai mentahnya dipakai apa adanya (perilaku lama, tidak berubah).
//
// const PARAMETER_VALUE_MAP = {};
const PARAMETER_VALUE_MAP = {
  "P.Remark Online": { 1: "ALL", 2: "OFFLINE", 3: "ONLINE" },
};

// ---------------------------------------------------------------------
// TABLEAU DATE-PART WRAPPER (bawaan Tableau, generik untuk SEMUA field).
//
// Kalau sebuah filter di UI Tableau didiskritkan ke granularitas tertentu
// (mis. dropdown "Month/Year" di filter shelf), Extensions API melaporkan
// `filter.fieldName` BUKAN nama kolom asli, tapi dibungkus sintaks internal
// Tableau seperti "MY(Mkpd Period)" (MY = Month/Year). Dua konsekuensi:
//   1. appliedValues.value untuk filter semacam ini SELALU teks tampilan
//      (mis. "February 2024"), TIDAK PERNAH objek Date — field yang
//      genuinely bertipe tanggal MENTAH (tanpa wrapper) sudah ditangani
//      otomatis lewat cabang `instanceof Date` di buildSetOrDateFilter().
//   2. "MY(Mkpd Period)" itu sendiri BUKAN nama kolom yang valid untuk
//      dikirim ke VizQL Data Service — kolom aslinya adalah "Mkpd Period"
//      (isi di dalam kurung), jadi WAJIB di-unwrap sebelum jadi fieldCaption
//      di query, apa pun hasil parsing nilainya (berhasil ATAU fallback).
//
// Ditangani GENERIK di sini (bukan per-nama-field, beda dari DATE_TEXT_FIELDS
// di bawah) karena "MY(...)" adalah konvensi BAWAAN Tableau — berlaku untuk
// field APA PUN yang kebetulan difilter dengan granularitas Month/Year,
// tidak perlu didaftarkan satu-satu tiap ditemukan field baru.
//
// Tambahkan prefix baru di sini kalau suatu saat menemukan wrapper Tableau
// lain (mis. "QY" untuk Quarter/Year) — perlu format parser barunya juga di
// parseDateTextValue().
//
// CATATAN: nilai MENTAH (appliedValues[].value) untuk filter "MY(...)"
// TERNYATA berupa INTEGER format YYYYMM (mis. 202402 untuk Februari 2024),
// BUKAN teks nama bulan ("February 2024" itu cuma formattedValue-nya untuk
// tampilan) -- jadi formatnya "YYYYMM_INT", bukan "MONTH_YEAR".
const DATE_PART_WRAPPER_FORMATS = {
  MY: "YYYYMM_INT",
};

/**
 * Kalau fieldName berbentuk "PREFIX(NamaKolomAsli)" dan PREFIX terdaftar di
 * DATE_PART_WRAPPER_FORMATS, kembalikan { innerField, format }. Kalau tidak
 * cocok pola itu sama sekali (kasus paling umum — field biasa), return null.
 */
function matchDatePartWrapper(fieldName) {
  const match = /^([A-Za-z_]+)\((.+)\)$/.exec(String(fieldName ?? "").trim());
  if (!match) return null;
  const format = DATE_PART_WRAPPER_FORMATS[match[1].toUpperCase()];
  if (!format) return null;
  return { innerField: match[2].trim(), format };
}

// ---------------------------------------------------------------------
// FIELD FILTER CARD LAIN (di luar wrapper Tableau di atas) yang nilainya
// berupa TEKS TANGGAL custom (mis. calculated field yang memformat tanggal
// jadi teks sendiri, BUKAN lewat mekanisme date-part Tableau). Beda dari
// PARAMETER_VALUE_MAP di atas — field di sini adalah filter CARD biasa
// (worksheet), bukan parameter.
//
// key = nama field PERSIS SAMA seperti fieldCaption (BUKAN yang dibungkus
// wrapper "MY(...)" dkk. — itu sudah otomatis ditangani di atas), value =
// format parsing (lihat parseDateTextValue). Format yang didukung SEKARANG:
//   "MONTH_YEAR" -> teks "<NamaBulanInggris> <Tahun4digit>" (mis. "February
//   2024"), dikonversi ke tanggal 1 di bulan itu format ISO ("2024-02-01").
//
// const DATE_TEXT_FIELDS = {};
const DATE_TEXT_FIELDS = {};

const MONTH_NAMES_EN = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Parse SATU nilai tanggal mentah sesuai `format` jadi string ISO
 * "YYYY-MM-DD" (SELALU tanggal 1 di bulan itu untuk format berbasis bulan).
 * Format yang didukung:
 *   - "MONTH_YEAR": teks "<NamaBulanInggris> <Tahun4digit>" (mis.
 *     "February 2024") -- dipakai untuk DATE_TEXT_FIELDS custom.
 *   - "YYYYMM_INT": angka/string 6 digit "YYYYMM" (mis. 202402 atau
 *     "202402") -- dipakai untuk wrapper Tableau "MY(...)", yang nilai
 *     MENTAHNYA integer, bukan teks nama bulan.
 * Return `null` kalau nilainya tidak cocok pola yang diharapkan (JANGAN
 * menebak/memaksakan -- pemanggil harus fallback ke perilaku SET string
 * biasa kalau ini null).
 */
function parseDateTextValue(text, format) {
  if (format === "MONTH_YEAR") {
    const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(String(text ?? "").trim());
    if (!match) return null;
    const monthIndex = MONTH_NAMES_EN.indexOf(match[1].toLowerCase());
    if (monthIndex === -1) return null;
    const year = match[2];
    const month = String(monthIndex + 1).padStart(2, "0");
    return `${year}-${month}-01`;
  }
  if (format === "YYYYMM_INT") {
    const match = /^(\d{4})(\d{2})$/.exec(String(text ?? "").trim());
    if (!match) return null;
    const year = match[1];
    const month = match[2];
    const monthNum = Number(month);
    if (monthNum < 1 || monthNum > 12) return null;
    return `${year}-${month}-01`;
  }
  return null;
}

// ---------------------------------------------------------------------
// CATATAN: pengecualian field-dari-force-apply (dulu diatur di sini lewat
// EXCLUDED_FILTER_FIELDS) SEKARANG diatur di filter_exclusions.json (root
// proyek, dibaca backend) — supaya cuma ada SATU tempat untuk mengelola
// exclusion, bukan dua (satu di frontend/JS, satu di backend/JSON).
// filter_exclusions.json juga strictly lebih mampu: mendukung exclusion
// per-datasource dan bersyarat-nilai (when_values_include), yang tidak
// bisa dilakukan lewat mekanisme lama di sini.
//
// Field calculated boolean GATE yang dibangun dari parameter (mis.
// "Branch Change" = ([P.Branch List] = [Mkpd Branch Name])) TETAP harus
// dikecualikan dari force-apply — VDS mengevaluasinya pakai nilai
// parameter PUBLISHED/default (bukan live), yang bisa BERTENTANGAN dengan
// filter target yang benar dari PARAMETER_FIELD_MAP (mis. "Branch
// Change=True" tersirat "Mkpd Branch Name = ALL" kalau default
// parameter-nya "ALL", padahal Anda sedang pilih "CIKOKOL" —
// dikombinasikan, hasilnya NOL baris). Field seperti ini sekarang
// didaftarkan di filter_exclusions.json bagian "global" (lihat entry
// "Branch Change", "Mkpd Branch", "Mkpd Gender" di sana).
//
// Beda dari sebelumnya: field ini SEKARANG tetap dikirim sebagai vds
// (bukan null) dan TAMPIL di teks konteks tanpa anotasi khusus — tapi
// tetap TIDAK PERNAH dipaksakan ke query_datasource, karena dibuang di
// backend (dashboard_filters.py) sebelum query dijalankan.

// Batas waktu per-panggilan API ke satu worksheet. Kalau Tableau lambat
// merespons untuk worksheet tertentu (mis. worksheet tersembunyi yang
// jarang di-render), kita TIDAK menunggu tanpa batas — anggap saja
// worksheet itu "tidak berkontribusi filter" untuk request ini, daripada
// membuat seluruh proses menggantung berpuluh detik/menit.
//
// Diturunkan dari 60000 -> 15000: 60 detik terlalu lama untuk API yang
// seharusnya instan (kalau genuinely macet, pengguna sudah lama menunggu
// SEBELUM pesan chat-nya bahkan terkirim) — turunkan supaya gagal LEBIH
// CEPAT dan kelihatan (lihat log warning di withTimeout di bawah), bukan
// diam-diam menunggu semenit penuh baru fallback ke [] tanpa jejak apa pun.
const WORKSHEET_FETCH_TIMEOUT_MS = 60000;

/**
 * `label` (opsional) dipakai untuk mencatat log WARNING kalau cabang
 * timeout yang menang (bukan promise aslinya) — sebelumnya SENYAP TOTAL
 * (tidak ada log apa pun saat fallback terpakai), sehingga kalau
 * getDataSourcesAsync()/getFiltersAsync() genuinely macet/lambat untuk
 * suatu worksheet, tidak ada jejak sama sekali untuk didiagnosis. Sekarang
 * kalau ini terjadi, akan langsung terlihat di console browser.
 */
function withTimeout(promise, ms, fallbackValue, label) {
  let timedOut = false;
  return Promise.race([
    promise,
    new Promise((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve(fallbackValue);
      }, ms)
    ),
  ]).then((result) => {
    if (timedOut) {
      console.warn(
        `[tableau-extension] TIMEOUT (${ms}ms) menunggu ${label || "operasi Tableau API"} -- ` +
          `memakai fallback kosong. Kalau ini sering muncul, ada worksheet/koneksi yang genuinely lambat/macet.`
      );
    }
    return result;
  });
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
    parameters = await withTimeout(
      dashboard.getParametersAsync(),
      WORKSHEET_FETCH_TIMEOUT_MS,
      [],
      "getParametersAsync (dashboard)"
    );
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
      //
      // Kalau parameter ini terdaftar di PARAMETER_VALUE_MAP, terjemahkan
      // dulu nilai MENTAHNYA (mis. 1/2/3) ke label yang benar-benar ada di
      // kolom target (mis. "ALL"/"OFFLINE"/"ONLINE") -- lihat penjelasan di
      // definisi PARAMETER_VALUE_MAP di atas. Kalau nilai mentah yang
      // muncul TIDAK ada di tabelnya (mis. parameter punya opsi baru yang
      // belum didaftarkan), JANGAN diam-diam pakai nilai yang salah --
      // catat warning dan tetap pakai nilai mentah apa adanya sebagai
      // fallback (perilaku lama), supaya admin tahu perlu menambah entri.
      let filterValue = cv.value;
      const valueMap = PARAMETER_VALUE_MAP[param.name];
      if (valueMap) {
        if (Object.prototype.hasOwnProperty.call(valueMap, cv.value)) {
          filterValue = valueMap[cv.value];
        } else {
          console.warn(
            `[tableau-extension] Nilai parameter "${param.name}" = ${cv.value} tidak ada di ` +
              `PARAMETER_VALUE_MAP -- memakai nilai mentah apa adanya. Tambahkan entrinya kalau ` +
              `ini bukan nilai yang seharusnya diabaikan.`
          );
        }
      }
      vds = {
        field: { fieldCaption },
        filterType: "SET",
        values: [filterValue],
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

// Nama-nama datasource yang dipakai worksheet yang SEDANG VISIBLE. Diisi
// ULANG setiap kali buildDashboardState() jalan (BUKAN sekali di init) —
// dashboard dengan sub-page/tab yang masing-masing memakai datasource
// berbeda (mis. "All"/"Offline" vs "Online") butuh ini tetap akurat
// mengikuti sub-page mana yang sedang aktif, bukan nyangkut ke datasource
// sub-page pertama yang kebetulan aktif saat extension pertama dimuat.
let cachedDatasourceNames = [];

// Nama worksheet yang visible SAAT TERAKHIR KALI context berhasil dibaca
// (lihat buildDashboardState). Dipakai oleh hasVisibleWorksheetSetChanged()
// di bawah sebagai deteksi MURAH (sinkron, TANPA panggilan API apa pun)
// untuk perpindahan sub-page/tab -- lihat penjelasan lengkap di dekat
// definisi hasVisibleWorksheetSetChanged().
let lastKnownVisibleWorksheetNames = [];

/**
 * Cek MURAH (properti dashboard.objects sudah tersedia LOKAL di client,
 * TIDAK perlu round-trip network) apakah SET worksheet yang sedang visible
 * berbeda dari saat terakhir context berhasil dibaca. Dipakai sebagai
 * pemicu TAMBAHAN untuk memaksa refresh (selain event FilterChanged/
 * ParameterChanged biasa), khusus untuk mendeteksi pengguna berpindah sub-
 * page lewat mekanisme Show/Hide Container -- yang TIDAK memicu event
 * Extensions API apa pun (lihat window.__ensureFreshDashboardContext).
 *
 * SENGAJA tidak memanggil getFiltersAsync()/getDataSourcesAsync() di sini
 * (itu yang mahal & bisa terlihat sebagai dashboard "refresh" kalau
 * dilakukan di SETIAP pesan chat) -- cukup bandingkan NAMA worksheet yang
 * visible, cukup untuk mendeteksi "halaman sudah berbeda", baru KALAU
 * benar berbeda baru lakukan pembacaan penuh yang mahal itu.
 */
function hasVisibleWorksheetSetChanged() {
  let current;
  try {
    const dashboard = tableau.extensions.dashboardContent.dashboard;
    current = getVisibleWorksheets(dashboard)
      .map((ws) => ws.name)
      .sort();
  } catch (err) {
    return false; // gagal cek -> jangan memaksa refresh gara-gara ini, biarkan flag stale biasa yang menentukan
  }
  return JSON.stringify(current) !== JSON.stringify(lastKnownVisibleWorksheetNames);
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

  // Kalau fieldName dibungkus wrapper date-part bawaan Tableau (mis. "MY(Mkpd
  // Period)"), nama kolom ASLI yang valid untuk VizQL Data Service adalah isi
  // di dalam kurung -- WAJIB dipakai di SEMUA cabang di bawah (bukan cuma
  // saat parsing teks-tanggal berhasil), karena "MY(Mkpd Period)" itu sendiri
  // BUKAN nama kolom yang bisa dikenali VDS sama sekali. Kalau tidak match
  // wrapper apa pun, targetFieldCaption = fieldName apa adanya (perilaku lama).
  const wrapperMatch = matchDatePartWrapper(fieldName);
  const targetFieldCaption = wrapperMatch ? wrapperMatch.innerField : fieldName;
  const dateTextFormat = wrapperMatch ? wrapperMatch.format : DATE_TEXT_FIELDS[fieldName];

  // Field TEKS TANGGAL (dari wrapper Tableau di atas, ATAU dari
  // DATE_TEXT_FIELDS untuk kasus custom) -- field-nya bertipe STRING di
  // Tableau (bukan tanggal asli), jadi TIDAK akan pernah masuk cabang
  // `instanceof Date` di bawah. Coba parse SEMUA nilai yang dipilih; kalau
  // SEMUA berhasil, kirim sebagai QUANTITATIVE_DATE (cocok dengan format
  // kolom ISO asli di datasource) alih-alih SET string literal ("February
  // 2024") yang tidak akan pernah match. Kalau ADA yang gagal di-parse
  // (format tak terduga), fallback AMAN ke perilaku SET string biasa di
  // bawah + catat warning, JANGAN diam-diam kirim data yang salah.
  if (dateTextFormat) {
    const parsedIsoDates = withValue.map((v) => parseDateTextValue(v.value, dateTextFormat));
    if (parsedIsoDates.every((d) => d !== null)) {
      const minDate = parsedIsoDates.reduce((a, b) => (a < b ? a : b));
      const maxDate = parsedIsoDates.reduce((a, b) => (a > b ? a : b));
      return {
        text: displayText,
        vds: {
          field: { fieldCaption: targetFieldCaption },
          filterType: "QUANTITATIVE_DATE",
          quantitativeFilterType: "RANGE",
          minDate,
          maxDate,
        },
      };
    }
    console.warn(
      `[tableau-extension] Gagal mem-parsing nilai field teks-tanggal "${fieldName}" ` +
        `(format "${dateTextFormat}") dari nilai: ${JSON.stringify(withValue.map((v) => v.value))} -- ` +
        `fallback ke filter SET string biasa (kemungkinan besar TIDAK akan match kolom aslinya).`
    );
  }

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
        field: { fieldCaption: targetFieldCaption },
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
      field: { fieldCaption: targetFieldCaption },
      filterType: "SET",
      values: rawValues,
      exclude: false,
    },
  };
}

function interpretFilter(filter) {
  // Field calculated boolean GATE (mis. "Branch Change") dulu dikecualikan
  // di SINI (lewat EXCLUDED_FILTER_FIELDS) -- sekarang exclusion-nya
  // ditangani SATU tempat saja di backend lewat filter_exclusions.json
  // (bagian "global"), supaya tidak ada dua mekanisme paralel. Field ini
  // tetap diproses NORMAL di bawah (vds tetap dibuat), dan tetap tampil
  // di teks konteks tanpa anotasi khusus -- backend yang membuang filternya
  // sebelum query dijalankan, lihat dashboard_filters.py.

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

  // Datasource ASAL tiap field (union nama datasource dari semua worksheet
  // yang berkontribusi filter untuk field ini) — dipakai untuk men-tag
  // tiap filter dengan `sourceDatasources`, supaya backend HANYA
  // memaksakan filter ini ke query_datasource yang benar-benar menyasar
  // datasource yang sama (lihat dashboard_filters.py). Ini mencegah filter
  // dengan konvensi nilai spesifik ke SATU datasource (mis. literal "ALL"
  // untuk datasource ber-CUBE) "bocor" ke datasource lain yang skemanya
  // berbeda (mis. sub-page "Online" yang bukan CUBE) dan menghasilkan 0 baris.
  const fieldDatasources = new Map(); // fieldCaption -> Set<datasourceName>

  const worksheets = getVisibleWorksheets(dashboard);

  // Perbarui baseline untuk hasVisibleWorksheetSetChanged() SEKARANG (bukan
  // di akhir fungsi) -- baseline harus mencerminkan worksheet yang SEDANG
  // dibaca oleh pembacaan penuh ini, supaya perbandingan berikutnya akurat.
  lastKnownVisibleWorksheetNames = worksheets.map((ws) => ws.name).sort();

  // Promise.all, BUKAN for...of sequential -> getFiltersAsync()/
  // getDataSourcesAsync() untuk semua worksheet dipanggil BERSAMAAN. Dengan
  // banyak worksheet, loop sequential sebelumnya jadi penyumbang utama lag
  // saat filter diubah (worksheet ke-N baru mulai di-fetch setelah
  // worksheet ke-(N-1) selesai). Timeout per worksheet mencegah SATU
  // worksheet lambat (mis. tersembunyi/jarang di-render) menahan seluruh
  // proses berpuluh detik.
  const perWorksheetResults = await Promise.all(
    worksheets.map(async (worksheet) => {
      let filters = [];
      try {
        filters = await withTimeout(
          worksheet.getFiltersAsync(),
          WORKSHEET_FETCH_TIMEOUT_MS,
          null,
          `getFiltersAsync worksheet "${worksheet.name}"`
        );
        if (filters === null) {
          console.warn(`[tableau-extension] Timeout membaca filter worksheet "${worksheet.name}", dilewati.`);
          filters = [];
        }
      } catch (err) {
        console.warn(`Gagal membaca filter worksheet "${worksheet.name}":`, err);
        filters = [];
      }

      let datasourceNames = [];
      try {
        const datasources = await withTimeout(
          worksheet.getDataSourcesAsync(),
          WORKSHEET_FETCH_TIMEOUT_MS,
          [],
          `getDataSourcesAsync worksheet "${worksheet.name}"`
        );
        datasourceNames = datasources.map((ds) => ds.name);
        if (datasourceNames.length === 0) {
          console.warn(
            `[tableau-extension] getDataSourcesAsync() untuk worksheet "${worksheet.name}" ` +
              `mengembalikan 0 datasource (bukan timeout -- ini hasil ASLI dari Tableau). ` +
              `Kalau worksheet ini seharusnya punya datasource, ini yang menyebabkan baris ` +
              `"Datasource: ..." hilang dari konteks.`
          );
        }
      } catch (err) {
        console.warn(`Gagal membaca datasource worksheet "${worksheet.name}":`, err);
      }

      const interpreted = filters.map(interpretFilter).filter((f) => f !== null);
      return { worksheetName: worksheet.name, interpreted, datasourceNames };
    })
  );

  // cachedDatasourceNames dihitung ULANG di sini setiap kali (BUKAN sekali
  // di init) — union datasource dari worksheet yang SEDANG visible, supaya
  // tetap akurat kalau pengguna pindah sub-page/tab yang memakai datasource
  // berbeda (dipicu ulang lewat event FilterChanged/ParameterChanged dari
  // mekanisme swap sub-page yang menandai context basi).
  const datasourceNameSet = new Set();
  perWorksheetResults.forEach(({ datasourceNames }) => {
    datasourceNames.forEach((n) => datasourceNameSet.add(n));
  });
  cachedDatasourceNames = Array.from(datasourceNameSet);

  // Teks tampilan per field (untuk transparansi di badge/prompt) — HANYA
  // untuk display, bukan otoritatif untuk filtering (itu tugas
  // fieldValueVotes/vdsFiltersByField di bawah).
  const fieldDisplayText = new Map();

  for (const { interpreted, datasourceNames } of perWorksheetResults) {
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

      if (!fieldDatasources.has(fieldCaption)) {
        fieldDatasources.set(fieldCaption, new Set());
      }
      const dsSet = fieldDatasources.get(fieldCaption);
      datasourceNames.forEach((n) => dsSet.add(n));
    });
  }

  console.debug(
    `[tableau-extension] ${worksheets.length} worksheet visible dibaca:`,
    worksheets.map((ws) => ws.name),
    "-- per-worksheet datasource:",
    perWorksheetResults.map((r) => ({ worksheet: r.worksheetName, datasources: r.datasourceNames }))
  );

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
    const vds = entries[0].vds;
    // sourceDatasources kosong/null berarti "berlaku untuk semua datasource"
    // (fail-open) — lihat _filter_applies_to_datasource di dashboard_filters.py.
    const datasourceNames = Array.from(fieldDatasources.get(fieldCaption) || []);
    vds.sourceDatasources = datasourceNames.length > 0 ? datasourceNames : null;
    vdsFiltersByField.set(fieldCaption, vds);
    if (entries.length > 1) {
      conflictNotes.push(`${fieldCaption} (nilai tidak konsisten antar-worksheet, dipakai yang mayoritas)`);
    }
  }

  // Parameter dashboard (BUKAN filter — lihat collectParameterFilters di
  // atas untuk penjelasan bedanya). Parameter levelnya WORKBOOK, bukan
  // per-worksheet, jadi TIDAK diikat ke datasource tertentu
  // (sourceDatasources dibiarkan null/broadcast) — kalau field targetnya
  // tidak ada di suatu datasource, itu sudah ditangani terpisah oleh
  // proactive field-check di tableau_client.py (field dibuang otomatis +
  // dicatat ke pengguna).
  //
  // PRIORITAS: filter dari WORKSHEET CARD (di atas) MENANG kalau field
  // targetnya SUDAH punya nilai dari sana -- parameter HANYA dipakai untuk
  // field yang belum punya filter card sama sekali. Ini SENGAJA dibalik
  // dari perilaku lama (parameter selalu menimpa): parameter itu level
  // WORKBOOK dan bisa saja sebenarnya "milik" sub-page LAIN yang kebetulan
  // dipetakan (lewat PARAMETER_FIELD_MAP) ke fieldCaption yang SAMA dengan
  // field yang di halaman INI punya filter card-nya sendiri secara
  // independen (mis. parameter "P.Remark Online" -> field "Mkpd Online",
  // padahal worksheet di halaman "Sales Offline" ini SUDAH punya filter
  // card "Mkpd Online" sendiri) -- nilai parameter yang stale/tidak
  // terkait halaman ini TIDAK BOLEH menimpa nilai filter card yang justru
  // paling akurat mencerminkan halaman yang SEDANG dilihat pengguna.
  const parameterFilters = await collectParameterFilters(dashboard);
  for (const p of parameterFilters) {
    allFilterFieldsSeen.add(p.field);
    fieldDisplayText.set(p.field, p.text);
    p.vds.sourceDatasources = null;

    const fieldCaption = p.vds.field.fieldCaption;
    if (vdsFiltersByField.has(fieldCaption)) {
      console.warn(
        `[tableau-extension] Parameter "${p.field}" dipetakan ke field "${fieldCaption}" yang ` +
          `SUDAH punya filter dari worksheet card di halaman ini -- nilai dari WORKSHEET FILTER ` +
          `CARD yang dipakai (bukan nilai parameter), karena parameter level-workbook bisa saja ` +
          `sebenarnya untuk sub-page lain.`
      );
      continue;
    }
    vdsFiltersByField.set(fieldCaption, p.vds);
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
    datasourceNames: cachedDatasourceNames,
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
    window.__dashboardDatasources = state.datasourceNames;
    totalFilterCount = state.totalFilterCount;
  } catch (err) {
    console.error("Gagal membaca konteks dashboard:", err);
    window.__dashboardContext = "";
    window.__dashboardFilters = [];
    window.__dashboardDatasources = [];
  }
  window.__dashboardContextStale = false;
  console.debug("[tableau-extension] konteks diperbarui:", window.__dashboardContext);
  console.debug("[tableau-extension] filter VDS siap-pakai:", window.__dashboardFilters);
  console.debug("[tableau-extension] datasource scope saat ini:", window.__dashboardDatasources);
  window.dispatchEvent(
    new CustomEvent("dashboardContextUpdated", {
      detail: {
        text: window.__dashboardContext,
        filters: window.__dashboardFilters,
        datasourceNames: window.__dashboardDatasources,
        totalFilterCount,
      },
    })
  );
  return {
    text: window.__dashboardContext,
    filters: window.__dashboardFilters,
    datasourceNames: window.__dashboardDatasources,
    totalFilterCount,
  };
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
 * Dipanggil dari app.js SEBELUM tiap pesan chat dikirim. Kalau context
 * masih valid (belum ada filter yang berubah sejak terakhir dibaca, DAN
 * set worksheet yang visible juga tidak berubah), langsung kembalikan
 * cache TANPA memanggil API apa pun ke Tableau -- ini yang mencegah
 * dashboard "refresh"/round-trip berulang di SETIAP pesan chat padahal
 * tidak ada yang berubah. Kalau salah satu basi (event filter/parameter
 * SUNGGUHAN, ATAU pengguna pindah sub-page lewat Show/Hide Container yang
 * terdeteksi lewat hasVisibleWorksheetSetChanged), baru benar-benar
 * membaca ulang penuh.
 */
window.__ensureFreshDashboardContext = async function () {
  if (!window.__isTableauExtension) {
    return { text: "", filters: [], datasourceNames: [], totalFilterCount: 0 };
  }
  if (!window.__dashboardContextStale && !hasVisibleWorksheetSetChanged()) {
    return {
      text: window.__dashboardContext,
      filters: window.__dashboardFilters,
      datasourceNames: window.__dashboardDatasources,
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

  // cachedDatasourceNames dihitung di dalam buildDashboardState() (dipanggil
  // oleh refreshContext() di bawah), dan dihitung ULANG setiap refresh —
  // bukan cuma sekali di init — supaya tetap akurat kalau dashboard punya
  // beberapa sub-page/tab yang memakai datasource berbeda-beda.
  //
  // Baca sekali di awal (dashboard belum sibuk re-render apa pun saat baru
  // dimuat, jadi tidak ada resource contention di titik ini) supaya badge
  // langsung terisi begitu extension tampil.
  await refreshContext();
  console.debug("[tableau-extension] datasource dashboard:", cachedDatasourceNames);

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
