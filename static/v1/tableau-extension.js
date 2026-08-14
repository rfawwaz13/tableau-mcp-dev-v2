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

  for (const worksheet of dashboard.worksheets) {
    try {
      const datasources = await worksheet.getDataSourcesAsync();
      datasources.forEach((ds) => names.add(ds.name));
    } catch (err) {
      console.warn(`Gagal membaca datasource worksheet "${worksheet.name}":`, err);
    }
  }

  return Array.from(names);
}

/**
 * Interpretasi SATU objek Filter Tableau jadi DUA representasi sekaligus:
 *   - text: baris ringkasan untuk badge UI / prompt LLM (konteks bacaan)
 *   - vds: objek filter siap-pakai skema VizQL Data Service, dengan bentuk
 *     PERSIS seperti yang diharapkan oleh endpoint query-datasource
 *     (field.fieldCaption, filterType, dst). Field null kalau field ini
 *     harus dianggap "tidak ada filter" (mis. isAllSelected, atau nilainya
 *     literal "ALL").
 *
 * Lihat: https://tableau.github.io/extensions-api/docs/interfaces/filter.html
 * dan: https://help.tableau.com/current/api/vizql-data-service/en-us/docs/vds_create_queries.html
 */
function interpretFilter(filter) {
  try {
    switch (filter.filterType) {
      case "categorical": {
        if (filter.isAllSelected) return null;
        const values = (filter.appliedValues || []).map((v) => v.formattedValue);
        if (values.length === 0) return null;
        // Sentinel "ALL" dipakai datasource ini sebagai baris agregat/total,
        // bukan filter sungguhan -> perlakukan sebagai tidak ada filter.
        if (values.length === 1 && values[0].trim().toUpperCase() === "ALL") return null;

        return {
          text: `${filter.fieldName} = [${values.join(", ")}]`,
          vds: {
            field: { fieldCaption: filter.fieldName },
            filterType: "SET",
            values,
            exclude: false,
          },
        };
      }

      case "range": {
        const minVal = filter.minValue ? filter.minValue.value : null;
        const maxVal = filter.maxValue ? filter.maxValue.value : null;
        const minText = filter.minValue ? filter.minValue.formattedValue : null;
        const maxText = filter.maxValue ? filter.maxValue.formattedValue : null;
        if (minVal === null && maxVal === null) return null;

        return {
          text: `${filter.fieldName} antara ${minText ?? "-∞"} dan ${maxText ?? "∞"}`,
          vds: {
            field: { fieldCaption: filter.fieldName },
            filterType: "QUANTITATIVE_NUMERICAL",
            quantitativeFilterType: "RANGE",
            min: minVal,
            max: maxVal,
          },
        };
      }

      case "relative-date": {
        return {
          text: `${filter.fieldName} = relative date (${filter.periodType}, rentang ${filter.rangeType}, anchor ${filter.anchorDate})`,
          vds: {
            field: { fieldCaption: filter.fieldName },
            filterType: "DATE",
            periodType: filter.periodType,
            dateRangeType: filter.rangeType,
          },
        };
      }

      case "hierarchical": {
        const values = (filter.appliedValues || []).map((v) => v.formattedValue);
        if (values.length === 0) return null;
        if (values.length === 1 && values[0].trim().toUpperCase() === "ALL") return null;

        return {
          text: `${filter.fieldName} = [${values.join(", ")}]`,
          vds: {
            field: { fieldCaption: filter.fieldName },
            filterType: "SET",
            values,
            exclude: false,
          },
        };
      }

      default:
        // Tipe filter yang tidak dikenali: tetap dicatat di teks supaya
        // terlihat, tapi TIDAK dibuatkan objek VDS (daripada mengirim
        // filter yang salah bentuk ke Tableau).
        return {
          text: `${filter.fieldName} (filter tipe "${filter.filterType}" aktif, detail tidak dibaca)`,
          vds: null,
        };
    }
  } catch (err) {
    console.warn("Gagal menginterpretasi filter:", filter, err);
    return null;
  }
}

async function buildDashboardState() {
  const dashboard = tableau.extensions.dashboardContent.dashboard;

  // Kumpulkan dulu per-worksheet, lalu gabungkan worksheet yang kombinasi
  // filternya identik (umum terjadi kalau dashboard punya banyak worksheet
  // "helper" KPI yang semuanya terikat filter global yang sama).
  const filterTextToWorksheets = new Map();

  // Semua objek filter VDS unik dikumpulkan di sini (key = fieldCaption,
  // supaya field yang sama dari worksheet berbeda tidak dobel).
  const vdsFiltersByField = new Map();

  for (const worksheet of dashboard.worksheets) {
    let filters = [];
    try {
      filters = await worksheet.getFiltersAsync();
    } catch (err) {
      console.warn(`Gagal membaca filter worksheet "${worksheet.name}":`, err);
      continue;
    }

    const interpreted = filters.map(interpretFilter).filter((f) => f !== null);
    if (interpreted.length === 0) continue;

    const textLines = interpreted.map((f) => f.text);
    const key = textLines.join("; ");
    if (!filterTextToWorksheets.has(key)) {
      filterTextToWorksheets.set(key, []);
    }
    filterTextToWorksheets.get(key).push(worksheet.name);

    interpreted.forEach((f) => {
      if (f.vds) {
        vdsFiltersByField.set(f.vds.field.fieldCaption, f.vds);
      }
    });
  }

  // ---------- teks untuk badge UI & prompt LLM ----------

  const scopeLine =
    cachedDatasourceNames.length > 0
      ? `Dashboard "${dashboard.name}" HANYA menggunakan datasource berikut — ` +
        `jangan query datasource lain di luar daftar ini kecuali pengguna eksplisit ` +
        `minta data di luar dashboard: ${cachedDatasourceNames.map((n) => `"${n}"`).join(", ")}.`
      : `Dashboard "${dashboard.name}".`;

  let filterSection;
  if (filterTextToWorksheets.size === 0) {
    filterSection = "Tidak ada filter aktif saat ini.";
  } else {
    const lines = [];
    for (const [filterText, worksheetNames] of filterTextToWorksheets) {
      const label =
        worksheetNames.length === 1
          ? `Worksheet "${worksheetNames[0]}"`
          : `Worksheet ${worksheetNames.map((n) => `"${n}"`).join(", ")}`;
      lines.push(`${label}: ${filterText}`);
    }
    filterSection = `Filter aktif:\n${lines.join("\n")}`;
  }

  filterSection +=
    "\n(Catatan: filter di atas akan DITERAPKAN OTOMATIS oleh sistem ke setiap " +
    "query_datasource yang kamu jalankan untuk datasource dashboard ini — kamu " +
    "TIDAK PERLU menambahkannya sendiri secara manual ke parameter 'filters'.)";

  let contextText = `${scopeLine}\n${filterSection}`;
  const MAX_LENGTH = 2000;
  if (contextText.length > MAX_LENGTH) {
    contextText = contextText.slice(0, MAX_LENGTH) + "\n… (dipotong, terlalu banyak filter aktif)";
  }

  return {
    contextText,
    dashboardFilters: Array.from(vdsFiltersByField.values()),
  };
}

async function refreshContext() {
  try {
    const { contextText, dashboardFilters } = await buildDashboardState();
    window.__dashboardContext = contextText;
    window.__dashboardFilters = dashboardFilters;
  } catch (err) {
    console.error("Gagal membaca konteks dashboard:", err);
    window.__dashboardContext = "";
    window.__dashboardFilters = [];
  }
  console.debug("[tableau-extension] konteks diperbarui:", window.__dashboardContext);
  console.debug("[tableau-extension] filter VDS siap-pakai:", window.__dashboardFilters);
  window.dispatchEvent(
    new CustomEvent("dashboardContextUpdated", {
      detail: { text: window.__dashboardContext, filters: window.__dashboardFilters },
    })
  );
}

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

  await refreshContext();

  // Perbarui konteks setiap kali filter di worksheet mana pun berubah.
  dashboard.worksheets.forEach((worksheet) => {
    worksheet.addEventListener(tableau.TableauEventType.FilterChanged, refreshContext);
  });
}

initTableauExtension();
