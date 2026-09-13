/* =============================================================================
   app.js — Λογική & UI Υπολογισμού Κυκλοφορητών
   Τα ΔΕΔΟΜΕΝΑ είναι στο data.js (window.DB). Εδώ μόνο μηχανή & διεπαφή.
   ========================================================================== */
(function () {
  "use strict";
  const DB = window.DB;
  const D = DB.DEFAULTS;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };
  const fmt = (n, d = 3) => (isFinite(n) ? n.toFixed(d) : "—");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------------- STATE ---------------- */
  let project = blankProject();
  let selId = null;
  const LS_KEY = "pumpcalc.project.v1";

  function blankProject() {
    const p = {
      meta: { name: "Νέο Έργο", code: "", engineer: "", date: new Date().toISOString().slice(0, 10), notes: "" },
      fluid: D.fluid, concPct: D.concPct, waterTemp: D.waterTemp, marginPct: D.marginPct,
      extras: [], branches: []
    };
    return p;
  }
  function blankBranch(n) {
    const fam = DB.PIPE_FAMILIES[0];
    return {
      id: uid(), name: "L" + n + " — ", Q: NaN,
      pipeFamily: fam.family, pipeSize: fam.sizes[0][0], length: NaN, fittings: []
    };
  }

  /* ---------------- ENGINE ---------------- */
  function nuWater(T) { return 1e-6 * Math.exp(0.5842 - 0.030263 * T + 0.0001295 * T * T); }
  function interp(table, x, col) { // table rows [conc, ratio, sg]
    if (x <= table[0][0]) return table[0][col];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, , ] = table[i - 1], [x1] = table[i];
        const y0 = table[i - 1][col], y1 = table[i][col];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return table[table.length - 1][col];
  }
  function fluidProps() {
    const f = DB.FLUIDS[project.fluid] || DB.FLUIDS.water;
    const nuW = nuWater(num(project.waterTemp));
    if (!f.hasConc) return { nu: nuW, sg: f.sg || 1, label: f.label, mult: 1 };
    const mult = interp(f.table, num(project.concPct), 1);
    const sg = interp(f.table, num(project.concPct), 2);
    return { nu: nuW * mult, sg, label: f.label + " " + num(project.concPct) + "%", mult };
  }
  function lookupPipe(family, size) {
    const fam = DB.PIPE_FAMILIES.find(p => p.family === family);
    if (!fam) return null;
    const row = fam.sizes.find(s => s[0] === size);
    if (!row) return null;
    return { D_ext: row[1], wall: row[2], D_int: row[3], k: fam.k };
  }
  function calcPipe(br, nu) {
    const p = lookupPipe(br.pipeFamily, br.pipeSize);
    const Q = num(br.Q), L = num(br.length);
    if (!p || !(Q > 0) || !(p.D_int > 0)) return { ...(p || {}), v: NaN, Re: NaN, lambda: NaN, dP: NaN };
    const Di = p.D_int / 1000;
    const v = (Q / 3600) / (Math.PI * Di * Di / 4);
    const Re = v * Di / nu;
    const lambda = 0.25 / Math.pow(Math.log10(p.k / (3.7 * p.D_int) + 5.74 / Math.pow(Re, 0.9)), 2);
    const dP = isFinite(L) ? lambda * (L / Di) * (v * v) / (2 * D.g) : NaN;
    return { ...p, v, Re, lambda, dP };
  }
  function calcFitting(f, v, Q) {
    const qty = num(f.qty) || 0, zeta = num(f.zeta), kv = num(f.kv);
    const useKv = isFinite(kv) && kv > 0;
    let per;
    if (useKv) per = Math.pow(Q / kv, 2) * D.barToMWS;
    else per = (isFinite(zeta) ? zeta : 0) * (v * v) / (2 * D.g);
    return { method: useKv ? "Kv" : "ζ", per, total: per * qty, qty };
  }
  function calcBranch(br, nu) {
    const pipe = calcPipe(br, nu);
    const v = pipe.v;
    const Q = num(br.Q);
    let sumFit = 0;
    const fittings = br.fittings.map(f => {
      const r = calcFitting(f, v, Q);
      if (isFinite(r.total)) sumFit += r.total;
      return r;
    });
    const dP = (isFinite(pipe.dP) ? pipe.dP : 0) + sumFit;
    return { pipe, fittings, sumFit, dP };
  }
  function calcProject() {
    const fp = fluidProps();
    let sumBranches = 0;
    const branches = project.branches.map(br => {
      const c = calcBranch(br, fp.nu);
      if (isFinite(c.dP)) sumBranches += c.dP;
      return { br, c };
    });
    let sumExtras = 0;
    project.extras.forEach(e => { const d = num(e.dP); if (isFinite(d)) sumExtras += d; });
    const base = sumBranches + sumExtras;
    const margin = (num(project.marginPct) || 0) / 100;
    const H = base * (1 + margin);
    return { fp, branches, sumBranches, sumExtras, base, H, margin };
  }

  /* ---------------- VALIDATION ---------------- */
  function validate(res) {
    const errors = [], warns = [];
    if (project.branches.length === 0) errors.push("Δεν υπάρχει κανένας κλάδος (L1…).");
    res.branches.forEach(({ br, c }) => {
      const nm = br.name || br.id;
      if (!(num(br.Q) > 0)) errors.push(`${nm}: λείπει η παροχή Q.`);
      if (!(num(br.length) > 0)) errors.push(`${nm}: λείπει το μήκος L.`);
      if (!lookupPipe(br.pipeFamily, br.pipeSize)) errors.push(`${nm}: μη έγκυρη διατομή σωλήνα.`);
      br.fittings.forEach((f, i) => {
        const hasZ = isFinite(num(f.zeta)) && num(f.zeta) > 0;
        const hasK = isFinite(num(f.kv)) && num(f.kv) > 0;
        if (!(num(f.qty) > 0)) errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): λείπουν τεμάχια.`);
        if (!hasZ && !hasK) errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): δώσε ζ ή Kv.`);
      });
      // velocity warnings
      const v = c.pipe.v;
      if (isFinite(v)) {
        if (v < D.vHardMin) warns.push(`${nm}: πολύ χαμηλή ταχύτητα v=${fmt(v, 2)} m/s.`);
        else if (v > D.vHardMax) warns.push(`${nm}: πολύ υψηλή ταχύτητα v=${fmt(v, 2)} m/s (θόρυβος/διάβρωση).`);
        else if (v < D.vIdealMin || v > D.vIdealMax) warns.push(`${nm}: ταχύτητα v=${fmt(v, 2)} m/s εκτός ιδανικού ${D.vIdealMin}-${D.vIdealMax}.`);
      }
    });
    return { errors, warns };
  }

  /* ---------------- RENDER: SIDEBAR ---------------- */
  function renderSidebar(res) {
    const m = project.meta;
    const fl = DB.FLUIDS;
    const fluidOpts = Object.keys(fl).map(k => `<option value="${k}" ${project.fluid === k ? "selected" : ""}>${esc(fl[k].label)}</option>`).join("");
    const concRow = (fl[project.fluid] && fl[project.fluid].hasConc)
      ? `<label>Συγκέντρωση %<input type="number" data-meta="concPct" value="${esc(project.concPct)}" min="0" max="60" step="5"></label>` : "";
    const list = res.branches.map(({ br, c }, i) => {
      const sel = br.id === selId ? "sel" : "";
      const dp = isFinite(c.dP) ? fmt(c.dP) + " mWS" : "<span class='bad'>—</span>";
      return `<li class="britem ${sel}" data-pick="${br.id}">
        <span class="brname">${esc(br.name || "L" + (i + 1))}</span>
        <span class="brdp">${dp}</span>
        <button class="mini" data-del="${br.id}" title="Διαγραφή">✕</button>
      </li>`;
    }).join("");
    const extras = project.extras.map((e, i) => `
      <div class="extra-row" data-extra="${i}">
        <input type="text" data-extra-label="${i}" placeholder="π.χ. Εναλλάκτης" value="${esc(e.label)}">
        <input type="number" data-extra-dp="${i}" placeholder="mWS" step="0.01" value="${esc(e.dP)}">
        <button class="mini" data-extra-del="${i}">✕</button>
      </div>`).join("");

    $("#sidebar").innerHTML = `
      <div class="card">
        <h2>Έργο</h2>
        <label>Όνομα<input type="text" data-meta="name" value="${esc(m.name)}"></label>
        <div class="grid2">
          <label>Κωδικός<input type="text" data-meta="code" value="${esc(m.code)}"></label>
          <label>Ημ/νία<input type="date" data-meta="date" value="${esc(m.date)}"></label>
        </div>
        <label>Μηχανικός<input type="text" data-meta="engineer" value="${esc(m.engineer)}"></label>
      </div>

      <div class="card">
        <h2>Ρευστό & Συνθήκες</h2>
        <div class="grid2">
          <label>Ρευστό<select data-meta="fluid">${fluidOpts}</select></label>
          <label>Θερμ. νερού °C<input type="number" data-meta="waterTemp" value="${esc(project.waterTemp)}" step="1"></label>
        </div>
        ${concRow}
        <label>Προσαύξηση ασφαλείας %<input type="number" data-meta="marginPct" value="${esc(project.marginPct)}" min="0" step="5"></label>
        <p class="hint" id="fluidHint">ν = ${fmt(res.fp.nu * 1e6, 3)}×10⁻⁶ m²/s · ${esc(res.fp.label)} · SG=${fmt(res.fp.sg, 3)}</p>
      </div>

      <div class="card">
        <h2>Κλάδοι <button class="add" data-add-branch>+ Κλάδος</button></h2>
        <ul class="brlist">${list || "<li class='empty'>—</li>"}</ul>
      </div>

      <div class="card">
        <h2>Πρόσθετες απώλειες (καρφωτά) <button class="add" data-add-extra>+</button></h2>
        <p class="hint">π.χ. ΔP εναλλάκτη, μανομετρικό άλλης πηγής — μπαίνουν σταθερά.</p>
        ${extras || ""}
      </div>

      <div class="card total ${ /* color */ ""}">
        <div class="trow"><span>Σ κλάδων</span><b>${fmt(res.sumBranches)} mWS</b></div>
        <div class="trow"><span>Σ καρφωτά</span><b>${fmt(res.sumExtras)} mWS</b></div>
        <div class="trow"><span>Προσαύξηση</span><b>${fmt(res.margin * 100, 0)}%</b></div>
        <div class="trow big"><span>H ΚΥΚΛΟΦΟΡΗΤΗ</span><b>${fmt(res.H)} mWS</b></div>
      </div>

      <div class="card actions">
        <button data-report>🖨 Αναφορά / Εκτύπωση</button>
        <button data-save>💾 Αποθήκευση .json</button>
        <button data-load>📂 Φόρτωση .json</button>
        <button class="ghost" data-new>🗑 Νέο έργο</button>
      </div>`;
  }

  /* ---------------- RENDER: MAIN (branch editor) ---------------- */
  function fittingSelectHTML(selected) {
    return DB.FITTINGS.map(cat =>
      `<optgroup label="${esc(cat.category)}">` +
      cat.items.map(it => `<option value="${esc(it.name)}" ${it.name === selected ? "selected" : ""}>${esc(it.name)}</option>`).join("") +
      `</optgroup>`).join("");
  }
  function findFittingDef(name) {
    for (const cat of DB.FITTINGS) { const it = cat.items.find(i => i.name === name); if (it) return it; }
    return null;
  }
  function renderMain(res) {
    const entry = res.branches.find(x => x.br.id === selId);
    if (!entry) { $("#main").innerHTML = `<div class="placeholder">Διάλεξε ή πρόσθεσε κλάδο από αριστερά.</div>`; return; }
    const { br, c } = entry;
    const famOpts = DB.PIPE_FAMILIES.map(f => `<option ${f.family === br.pipeFamily ? "selected" : ""}>${esc(f.family)}</option>`).join("");
    const fam = DB.PIPE_FAMILIES.find(f => f.family === br.pipeFamily) || DB.PIPE_FAMILIES[0];
    const sizeOpts = fam.sizes.map(s => `<option ${s[0] === br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("");
    const p = c.pipe;

    const fitRows = br.fittings.map((f, i) => {
      const r = c.fittings[i];
      const isKv = r.method === "Kv";
      return `<tr data-fi="${i}">
        <td><select data-fit-type="${i}">${fittingSelectHTML(f.type)}</select></td>
        <td><input type="text" data-fit-size="${i}" value="${esc(f.size || "")}" placeholder="διατομή"></td>
        <td><input type="number" class="n" data-fit-qty="${i}" value="${esc(f.qty)}" min="0" step="1"></td>
        <td><input type="number" class="n ${isKv ? "dim" : ""}" data-fit-zeta="${i}" value="${esc(f.zeta)}" step="0.05" placeholder="ζ"></td>
        <td><input type="number" class="n ${isKv ? "" : "dim"}" data-fit-kv="${i}" value="${esc(f.kv)}" step="0.1" placeholder="Kv"></td>
        <td class="meth">${r.method}</td>
        <td class="out">${fmt(r.per)}</td>
        <td class="out"><b>${fmt(r.total)}</b></td>
        <td><button class="mini" data-fit-del="${i}">✕</button></td>
      </tr>`;
    }).join("");

    $("#main").innerHTML = `
      <div class="card">
        <div class="grid2">
          <label>Όνομα κλάδου<input type="text" data-br="name" value="${esc(br.name)}"></label>
          <label>Παροχή Q (m³/h)<input type="number" class="${num(br.Q) > 0 ? "" : "need"}" data-br="Q" value="${esc(br.Q)}" step="0.01"></label>
        </div>
      </div>

      <div class="card">
        <h2>Σωλήνωση</h2>
        <div class="grid3">
          <label>Υλικό<select data-br="pipeFamily">${famOpts}</select></label>
          <label>Διατομή<select data-br="pipeSize">${sizeOpts}</select></label>
          <label>Μήκος L (m)<input type="number" class="${num(br.length) > 0 ? "" : "need"}" data-br="length" value="${esc(br.length)}" step="0.1"></label>
        </div>
        <table class="res">
          <tr><th>D_int (mm)</th><th>v (m/s)</th><th>Re</th><th>λ</th><th>ΔP σωλ. (mWS)</th></tr>
          <tr>
            <td>${fmt(p.D_int, 2)}</td>
            <td class="${vClass(p.v)}">${fmt(p.v, 3)}</td>
            <td>${isFinite(p.Re) ? Math.round(p.Re).toLocaleString("el") : "—"}</td>
            <td>${fmt(p.lambda, 4)}</td>
            <td><b>${fmt(p.dP)}</b></td>
          </tr>
        </table>
      </div>

      <div class="card">
        <h2>Εξαρτήματα <button class="add" data-add-fit>+ Εξάρτημα</button></h2>
        <table class="fit">
          <thead><tr>
            <th>Είδος</th><th>Διατομή</th><th>Τεμ</th><th>ζ</th><th>Kv</th><th>Μέθ.</th>
            <th>ΔP/τεμ</th><th>ΔP σύν.</th><th></th>
          </tr></thead>
          <tbody>${fitRows || `<tr class="empty"><td colspan="9">— Κανένα εξάρτημα —</td></tr>`}</tbody>
        </table>
        <p class="hint">Αν συμπληρώσεις <b>Kv</b> υπερισχύει της μεθόδου ζ. Η διατομή κληρονομείται από τον σωλήνα αλλά αλλάζει ελεύθερα.</p>
      </div>

      <div class="card total">
        <div class="trow big"><span>ΔP κλάδου (${esc(br.name)})</span><b>${fmt(c.dP)} mWS</b></div>
      </div>`;
  }
  function vClass(v) {
    if (!isFinite(v)) return "";
    if (v < D.vHardMin || v > D.vHardMax) return "v-bad";
    if (v < D.vIdealMin || v > D.vIdealMax) return "v-warn";
    return "v-ok";
  }

  function renderWarnings(val) {
    const box = $("#warnings");
    let html = "";
    if (val.errors.length) html += `<div class="err"><b>⛔ Λείπουν / σφάλματα (${val.errors.length}):</b><ul>${val.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
    if (val.warns.length) html += `<div class="warn"><b>⚠ Προσοχή (${val.warns.length}):</b><ul>${val.warns.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>`;
    if (!html) html = `<div class="ok">✓ Όλα τα πεδία συμπληρωμένα.</div>`;
    box.innerHTML = html;
  }

  /* ---------------- FULL RENDER ---------------- */
  function render() {
    const res = calcProject();
    if (!selId && project.branches.length) selId = project.branches[0].id;
    renderSidebar(res);
    renderMain(res);
    renderWarnings(validate(res));
    save();
  }

  /* ---------------- EVENTS (delegation) ---------------- */
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("click", onClick);

  const META_KEYS = ["name", "code", "engineer", "date", "notes"];
  function onInput(e) {
    const t = e.target;
    // meta text/number that should NOT restructure (live, no rerender of inputs)
    if (t.dataset.meta && t.dataset.meta !== "fluid") {
      const k = t.dataset.meta;
      if (META_KEYS.includes(k)) project.meta[k] = t.value; else project[k] = t.value;
      liveRecalc(); softMeta(); return;
    }
    if (t.dataset.br && t.dataset.br !== "pipeFamily" && t.dataset.br !== "pipeSize") {
      const br = curBranch(); if (br) { br[t.dataset.br] = t.value; liveRecalc(); }
      return;
    }
    if (t.hasAttribute("data-extra-label")) { project.extras[+t.getAttribute("data-extra-label")].label = t.value; return; }
    if (t.hasAttribute("data-extra-dp")) { project.extras[+t.getAttribute("data-extra-dp")].dP = t.value; liveRecalc(); softMeta(); return; }
    // fittings numeric
    const fi = fitIndex(t);
    if (fi !== null) {
      const br = curBranch();
      if (t.hasAttribute("data-fit-qty")) br.fittings[fi].qty = t.value;
      else if (t.hasAttribute("data-fit-zeta")) br.fittings[fi].zeta = t.value;
      else if (t.hasAttribute("data-fit-kv")) br.fittings[fi].kv = t.value;
      else if (t.hasAttribute("data-fit-size")) br.fittings[fi].size = t.value;
      liveRecalc();
      return;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.meta === "fluid") { project.fluid = t.value; render(); return; }
    if (t.dataset.br === "pipeFamily") {
      const br = curBranch(); br.pipeFamily = t.value;
      const fam = DB.PIPE_FAMILIES.find(f => f.family === t.value);
      br.pipeSize = fam.sizes[0][0];
      render(); return;
    }
    if (t.dataset.br === "pipeSize") { curBranch().pipeSize = t.value; render(); return; }
    if (t.hasAttribute("data-fit-type")) {
      const br = curBranch(), fi = +t.getAttribute("data-fit-type");
      const def = findFittingDef(t.value);
      br.fittings[fi].type = t.value;
      if (def) {
        br.fittings[fi].zeta = (def.zeta != null && def.zeta !== 0) ? def.zeta : (def.custom ? "" : (def.zeta || 0));
        br.fittings[fi].kv = (def.kv != null) ? def.kv : "";
      }
      render(); return;
    }
  }

  function onClick(e) {
    const t = e.target;
    const pick = t.closest("[data-pick]");
    if (pick) { selId = pick.getAttribute("data-pick"); render(); return; }
    if (t.hasAttribute("data-del")) { const id = t.getAttribute("data-del"); project.branches = project.branches.filter(b => b.id !== id); if (selId === id) selId = project.branches[0] && project.branches[0].id; render(); return; }
    if (t.hasAttribute("data-add-branch")) { const b = blankBranch(project.branches.length + 1); project.branches.push(b); selId = b.id; render(); return; }
    if (t.hasAttribute("data-add-fit")) { const br = curBranch(); if (br) { const def = DB.FITTINGS[0].items[0]; br.fittings.push({ type: def.name, size: br.pipeSize, qty: 1, zeta: def.zeta || "", kv: def.kv || "" }); render(); } return; }
    if (t.hasAttribute("data-fit-del")) { const br = curBranch(); br.fittings.splice(+t.getAttribute("data-fit-del"), 1); render(); return; }
    if (t.hasAttribute("data-add-extra")) { project.extras.push({ label: "", dP: "" }); render(); return; }
    if (t.hasAttribute("data-extra-del")) { project.extras.splice(+t.getAttribute("data-extra-del"), 1); render(); return; }
    if (t.hasAttribute("data-report")) { openReport(); return; }
    if (t.hasAttribute("data-save")) { saveFile(); return; }
    if (t.hasAttribute("data-load")) { $("#fileInput").click(); return; }
    if (t.hasAttribute("data-new")) { if (confirm("Νέο έργο; Τα μη αποθηκευμένα δεδομένα θα χαθούν.")) { project = blankProject(); selId = null; render(); } return; }
  }

  function curBranch() { return project.branches.find(b => b.id === selId); }
  function fitIndex(t) {
    for (const a of ["data-fit-qty", "data-fit-zeta", "data-fit-kv", "data-fit-size"])
      if (t.hasAttribute(a)) return +t.getAttribute(a);
    return null;
  }

  /* ---- light recalc without rebuilding inputs (keeps focus while typing) ---- */
  function liveRecalc() {
    const res = calcProject();
    const entry = res.branches.find(x => x.br.id === selId);
    if (entry) {
      // pipe outputs
      const p = entry.c.pipe;
      const main = $("#main");
      const cells = main && main.querySelector("table.res");
      if (cells) {
        const tds = cells.rows[1].cells;
        tds[0].textContent = fmt(p.D_int, 2);
        tds[1].textContent = fmt(p.v, 3); tds[1].className = vClass(p.v);
        tds[2].textContent = isFinite(p.Re) ? Math.round(p.Re).toLocaleString("el") : "—";
        tds[3].textContent = fmt(p.lambda, 4);
        tds[4].innerHTML = "<b>" + fmt(p.dP) + "</b>";
      }
      // fitting outputs
      entry.c.fittings.forEach((r, i) => {
        const row = main.querySelector(`tr[data-fi="${i}"]`);
        if (row) { row.querySelector(".meth").textContent = r.method; const outs = row.querySelectorAll(".out"); outs[0].textContent = fmt(r.per); outs[1].innerHTML = "<b>" + fmt(r.total) + "</b>"; }
      });
      const tot = main.querySelector(".total .big b");
      if (tot) tot.textContent = fmt(entry.c.dP) + " mWS";
    }
    softMeta(res);
    renderWarnings(validate(res));
    save();
  }
  function softMeta(res) {
    res = res || calcProject();
    // update sidebar totals + branch dp + hint without full rebuild
    const tcard = $("#sidebar .total");
    if (tcard) {
      const bs = tcard.querySelectorAll(".trow b");
      bs[0].textContent = fmt(res.sumBranches) + " mWS";
      bs[1].textContent = fmt(res.sumExtras) + " mWS";
      bs[2].textContent = fmt(res.margin * 100, 0) + "%";
      bs[3].textContent = fmt(res.H) + " mWS";
    }
    res.branches.forEach(({ br, c }) => {
      const li = $(`#sidebar .britem[data-pick="${br.id}"] .brdp`);
      if (li) li.innerHTML = isFinite(c.dP) ? fmt(c.dP) + " mWS" : "<span class='bad'>—</span>";
      const nm = $(`#sidebar .britem[data-pick="${br.id}"] .brname`);
      if (nm) nm.textContent = br.name || br.id;
    });
    const hint = $("#fluidHint");
    if (hint) hint.textContent = `ν = ${fmt(res.fp.nu * 1e6, 3)}×10⁻⁶ m²/s · ${res.fp.label} · SG=${fmt(res.fp.sg, 3)}`;
  }

  /* ---------------- PERSISTENCE ---------------- */
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (e) { } }
  function load() { try { const s = localStorage.getItem(LS_KEY); if (s) { project = JSON.parse(s); migrate(); } } catch (e) { } }
  function migrate() {
    project.meta = project.meta || {};
    project.extras = project.extras || [];
    project.branches = (project.branches || []).map(b => { b.fittings = b.fittings || []; b.id = b.id || uid(); return b; });
  }
  function saveFile() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const safe = (project.meta.code || project.meta.name || "project").replace(/[^\p{L}\p{N}\-]+/gu, "_");
    a.href = URL.createObjectURL(blob); a.download = "kykloforitis_" + safe + ".json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => { try { project = JSON.parse(r.result); migrate(); selId = project.branches[0] && project.branches[0].id; render(); } catch (e) { alert("Μη έγκυρο αρχείο .json"); } };
    r.readAsText(file);
  }

  /* ---------------- REPORT ---------------- */
  function openReport() {
    const res = calcProject();
    const val = validate(res);
    if (val.errors.length && !confirm(`Υπάρχουν ${val.errors.length} ελλείψεις/σφάλματα. Συνέχεια στην αναφορά;`)) return;
    const m = project.meta;
    const rows = res.branches.map(({ br, c }, i) => {
      const p = c.pipe;
      const fits = br.fittings.map((f, j) => {
        const r = c.fittings[j];
        return `<tr><td>${esc(f.type)}</td><td>${esc(f.size || "")}</td><td class="r">${esc(f.qty)}</td>
          <td class="r">${r.method === "ζ" ? esc(f.zeta) : "—"}</td><td class="r">${r.method === "Kv" ? esc(f.kv) : "—"}</td>
          <td class="r">${fmt(r.per)}</td><td class="r">${fmt(r.total)}</td></tr>`;
      }).join("");
      return `<section class="br">
        <h3>${esc(br.name || "L" + (i + 1))} — Q = ${esc(br.Q)} m³/h</h3>
        <table class="t"><tr><th>Υλικό</th><th>Διατομή</th><th>D_int</th><th>L (m)</th><th>v (m/s)</th><th>Re</th><th>λ</th><th>ΔP σωλ.</th></tr>
          <tr><td>${esc(br.pipeFamily)}</td><td>${esc(br.pipeSize)}</td><td class="r">${fmt(p.D_int, 2)}</td><td class="r">${esc(br.length)}</td>
          <td class="r">${fmt(p.v, 3)}</td><td class="r">${isFinite(p.Re) ? Math.round(p.Re) : "—"}</td><td class="r">${fmt(p.lambda, 4)}</td><td class="r">${fmt(p.dP)}</td></tr></table>
        ${fits ? `<table class="t"><tr><th>Εξάρτημα</th><th>Διατομή</th><th>Τεμ</th><th>ζ</th><th>Kv</th><th>ΔP/τεμ</th><th>ΔP σύν.</th></tr>${fits}</table>` : ""}
        <p class="dpline">ΔP κλάδου = <b>${fmt(c.dP)} mWS</b></p>
      </section>`;
    }).join("");

    const summary = res.branches.map(({ br, c }, i) => `<tr><td>${esc(br.name || "L" + (i + 1))}</td><td class="r">${fmt(c.dP)}</td></tr>`).join("")
      + project.extras.map(e => `<tr><td>${esc(e.label || "Καρφωτό")}</td><td class="r">${fmt(num(e.dP))}</td></tr>`).join("");

    const theory = DB.THEORY.map(t => `<tr><td>${esc(t[0])}</td><td><code>${esc(t[1])}</code></td><td>${esc(t[2])}</td><td>${esc(t[3])}</td></tr>`).join("");

    const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Αναφορά Κυκλοφορητή — ${esc(m.name)}</title>
      <style>
        *{box-sizing:border-box} body{font:13px/1.5 "Segoe UI",Arial,sans-serif;color:#1c2733;margin:26px}
        .band{height:6px;background:linear-gradient(90deg,#16395f,#2d6cdf 55%,#37c5d8);border-radius:3px;margin-bottom:14px}
        h1{font-size:21px;margin:0 0 3px;color:#16395f;letter-spacing:.2px}
        h2{font-size:14px;color:#16395f;text-transform:uppercase;letter-spacing:.8px;
           border-bottom:2px solid #2d6cdf;padding-bottom:4px;margin:24px 0 9px}
        h3{font-size:13.5px;margin:15px 0 5px;color:#2d6cdf}
        .meta{color:#5a6c80;font-size:12px;line-height:1.6}
        table.t{border-collapse:collapse;width:100%;margin:5px 0 9px}
        table.t th,table.t td{border:1px solid #cdd6e2;padding:4px 7px;text-align:left;font-variant-numeric:tabular-nums}
        table.t th{background:#eef3fb;color:#16395f;font-size:11.5px;text-transform:uppercase;letter-spacing:.3px}
        table.t tr:nth-child(even) td{background:#f8fafd}
        .r{text-align:right} .sum{border-collapse:collapse;min-width:360px}
        .sum th,.sum td{border:1px solid #b9c6da;padding:5px 10px;font-variant-numeric:tabular-nums}
        .sum tr:nth-child(even) td{background:#f8fafd}
        .sum tr:last-child{font-weight:bold;background:#fff3d6}
        .sum tr:last-child td{background:#fff3d6;border-color:#e0c87f}
        .H{font-size:17px;color:#0a7d3c;margin:10px 0;padding:9px 14px;background:#eafaf1;
           border:1px solid #a9dfbf;border-left:5px solid #0a7d3c;border-radius:6px}
        .dpline{margin:3px 0 0;color:#333;text-align:right}
        .dpline b{background:#fff3d6;padding:2px 8px;border-radius:4px;border:1px solid #e0c87f}
        code{background:#f3f5f9;padding:1px 5px;border-radius:3px;font-size:11.5px}
        section.br{page-break-inside:avoid}
        .note{color:#8a97a6;font-size:11px;margin-top:32px;border-top:1px solid #dde4ec;padding-top:8px}
        @media print{body{margin:10mm} .br{page-break-inside:avoid}}
      </style></head><body>
      <div class="band"></div>
      <h1>Υπολογισμός Μανομετρικού Κυκλοφορητή</h1>
      <div class="meta">${esc(m.name)} ${m.code ? "· " + esc(m.code) : ""} ${m.engineer ? "· " + esc(m.engineer) : ""} · ${esc(m.date)}<br>
        Ρευστό: ${esc(res.fp.label)} · ν=${fmt(res.fp.nu * 1e6, 3)}×10⁻⁶ m²/s · Θερμ.=${esc(project.waterTemp)}°C · Προσαύξηση=${esc(project.marginPct)}%</div>

      <h2>Σύνοψη</h2>
      <table class="sum">${summary}
        <tr><td>Σ (καθαρό)</td><td class="r">${fmt(res.base)}</td></tr>
        <tr><td>H κυκλοφορητή (×${fmt(1 + res.margin, 2)})</td><td class="r">${fmt(res.H)} mWS</td></tr></table>
      <p class="H">► Απαιτούμενο μανομετρικό H = ${fmt(res.H)} mWS &nbsp;|&nbsp; Παροχή σχεδιασμού (μέγ. κλάδου): δες κλάδους</p>

      <h2>Αναλυτικά ανά κλάδο</h2>
      ${rows}

      <h2>Παράρτημα — Τύποι</h2>
      <table class="t"><tr><th>Μέγεθος</th><th>Τύπος</th><th>Μον.</th><th>Σημείωση</th></tr>${theory}</table>
      <p class="note">Παράχθηκε από PumpCalculator v${DB.VERSION}. Τιμές ζ/γλυκόλης ενδεικτικές — επαλήθευσε με datasheet.</p>
      </body></html>`;

    const w = window.open("", "_blank");
    if (!w) { alert("Επίτρεψε τα pop-ups για την αναφορά."); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { } }, 300);
  }

  /* ---------------- TEST HOOK (δεν επηρεάζει τη χρήση) ---------------- */
  window.PumpEngine = {
    nuWater, interp, fluidProps, lookupPipe, calcPipe, calcFitting, calcBranch,
    calcProject, validate,
    setProject(p) { project = p; },
    getProject() { return project; }
  };

  /* ---------------- INIT ---------------- */
  function init() {
    load();
    if (!project.branches.length) project.branches.push(blankBranch(1));
    selId = project.branches[0].id;
    $("#fileInput").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
