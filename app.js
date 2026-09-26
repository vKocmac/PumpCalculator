/* =============================================================================
   app.js — Λογική & UI Υπολογισμού Κυκλοφορητή
   Τα ΔΕΔΟΜΕΝΑ είναι στο data.js (window.DB). Εδώ μόνο μηχανή & διεπαφή.

   Δύο τρόποι:
   • Απλή διαδρομή: κλάδοι σε σειρά (όπως το Excel) — όλοι αθροίζονται.
   • Δίκτυο: κάθε κλάδος ξεκινά από το τέλος ενός άλλου (ή από την αρχή του
     βρόχου). Διαδρομή = από την αρχή ως ένα τέλος. H από τη δυσμενέστερη
     ΠΛΗΡΗ διαδρομή. Ελλιπείς κλάδοι δεν μετρούν και το H σημαίνεται προσωρινό.
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
  const trunc = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; };
  const kindOf = (id) => DB.KINDS.find(k => k.id === id) || DB.KINDS[DB.KINDS.length - 1];

  /* ---------------- STATE ---------------- */
  let project = blankProject();
  let selId = null;
  let pop = null;            // ανοιχτό μενού «+» στο σχηματικό: { id, x, y }
  let curveOpen = false;
  let selNode = null;        // επιλεγμένο σημείο στο δίκτυο
  let netFull = false;       // μεγέθυνση του σχεδίου
  // Αποθήκευση στον browser ανά ΕΚΔΟΣΗ: νέα έκδοση = καθαρό ξεκίνημα.
  const APP_VERSION = (typeof window !== "undefined" && window.APP_VERSION) || DB.VERSION;
  const LS_KEY = "pumpcalc.project." + APP_VERSION;
  let restorable = null;     // έργο της προηγούμενης επίσκεψης (ίδια έκδοση), αν υπάρχει

  function blankProject() {
    return {
      v: 4, mode: "simple",
      meta: { name: "Νέο έργο", code: "", engineer: "", date: new Date().toISOString().slice(0, 10), notes: "" },
      fluid: D.fluid, concPct: D.concPct, waterTemp: D.waterTemp, marginPct: D.marginPct, dT: D.dT,
      aged: false, openCircuit: false, staticHead: "",
      start: { type: DB.START_TYPES[0], label: "", dP: "", unit: "kPa" },
      extras: [], branches: [],
      net: { nodes: [{ id: uid(), type: "pump", label: "Αντλία", dP: "", unit: "kPa", Q: "", loadKW: "" }], edges: [] },
      pump: { points: [{ Q: "", H: "" }, { Q: "", H: "" }, { Q: "", H: "" }], eta: "" }
    };
  }
  function nextCode() {
    let n = 0;
    const list = project.mode === "network" && project.net ? project.net.edges : project.branches;
    list.forEach(b => { const m = /^L(\d+)/i.exec(b.code || ""); if (m) n = Math.max(n, +m[1]); });
    return "L" + (n + 1);
  }
  function blankBranch(parentId, like) {
    const fam = like ? DB.PIPE_FAMILIES.find(f => f.family === like.pipeFamily) : null;
    const f0 = fam || DB.PIPE_FAMILIES[0];
    return {
      id: uid(), code: nextCode(), desc: "", kind: like ? like.kind : "pe",
      parent: parentId || null, Q: "", loadKW: "",
      pipeFamily: f0.family, pipeSize: like && fam ? like.pipeSize : f0.sizes[0][0], length: "",
      fittings: [], equip: []
    };
  }

  /* ---------------- ENGINE: δέντρο ---------------- */
  function treeOf(brs) {
    const byId = new Map(brs.map(b => [b.id, b]));
    const kids = new Map(brs.map(b => [b.id, []]));
    const roots = [];
    brs.forEach(b => { if (b.parent && byId.has(b.parent)) kids.get(b.parent).push(b.id); else roots.push(b.id); });
    const seen = new Set(), order = [];
    const walk = (id) => { if (seen.has(id)) return; seen.add(id); order.push(id); kids.get(id).forEach(walk); };
    roots.forEach(walk);
    const cyclic = brs.filter(b => !seen.has(b.id)).map(b => b.id);
    cyclic.forEach(id => order.push(id));
    return { byId, kids, roots, order, cyclic };
  }
  function isChainTree(t) { return t.roots.length <= 1 && !t.cyclic.length && [...t.kids.values()].every(k => k.length <= 1); }
  function descendants(id, tree) {
    const out = new Set(); const st = [id];
    while (st.length) { const x = st.pop(); (tree.kids.get(x) || []).forEach(k => { if (!out.has(k)) { out.add(k); st.push(k); } }); }
    return out;
  }

  /* Συμπληρώνει ό,τι λείπει και μεταφέρει παλιά αρχεία (idempotent).
     Παλιό αρχείο = κανένας κλάδος δεν έχει «parent»: οι κλάδοι ήταν όλοι σε σειρά,
     άρα απλή διαδρομή με «συνολικό μήκος» — δίνει ακριβώς το ίδιο H. */
  function normalize(p) {
    p.meta = p.meta || {};
    p.extras = (p.extras || []).map(e => ({ label: e.label || "", dP: e.dP, unit: e.unit || "m" }));
    p.pump = p.pump || { points: [], eta: "" };
    p.pump.points = p.pump.points || [];
    while (p.pump.points.length < 3) p.pump.points.push({ Q: "", H: "" });
    p.start = p.start || { type: DB.START_TYPES[0], label: "", dP: "", unit: "kPa" };
    if (!p.start.unit) p.start.unit = "kPa";
    if (p.start.dP === undefined) p.start.dP = "";
    if (p.dT === undefined) p.dT = D.dT;
    const brs = p.branches = p.branches || [];
    const legacy = brs.length > 0 && brs.every(b => b.parent === undefined);
    brs.forEach((b, i) => {
      b.id = b.id || uid();
      if (b.code === undefined) {
        const nm = String(b.name || "").trim();
        const m = /^(\S+?)\s*[—–-]\s*(.*)$/.exec(nm);
        if (m) { b.code = m[1]; b.desc = m[2].trim(); } else { b.code = nm || "L" + (i + 1); b.desc = b.desc || ""; }
      }
      if (b.desc === undefined) b.desc = "";
      if (legacy) { b.parent = i > 0 ? brs[i - 1].id : null; b.kind = b.kind || "t"; }
      if (b.parent === undefined) b.parent = null;
      if (!DB.KINDS.some(k => k.id === b.kind)) b.kind = "t";   // παλιά «Π», «Ε», «Σύν.» → χωρίς διπλασιασμό
      b.fittings = b.fittings || [];
      b.equip = (b.equip || []).map(e => ({ label: e.label || "", dP: e.dP, unit: e.unit || "kPa" }));
      if (b.loadKW === undefined) b.loadKW = "";
    });
    const ids = new Set(brs.map(b => b.id));
    brs.forEach(b => { if (b.parent && (!ids.has(b.parent) || b.parent === b.id)) b.parent = null; });
    const t = treeOf(brs);
    if (p.mode !== "simple" && p.mode !== "network") p.mode = legacy || isChainTree(t) ? "simple" : "network";
    if (p.mode === "simple") {
      if (!isChainTree(t)) p.mode = "network";             // ποτέ δεν χάνουμε τοπολογία σιωπηλά
      else {
        const ordered = t.order.map(id => t.byId.get(id));
        ordered.forEach((b, i) => { b.parent = i > 0 ? ordered[i - 1].id : null; });
        p.branches = ordered;
      }
    }
    // Παλιό «δίκτυο» (δέντρο κλάδων, v2.1–2.2) → σημεία + σωλήνες, ίδιο H
    if (p.mode === "network" && !(p.net && p.net.edges && p.net.edges.length) && p.branches.length) {
      p.net = treeToGraph(p);
      p.branches = []; p.extras = []; p.start = { type: "Αντλία", label: "", dP: "", unit: "kPa" };
    }
    normalizeNet(p);
    p.v = 4;
    return p;
  }

  /* ---------------- ENGINE: ρευστό ---------------- */
  function nuWater(T) { return 1e-6 * Math.exp(0.5842 - 0.030263 * T + 0.0001295 * T * T); }
  function interp(table, x, col) { // table rows [x, ...]
    if (x <= table[0][0]) return table[0][col];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const x0 = table[i - 1][0], x1 = table[i][0];
        const y0 = table[i - 1][col], y1 = table[i][col];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return table[table.length - 1][col];
  }
  function bracket(arr, x) {
    if (x <= arr[0]) return { i: 0, t: 0, clamped: x < arr[0] };
    const n = arr.length - 1;
    if (x >= arr[n]) return { i: n - 1, t: 1, clamped: x > arr[n] };
    for (let i = 0; i < n; i++) if (x <= arr[i + 1]) return { i, t: (x - arr[i]) / (arr[i + 1] - arr[i]), clamped: false };
    return { i: n - 1, t: 1, clamped: true };
  }
  /* Διγραμμική παρεμβολή σε πίνακα [συγκέντρωση][θερμοκρασία].
     Αν κάποια γωνία είναι κάτω από την πήξη (null), χρησιμοποιεί μόνο την
     πυκνότερη συγκέντρωση (συντηρητικό για ιξώδες) και σημαιώνει approx. */
  function lookup2(tbl, T, c) {
    const G = DB.GLYCOL_GRID;
    const bt = bracket(G.T, T), bc = bracket(G.C, c);
    const corners = [
      [bc.i, bt.i, (1 - bc.t) * (1 - bt.t)], [bc.i, bt.i + 1, (1 - bc.t) * bt.t],
      [bc.i + 1, bt.i, bc.t * (1 - bt.t)], [bc.i + 1, bt.i + 1, bc.t * bt.t]
    ];
    let v = 0, ok = true;
    corners.forEach(([ci, ti, w]) => { if (w === 0) return; const y = tbl[ci][ti]; if (y == null) ok = false; else v += w * y; });
    if (ok) return { v, approx: false, clamped: bt.clamped || bc.clamped };
    const hi = tbl[bc.i + 1], a = hi[bt.i], b = hi[bt.i + 1];
    if (a != null && b != null) return { v: a + (b - a) * bt.t, approx: true, clamped: bt.clamped || bc.clamped };
    return { v: NaN, approx: true, clamped: bt.clamped || bc.clamped };
  }
  function fluidProps() {
    const key = DB.FLUIDS[project.fluid] ? project.fluid : "water";
    const f = DB.FLUIDS[key];
    const T = num(project.waterTemp);
    const tab = f.hasConc ? DB.GLYCOL[key] : DB.GLYCOL.pg;   // η γραμμή 0% είναι νερό
    const cRaw = f.hasConc ? num(project.concPct) : 0;
    const c = Math.min(Math.max(isFinite(cRaw) ? cRaw : 0, 0), 60);
    const tFreeze = interp(DB.GLYCOL_GRID.C.map((cc, i) => [cc, tab.tFreeze[i]]), c, 1);
    const frozen = !(T > tFreeze) && !(c === 0 && T >= 0);
    const r = f.hasConc ? lookup2(tab.ratio, T, c) : { v: 1, approx: false, clamped: false };
    const rho = lookup2(tab.rho, T, c), cp = lookup2(tab.cp, T, c);
    const nu = nuWater(T) * r.v;
    const label = f.label + (f.hasConc ? " " + c + "%" : "");
    return {
      nu, mult: r.v, rho: rho.v, cp: cp.v, sg: rho.v / 1000, label, conc: c, T, tFreeze,
      frozen: frozen || !isFinite(nu) || !isFinite(rho.v),
      approx: r.approx || rho.approx, clamped: r.clamped || rho.clamped || (f.hasConc && cRaw > 60)
    };
  }
  const toKPa = (h, fp) => h * fp.rho * D.g / 1000;
  const toM = (dP, unit, fp) => { const d = num(dP); if (!isFinite(d)) return NaN; return unit === "kPa" ? d * 1000 / (fp.rho * D.g) : d; };

  /* ---------------- ENGINE: σωλήνες & εξαρτήματα ---------------- */
  function lookupPipe(family, size) {
    const fam = DB.PIPE_FAMILIES.find(p => p.family === family);
    if (!fam) return null;
    const row = fam.sizes.find(s => s[0] === size);
    if (!row) return null;
    return { D_ext: row[1], wall: row[2], D_int: row[3], k: fam.k };
  }
  function kEff(family) {
    const fam = DB.PIPE_FAMILIES.find(p => p.family === family);
    if (!fam) return NaN;
    return project.aged && fam.kAged != null ? fam.kAged : fam.k;
  }
  function swameeJain(Re, k, Dmm) { return 0.25 / Math.pow(Math.log10(k / (3.7 * Dmm) + 5.74 / Math.pow(Re, 0.9)), 2); }
  function friction(Re, k, Dmm) {
    if (!(Re > 0)) return NaN;
    if (Re < D.reLam) return 64 / Re;
    if (Re >= D.reTurb) return swameeJain(Re, k, Dmm);
    const l0 = 64 / D.reLam, l1 = swameeJain(D.reTurb, k, Dmm);
    return l0 + (l1 - l0) * (Re - D.reLam) / (D.reTurb - D.reLam);
  }
  function regimeOf(Re) { return !(Re > 0) ? "" : Re < D.reLam ? "στρωτή" : Re < D.reTurb ? "μεταβατική" : "τυρβώδης"; }
  function lengthEff(br) { const L = num(br.length); return kindOf(br.kind).double ? 2 * L : L; }
  function qFromLoad(br, fp) {
    const P = num(br.loadKW), dT = num(project.dT);
    if (!(P > 0)) return NaN;
    fp = fp || fluidProps();
    return dT > 0 ? 3600 * P / (fp.rho * fp.cp * dT) : NaN;
  }
  function qOf(br, fp) { return num(br.loadKW) > 0 ? qFromLoad(br, fp) : num(br.Q); }
  function calcPipe(br, nu, fp, Qin) {
    const p = lookupPipe(br.pipeFamily, br.pipeSize);
    const Q = Qin !== undefined ? Qin : num(br.Q), L = lengthEff(br);
    if (!p || !(Q > 0) || !(p.D_int > 0)) return { ...(p || {}), v: NaN, Re: NaN, lambda: NaN, dP: NaN, R: NaN, Leff: L };
    const k = isFinite(kEff(br.pipeFamily)) ? kEff(br.pipeFamily) : p.k;
    const Di = p.D_int / 1000;
    const v = (Q / 3600) / (Math.PI * Di * Di / 4);
    const Re = v * Di / nu;
    const lambda = friction(Re, k, p.D_int);
    const dP = isFinite(L) ? lambda * (L / Di) * (v * v) / (2 * D.g) : NaN;
    const rho = fp ? fp.rho : 1000;
    const R = lambda / Di * rho * v * v / 2;
    return { ...p, k, v, Re, lambda, dP, R, Leff: L, regime: regimeOf(Re) };
  }
  function calcFitting(f, v, Q) {
    const qty = num(f.qty) || 0, zeta = num(f.zeta), kv = num(f.kv);
    const useKv = isFinite(kv) && kv > 0;
    let per;
    if (useKv) per = Math.pow(Q / kv, 2) * D.barToMWS;
    else per = (isFinite(zeta) ? zeta : 0) * (v * v) / (2 * D.g);
    return { method: useKv ? "Kv" : "ζ", per, total: per * qty, qty };
  }
  function findFittingDef(name) {
    for (const cat of DB.FITTINGS) { const it = cat.items.find(i => i.name === name); if (it) return it; }
    return null;
  }
  function calcBranch(br, nu, fp, Qin) {
    fp = fp || fluidProps();
    const Q = Qin !== undefined ? Qin : qOf(br, fp);
    const pipe = calcPipe(br, nu, fp, Q);
    const fam = DB.PIPE_FAMILIES.find(p => p.family === br.pipeFamily);
    let sumFit = 0;
    const fittings = br.fittings.map(f => {
      // Διατομή εξαρτήματος: αν είναι άλλη διατομή της ίδιας οικογένειας, ζ με τη δική της ταχύτητα
      let v = pipe.v, D_used = pipe.D_int;
      const row = fam && f.size && f.size !== br.pipeSize ? fam.sizes.find(s => s[0] === f.size) : null;
      if (row && Q > 0) { const Di = row[3] / 1000; v = (Q / 3600) / (Math.PI * Di * Di / 4); D_used = row[3]; }
      const r = calcFitting(f, v, Q);
      r.v = v; r.D = D_used; r.ownSize = !!row;
      const def = findFittingDef(f.type);
      r.role = def && def.role ? def.role : "";
      if (isFinite(r.total)) sumFit += r.total;
      return r;
    });
    let sumEquip = 0;
    const equip = (br.equip || []).map(e => { const m = toM(e.dP, e.unit, fp); if (isFinite(m)) sumEquip += m; return m; });
    const pipeDP = isFinite(pipe.dP) ? pipe.dP : 0;
    const dP = pipeDP + sumFit + sumEquip;
    // Authority βάνας ελέγχου: ΔP βάνας / ΔP όλου του κλάδου όπου βρίσκεται
    let ctrl = null;
    fittings.forEach((r, i) => { if (r.role === "control" && isFinite(r.per) && r.per > 0 && dP > 0) ctrl = { i, dPv: r.per, auth: r.per / dP }; });
    const bal = fittings.map((r, i) => (r.role === "balancing" && isFinite(r.per) ? { i, kPa: toKPa(r.per, fp) } : null)).filter(Boolean);
    return { Q, pipe, fittings, sumFit, equip, sumEquip, dP, ctrl, bal };
  }

  /* Παροχές: στο δίκτυο, κλάδος χωρίς Q/φορτίο παίρνει Σ των κλάδων μετά. */
  function computeQ(tree, fp) {
    const out = new Map();
    const q = (id, guard) => {
      if (out.has(id)) return out.get(id);
      const b = tree.byId.get(id), ks = tree.kids.get(id) || [];
      let r;
      if (num(b.loadKW) > 0) r = { Q: qFromLoad(b, fp), src: "load" };
      else if (num(b.Q) > 0) r = { Q: num(b.Q), src: "manual" };
      else if (project.mode === "network" && ks.length && !guard.has(id)) {
        guard.add(id);
        const qs = ks.map(k => q(k, guard).Q);
        r = { Q: qs.every(x => x > 0) ? qs.reduce((a, x) => a + x, 0) : NaN, src: "auto" };
      } else r = { Q: NaN, src: "none" };
      out.set(id, r); return r;
    };
    tree.order.forEach(id => q(id, new Set()));
    return out;
  }

  /* ---------------- ENGINE: έλεγχοι κλάδου ---------------- */
  function branchLabel(br) { return br.code || br.name || br.id; }
  function branchErrors(br, c) {
    const errors = [], missing = [];
    const nm = branchLabel(br);
    if (!(c.Q > 0)) {
      errors.push(project.mode === "network" ? `${nm}: λείπει η παροχή Q — δώσε Q εδώ ή παροχή/φορτίο σε εξοπλισμό, ώστε να βγει από το ισοζύγιο.`
        : c.Qsrc === "auto" ? `${nm}: λείπει η παροχή Q — βγαίνει από τους κλάδους μετά, που δεν έχουν όλοι Q.` : `${nm}: λείπει η παροχή Q.`);
      missing.push("Q");
    }
    if (!(num(br.length) > 0)) { errors.push(`${nm}: λείπει το μήκος L.`); missing.push("μήκος"); }
    if (!lookupPipe(br.pipeFamily, br.pipeSize)) { errors.push(`${nm}: μη έγκυρη διατομή σωλήνα.`); missing.push("διατομή"); }
    let mf = false;
    br.fittings.forEach((f, i) => {
      const hasZ = isFinite(num(f.zeta)) && num(f.zeta) > 0;
      const hasK = isFinite(num(f.kv)) && num(f.kv) > 0;
      if (!(num(f.qty) > 0)) { errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): λείπουν τεμάχια.`); mf = true; }
      if (!hasZ && !hasK) { errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): δώσε ζ ή Kv.`); mf = true; }
    });
    if (mf) missing.push("εξαρτήματα");
    let me = false;
    (br.equip || []).forEach((e, i) => { if (!isFinite(num(e.dP))) { errors.push(`${nm} · εξοπλισμός #${i + 1}: λείπει η ΔP.`); me = true; } });
    if (me) missing.push("ΔP εξοπλ.");
    return { errors, missing };
  }
  function vMaxFor(Dint) { for (const [d, v] of D.vMaxByDi) if (Dint <= d) return v; return D.vMaxByDi[D.vMaxByDi.length - 1][1]; }
  function vState(v, Dint) {
    if (!isFinite(v)) return "";
    const vm = vMaxFor(Dint);
    if (v < D.vHardMin || v > vm * D.vHardFactor) return "bad";
    if (v < D.vIdealMin || v > vm) return "warn";
    return "ok";
  }
  function rState(R) { return !isFinite(R) ? "" : R > D.rBad ? "bad" : R > D.rWarn ? "warn" : "ok"; }
  function branchWarns(br, c, res) {
    const warns = [];
    const nm = branchLabel(br);
    const p = c.pipe, v = p.v;
    if (isFinite(v)) {
      const vm = vMaxFor(p.D_int), st = vState(v, p.D_int);
      if (v < D.vHardMin) warns.push(`${nm}: πολύ χαμηλή ταχύτητα v=${fmt(v, 2)} m/s (κίνδυνος παγίδευσης αέρα).`);
      else if (st === "bad") warns.push(`${nm}: πολύ υψηλή ταχύτητα v=${fmt(v, 2)} m/s — όριο ${fmt(vm, 1)} m/s για D ${fmt(p.D_int, 1)} mm (θόρυβος, διάβρωση).`);
      else if (v > vm) warns.push(`${nm}: υψηλή ταχύτητα v=${fmt(v, 2)} m/s — όριο ${fmt(vm, 1)} m/s για D ${fmt(p.D_int, 1)} mm.`);
      else if (v < D.vIdealMin) warns.push(`${nm}: ταχύτητα v=${fmt(v, 2)} m/s κάτω από ${D.vIdealMin} m/s — μάλλον μεγάλη διατομή.`);
    }
    if (isFinite(p.R) && p.R > D.rWarn) warns.push(`${nm}: απώλεια ${fmt(p.R, 0)} Pa/m, πάνω από ${D.rWarn} Pa/m${p.R > D.rBad ? " (πολύ υψηλή)" : ""}.`);
    if (p.regime && p.regime !== "τυρβώδης") warns.push(`${nm}: ${p.regime} ροή (Re=${Math.round(p.Re)}) — τα ζ των εξαρτημάτων είναι μεγαλύτερα από τις τιμές πίνακα.`);
    if (c.ctrl && c.ctrl.auth < D.authMin) warns.push(`${nm}: authority βάνας ελέγχου β=${fmt(c.ctrl.auth, 2)}, κάτω από ${D.authMin} — μικρότερο Kv βάνας.`);
    c.bal.forEach(b => { if (b.kPa < D.balMinKPa) warns.push(`${nm}: βάνα εξισορρόπησης με ΔP ${fmt(b.kPa, 1)} kPa, κάτω από ${D.balMinKPa} kPa — δύσκολη μέτρηση/ρύθμιση.`); });
    // Ισοζύγιο παροχών με τους κλάδους μετά
    const ks = (res && res.tree && res.tree.kids.get(br.id)) || [];
    if (ks.length && c.Q > 0 && c.Qsrc !== "auto") {
      const qs = ks.map(k => res.cById.get(k).c.Q);
      const known = qs.filter(q => q > 0).reduce((a, b) => a + b, 0);
      if (!qs.every(q => q > 0) && known > c.Q * (1 + D.qBalTol))
        warns.push(`${nm}: Q=${fmt(c.Q, 2)} m³/h ενώ οι κλάδοι μετά αθροίζουν ήδη ${fmt(known, 2)} m³/h (χωρίς όσους δεν έχουν Q).`);
      if (qs.every(q => q > 0)) {
        const sum = qs.reduce((a, b) => a + b, 0);
        if (project.mode === "network") {
          if (sum > c.Q * (1 + D.qBalTol)) warns.push(`${nm}: Q=${fmt(c.Q, 2)} m³/h μικρότερη από όσο αθροίζουν οι κλάδοι μετά (${fmt(sum, 2)} m³/h).`);
          else if (sum < c.Q * (1 - D.qBalTol)) warns.push(`${nm}: Q=${fmt(c.Q, 2)} m³/h μεγαλύτερη από όσο αθροίζουν οι κλάδοι μετά (${fmt(sum, 2)} m³/h) — υπάρχουν καταναλωτές που δεν σχεδιάστηκαν;`);
        } else if (sum > c.Q * (1 + D.qBalTol)) warns.push(`${nm}: ο επόμενος κλάδος έχει μεγαλύτερη παροχή (${fmt(sum, 2)} > ${fmt(c.Q, 2)} m³/h).`);
      }
    }
    return warns;
  }

  /* ---------------- ENGINE: αντλία ---------------- */
  function fitPump(points) { // ελάχιστα τετράγωνα H = a + bQ + cQ²
    const pts = (points || []).map(p => [num(p.Q), num(p.H)]).filter(([q, h]) => q >= 0 && h > 0);
    if (pts.length < 3) return null;
    const S = [0, 0, 0, 0, 0], T = [0, 0, 0];
    pts.forEach(([q, h]) => { let qp = 1; for (let i = 0; i < 5; i++) { S[i] += qp; if (i < 3) T[i] += h * qp; qp *= q; } });
    const M = [[S[0], S[1], S[2], T[0]], [S[1], S[2], S[3], T[1]], [S[2], S[3], S[4], T[2]]];
    for (let c = 0; c < 3; c++) {
      let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
    }
    const a = M[0][3] / M[0][0], b = M[1][3] / M[1][1], c = M[2][3] / M[2][2];
    return { a, b, c, qMax: Math.max(...pts.map(p => p[0])), pts, H: (q) => a + b * q + c * q * q };
  }
  function opPoint(fit, Hs, Kq) { // τομή a + bQ + cQ² = Hs + K·Q²
    if (!fit || !(Kq >= 0)) return null;
    const A = fit.c - Kq, B = fit.b, C = fit.a - Hs;
    let roots = [];
    if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) roots = [-C / B]; }
    else { const d = B * B - 4 * A * C; if (d >= 0) roots = [(-B + Math.sqrt(d)) / (2 * A), (-B - Math.sqrt(d)) / (2 * A)]; }
    roots = roots.filter(q => q > 0 && isFinite(q));
    if (!roots.length) return null;
    const Q = Math.max(...roots);
    return { Q, H: fit.H(Q) };
  }

  /* ---------------- ENGINE: έργο ---------------- */
  function calcProject() {
    normalize(project);
    return project.mode === "network" ? calcNetwork() : calcSimple();
  }
  function calcSimple() {
    const fp = fluidProps();
    const tree = treeOf(project.branches);
    const qm = computeQ(tree, fp);
    const branches = project.branches.map(br => {
      const q = qm.get(br.id) || { Q: NaN, src: "none" };
      const c = calcBranch(br, fp.nu, fp, q.Q);
      c.Qsrc = q.src;
      const e = branchErrors(br, c);
      c.errors = e.errors; c.missing = e.missing; c.complete = !e.errors.length;
      return { br, c };
    });
    const cById = new Map(branches.map(x => [x.br.id, x]));
    // Διαδρομές: από κάθε ρίζα ως κάθε κλάδο χωρίς συνέχεια
    const circuits = [];
    const walk = (id, path, sum, ok) => {
      const x = cById.get(id);
      const s = sum + (isFinite(x.c.dP) ? x.c.dP : 0), complete = ok && x.c.complete, p = path.concat(id);
      const ks = tree.kids.get(id);
      if (!ks.length) circuits.push({ leaf: id, ids: p, dP: s, complete });
      else ks.forEach(k => walk(k, p, s, complete));
    };
    tree.roots.forEach(r => walk(r, [], 0, true));
    let worst = null;
    const pickFrom = circuits.some(c => c.complete) ? circuits.filter(c => c.complete) : circuits;
    pickFrom.forEach(c => { if (!worst || c.dP > worst.dP) worst = c; });
    const pathMax = worst ? worst.dP : 0;
    circuits.forEach(c => {
      c.worst = c === worst;
      c.excess = c.complete && worst && worst.complete ? pathMax - c.dP : NaN;
      c.excessKPa = toKPa(c.excess, fp);
      const leaf = cById.get(c.leaf);
      const q = leaf ? leaf.c.Q : NaN;
      c.kvReq = c.excess > 1e-6 && q > 0 ? q / Math.sqrt(c.excessKPa / 100) : NaN;
    });
    const startM = toM(project.start.dP, project.start.unit, fp);
    let sumExtras = isFinite(startM) ? startM : 0;
    project.extras.forEach(e => { const d = toM(e.dP, e.unit, fp); if (isFinite(d)) sumExtras += d; });
    const base = pathMax + sumExtras;
    const margin = (num(project.marginPct) || 0) / 100;
    const Hfric = base * (1 + margin);
    const Hstatic = project.openCircuit ? (num(project.staticHead) || 0) : 0;
    const H = Hfric + Hstatic;
    // Παροχή αντλίας = Σ παροχών των κλάδων που ξεκινούν από την αρχή
    let Qd = 0; tree.roots.forEach(id => { const q = cById.get(id).c.Q; if (q > 0) Qd += q; });
    if (!(Qd > 0)) Qd = NaN;
    const Ph = fp.rho * D.g * (Qd / 3600) * H;
    const fit = fitPump(project.pump.points);
    const Kq = Qd > 0 ? base / (Qd * Qd) : NaN;
    const op = opPoint(fit, Hstatic, Kq);
    const eta = num(project.pump.eta) / 100;
    if (op) { op.Ph = fp.rho * D.g * (op.Q / 3600) * op.H; op.Pshaft = eta > 0 ? op.Ph / eta : NaN; }
    const incomplete = branches.filter(x => !x.c.complete).map(x => x.br.id);
    const provisional = !branches.length || incomplete.length > 0 || fp.frozen || tree.cyclic.length > 0;
    return {
      fp, branches, cById, tree, circuits, worst, sumBranches: pathMax, startM: isFinite(startM) ? startM : 0,
      sumExtras, base, Hfric, Hstatic, H, margin, Qd, Ph, pump: { fit, op, Kq, eta }, incomplete, provisional
    };
  }

  function validate(res) {
    const errors = [], warns = [];
    const fp = res.fp;
    if (fp.frozen) errors.push(`Ρευστό: ${fmt(fp.T, 0)} °C είναι κάτω από το σημείο πήξης (${fmt(fp.tFreeze, 1)} °C).`);
    else if (fp.approx) warns.push(`Ρευστό: κοντά στο σημείο πήξης (${fmt(fp.tFreeze, 1)} °C) — ιδιότητες κατά προσέγγιση.`);
    if (fp.clamped) warns.push("Ρευστό: θερμοκρασία ή συγκέντρωση εκτός πίνακα (−30…90 °C, 0…60%) — χρησιμοποιήθηκε το όριο.");
    if (res.mode === "network") {
      if (!project.net.edges.length) errors.push("Το δίκτυο είναι άδειο — ξεκίνα από το + της αντλίας.");
      validateNetwork(res, errors, warns);
      pumpWarns(res, warns);
      return { errors, warns };
    }
    if (project.branches.length === 0) errors.push("Δεν υπάρχει κανένας κλάδος.");
    if (res.tree && res.tree.cyclic.length) errors.push("Δίκτυο: κύκλος στις συνδέσεις κλάδων — έλεγξε το «Ξεκινά από».");
    const codes = {};
    project.branches.forEach(b => { const k = (b.code || "").trim(); if (k) codes[k] = (codes[k] || 0) + 1; });
    Object.keys(codes).forEach(k => { if (codes[k] > 1) warns.push(`Ο κωδικός ${k} χρησιμοποιείται ${codes[k]} φορές.`); });
    res.branches.forEach(({ br, c }) => { errors.push(...c.errors); warns.push(...branchWarns(br, c, res)); });
    if (String(project.start.dP).trim() !== "" && !isFinite(num(project.start.dP))) errors.push("Αρχή βρόχου: μη έγκυρη ΔP.");
    project.extras.forEach((e, i) => { if (!isFinite(num(e.dP))) errors.push(`Κοινός εξοπλισμός #${i + 1} (${e.label || "χωρίς περιγραφή"}): λείπει η ΔP.`); });
    pumpWarns(res, warns);
    return { errors, warns };
  }
  function pumpWarns(res, warns) {
    const op = res.pump && res.pump.op;
    if (res.pump && res.pump.fit && !op) warns.push("Αντλία: η καμπύλη δεν τέμνει την καμπύλη δικτύου.");
    if (op && op.Q < res.Qd * (1 - D.qBalTol)) warns.push(`Αντλία: στο σημείο λειτουργίας δίνει ${fmt(op.Q, 2)} m³/h, λιγότερο από τα ${fmt(res.Qd, 2)} m³/h του σχεδιασμού.`);
  }

  /* Αλλαγή τρόπου — πάντα με το ίδιο H.
     Απλή → δίκτυο: αντλία → [αρχή, κοινός εξοπλισμός] → κλάδοι σε σειρά → πίσω στην αντλία.
     Δίκτυο → απλή: μόνο ένας βρόχος χωρίς διακλαδώσεις· ο εξοπλισμός γίνεται «κοινός». */
  function chainToGraph(p) {
    const net = { nodes: [], edges: [] };
    const { P, cur: c0 } = prefixNodes(p, net);
    let cur = c0;
    p.branches.forEach(b => { const J = newNode("junction", net); net.nodes.push(J); net.edges.push(branchToEdge(b, cur, J.id)); cur = J.id; });
    if (!p.openCircuit && cur !== P.id) net.edges.push(newEdge(cur, P.id, null, true));
    return net;
  }
  function setMode(m) {
    if (m === project.mode) return { ok: true };
    if (m === "network") {
      const st = project.start || {};
      const has = project.branches.length || project.extras.length || String(st.dP == null ? "" : st.dP).trim() !== "" || (st.type && st.type !== "Αντλία");
      project.net = has ? chainToGraph(project) : { nodes: [], edges: [] };
      project.branches = []; project.extras = []; project.start = { type: "Αντλία", label: "", dP: "", unit: "kPa" };
      project.mode = "network"; normalizeNet(project); selId = null; selNode = null;
      return { ok: true };
    }
    const res = calcNetwork(), g = res.g, P = res.pumpId, net = project.net;
    const single = P && net.nodes.every(n => g.inE.get(n.id).length <= 1 && g.outE.get(n.id).length <= 1);
    if (!single) return { ok: false, msg: "Το δίκτυο έχει διακλαδώσεις. Απλή διαδρομή γίνεται μόνο με έναν βρόχο χωρίς παράλληλους σωλήνες." };
    const seq = []; let u = P, guard = 0;
    while (guard++ < 10000) { const out = g.outE.get(u); if (!out.length) break; const id = out[0]; seq.push(id); u = g.eById.get(id).to; if (u === P) break; }
    const visited = new Set([P]); seq.forEach(id => visited.add(g.eById.get(id).to));
    if (net.nodes.some(n => !visited.has(n.id))) return { ok: false, msg: "Υπάρχουν σημεία εκτός του βρόχου της αντλίας — σύνδεσέ τα ή σβήσ' τα πρώτα." };
    const branches = [], extras = []; let prev = null;
    seq.forEach(id => {
      const x = res.ecById.get(id), e = x.e;
      if (!e.direct) {
        branches.push({ id: e.id, code: e.code, desc: e.desc, kind: e.kind, parent: prev, Q: x.c.Qsrc === "auto" && x.c.Q > 0 ? +x.c.Q.toFixed(4) : e.Q, loadKW: e.loadKW,
          pipeFamily: e.pipeFamily, pipeSize: e.pipeSize, length: e.length, fittings: e.fittings, equip: e.equip });
        prev = e.id;
      }
      const nc = res.ncById.get(e.to);
      if (e.to !== P && nc.m > 0) extras.push({ label: nodeLabel(nc.n), dP: nc.n.dP, unit: nc.n.unit });
    });
    project.branches = branches; project.extras = extras;
    project.start = { type: "Αντλία", label: "", dP: "", unit: "kPa" };
    project.net = { nodes: [], edges: [] }; normalizeNet(project);
    project.mode = "simple"; selId = null; selNode = null;
    return { ok: true };
  }

  /* =====================================================================
     ΔΙΚΤΥΟ (τρόπος «Δίκτυο»): σημεία + σωλήνες με φορά ροής.
     • Σημεία: αντλία, κόμβοι, εξοπλισμός — ο εξοπλισμός έχει δική του ΔP.
     • Παροχές: όσες δίνεις (Q σωλήνα, Q ή φορτίο εξοπλισμού) και οι υπόλοιπες
       από το ισοζύγιο σε κάθε σημείο: ό,τι μπαίνει = ό,τι βγαίνει.
     • Κλειστό κύκλωμα: H = μεγαλύτερη διαδρομή έξοδος αντλίας → … → είσοδος.
     • Ανοιχτό κύκλωμα: H = μεγαλύτερη διαδρομή αντλία → ανοιχτό άκρο
       + μεγαλύτερη αναρρόφηση πηγή → αντλία + στατικό ύψος.
     • Μετράνε μόνο πλήρεις διαδρομές· οι υπόλοιπες στραγγαλίζονται.
     ===================================================================== */
  const PUMP = "pump";
  function nodeType(t) { return DB.NODE_TYPES.find(x => x.id === t) || DB.NODE_TYPES[DB.NODE_TYPES.length - 1]; }
  function nodeLabel(n) { return (n && (n.label || "").trim()) || (n ? nodeType(n.type).short : "?"); }
  function edgeLabel(e) { return e.code || (e.direct ? "σύνδεση" : e.id); }
  function typeFromLabel(l) { const t = DB.NODE_TYPES.find(x => x.label === l || x.short === l); return t ? t.id : "other"; }
  function newNode(type, net) {
    net = net || project.net;
    const t = nodeType(type);
    const same = net.nodes.filter(n => n.type === type).length;
    return { id: uid(), type, label: type === PUMP ? "Αντλία" + (same ? " " + (same + 1) : "") : `${t.short} ${same + 1}`, dP: "", unit: "kPa", Q: "", loadKW: "" };
  }
  function newEdge(from, to, like, direct) {
    const fam = like ? DB.PIPE_FAMILIES.find(f => f.family === like.pipeFamily) : null;
    const f0 = fam || DB.PIPE_FAMILIES[0];
    return {
      id: uid(), code: direct ? "" : nextCode(), desc: "", kind: "t", from, to, direct: !!direct, Q: "", loadKW: "",
      pipeFamily: f0.family, pipeSize: like && fam ? like.pipeSize : f0.sizes[0][0], length: "", fittings: [], equip: []
    };
  }
  function normalizeNet(p) {
    const net = p.net = p.net || { nodes: [], edges: [] };
    net.nodes = (net.nodes || []).map(n => ({
      id: n.id || uid(), type: DB.NODE_TYPES.some(t => t.id === n.type) ? n.type : "other", label: n.label || "",
      dP: n.dP === undefined ? "" : n.dP, unit: n.unit || "kPa", Q: n.Q === undefined ? "" : n.Q, loadKW: n.loadKW === undefined ? "" : n.loadKW
    }));
    if (!net.nodes.length) net.nodes.push({ id: uid(), type: PUMP, label: "Αντλία", dP: "", unit: "kPa", Q: "", loadKW: "" });
    const ids = new Set(net.nodes.map(n => n.id));
    net.edges = (net.edges || []).filter(e => ids.has(e.from) && ids.has(e.to)).map(e => {
      e.id = e.id || uid();
      if (e.code === undefined) e.code = "";
      if (e.desc === undefined) e.desc = "";
      if (!DB.KINDS.some(k => k.id === e.kind)) e.kind = "t";
      e.direct = !!e.direct;
      e.fittings = e.fittings || [];
      e.equip = (e.equip || []).map(x => ({ label: x.label || "", dP: x.dP, unit: x.unit || "kPa" }));
      if (e.Q === undefined) e.Q = "";
      if (e.loadKW === undefined) e.loadKW = "";
      if (!e.pipeFamily) { e.pipeFamily = DB.PIPE_FAMILIES[0].family; e.pipeSize = DB.PIPE_FAMILIES[0].sizes[0][0]; }
      delete e.parent;
      return e;
    });
    return net;
  }
  /* Μετατροπές από τα άλλα μοντέλα — δίνουν το ίδιο H. */
  function prefixNodes(p, net) {           // αντλία → [αρχή] → [κοινός εξοπλισμός]
    const P = newNode(PUMP, net); net.nodes.push(P);
    let cur = P.id;
    const st = p.start || {};
    const addX = (type, label, dP, unit) => { const X = newNode(type, net); X.label = label; X.dP = dP; X.unit = unit || "kPa"; net.nodes.push(X); net.edges.push(newEdge(cur, X.id, null, true)); cur = X.id; };
    if (st.type && st.type !== "Αντλία") addX(typeFromLabel(st.type), st.label || st.type, st.dP, st.unit);
    else if (String(st.dP == null ? "" : st.dP).trim() !== "") addX("other", "Αρχή", st.dP, st.unit);
    (p.extras || []).forEach(x => addX("other", x.label || "Εξοπλισμός", x.dP, x.unit));
    return { P, cur };
  }
  function branchToEdge(b, from, to) {
    const e = { id: b.id, code: b.code, desc: b.desc || "", kind: b.kind, from, to, direct: false, Q: b.Q, loadKW: b.loadKW,
      pipeFamily: b.pipeFamily, pipeSize: b.pipeSize, length: b.length, fittings: b.fittings || [], equip: b.equip || [] };
    return e;
  }
  function treeToGraph(p) {
    const net = { nodes: [], edges: [] };
    const { P, cur } = prefixNodes(p, net);
    const t = treeOf(p.branches), end = new Map();
    t.order.forEach(id => {
      const b = t.byId.get(id), J = newNode("junction", net); net.nodes.push(J);
      net.edges.push(branchToEdge(b, b.parent && end.has(b.parent) ? end.get(b.parent) : cur, J.id));
      end.set(id, J.id);
    });
    const leaves = t.order.filter(id => !t.kids.get(id).length);
    if (!leaves.length) net.edges.push(newEdge(cur, P.id, null, true));
    else if (leaves.length === 1) net.edges.push(newEdge(end.get(leaves[0]), P.id, null, true));
    else {
      const R = newNode("junction", net); R.label = "Επιστροφή"; net.nodes.push(R);
      leaves.forEach(l => net.edges.push(newEdge(end.get(l), R.id, null, true)));
      net.edges.push(newEdge(R.id, P.id, null, true));
    }
    return net;
  }

  function graphOf(net) {
    const nById = new Map(net.nodes.map(n => [n.id, n]));
    const eById = new Map(net.edges.map(e => [e.id, e]));
    const outE = new Map(net.nodes.map(n => [n.id, []])), inE = new Map(net.nodes.map(n => [n.id, []]));
    net.edges.forEach(e => { outE.get(e.from).push(e.id); inE.get(e.to).push(e.id); });
    return { nById, eById, outE, inE };
  }
  function nodeThrough(n, fp) {
    if (nodeType(n.type).id === PUMP) return NaN;
    if (num(n.loadKW) > 0) { const dT = num(project.dT); return dT > 0 ? 3600 * num(n.loadKW) / (fp.rho * fp.cp * dT) : NaN; }
    return num(n.Q) > 0 ? num(n.Q) : NaN;
  }
  /* Παροχές από το ισοζύγιο: επαναλαμβάνει όσο βρίσκει σημείο με ΜΙΑ άγνωστη πλευρά. */
  function solveFlows(net, g, fp) {
    const q = new Map(), src = new Map(), through = new Map();
    net.edges.forEach(e => {
      if (num(e.loadKW) > 0) { q.set(e.id, qFromLoad(e, fp)); src.set(e.id, "load"); }
      else if (num(e.Q) > 0) { q.set(e.id, num(e.Q)); src.set(e.id, "manual"); }
    });
    net.nodes.forEach(n => { const T = nodeThrough(n, fp); if (T > 0) through.set(n.id, T); });
    const known = id => q.has(id) && isFinite(q.get(id));
    const sum = ids => ids.reduce((a, id) => a + q.get(id), 0);
    let changed = true, guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      for (const n of net.nodes) {
        const ins = g.inE.get(n.id), outs = g.outE.get(n.id), T = through.get(n.id);
        for (const [side, other] of [[ins, outs], [outs, ins]]) {
          const unk = side.filter(id => !known(id));
          if (unk.length !== 1) continue;
          const tot = T > 0 ? T : (other.length && other.every(known) ? sum(other) : NaN);
          if (!isFinite(tot)) continue;
          q.set(unk[0], tot - sum(side.filter(known))); src.set(unk[0], "auto"); changed = true;
        }
      }
    }
    return { q, src, through };
  }

  function calcNetwork() {
    const fp = fluidProps(), net = project.net, g = graphOf(net), open = !!project.openCircuit;
    const pumps = net.nodes.filter(n => n.type === PUMP);
    const P = pumps.length ? pumps[0].id : null;
    const topoErr = [];
    const nst = new Map(net.nodes.map(n => [n.id, { errs: [], warns: [] }]));
    if (!pumps.length) topoErr.push("Δεν υπάρχει αντλία στο δίκτυο — πρόσθεσε μία (+ → Αντλία).");
    if (pumps.length > 1) topoErr.push(`Υπάρχουν ${pumps.length} αντλίες. Ένας υπολογισμός = μία αντλία· υπολόγισε κάθε βρόχο χωριστά.`);
    // Συνδεσιμότητα
    const fwd = new Set(), bwd = new Set();
    const walk = (startIds, next, set) => { const st = [...startIds]; while (st.length) { const u = st.pop(); next(u).forEach(v => { if (v !== P && !set.has(v)) { set.add(v); st.push(v); } }); } };
    const succ = u => g.outE.get(u).map(id => g.eById.get(id).to), pred = v => g.inE.get(v).map(id => g.eById.get(id).from);
    if (P) { walk([P], succ, fwd); walk([P], pred, bwd); }
    const sinks = open ? net.nodes.filter(n => n.id !== P && !g.outE.get(n.id).length).map(n => n.id) : [];
    const sources = open ? net.nodes.filter(n => n.id !== P && !g.inE.get(n.id).length).map(n => n.id) : [];
    const toEnd = new Set(); if (open) walk(sinks, pred, toEnd); sinks.forEach(s => toEnd.add(s));
    const fromSrc = new Set(); if (open) walk(sources, succ, fromSrc); sources.forEach(s => fromSrc.add(s));
    net.nodes.forEach(n => {
      if (!P || n.id === P) return;
      const s = nst.get(n.id);
      if (open) {
        if (!fwd.has(n.id) && !bwd.has(n.id)) s.errs.push(`${nodeLabel(n)}: δεν συνδέεται με την αντλία.`);
      } else if (!fwd.has(n.id)) s.errs.push(`${nodeLabel(n)}: δεν τροφοδοτείται από την αντλία.`);
      else if (!bwd.has(n.id)) s.errs.push(`${nodeLabel(n)}: δεν επιστρέφει στην αντλία — κλείσε το κύκλωμα (+ → σύνδεση με την αντλία) ή δήλωσε ανοιχτό κύκλωμα.`);
    });
    // Τοπολογική σειρά (χωρίς τις ακμές προς την αντλία) — ανιχνεύει κυκλική ροή
    const inside = new Set(net.nodes.map(n => n.id)); if (P) inside.delete(P);
    const indeg = new Map([...inside].map(v => [v, g.inE.get(v).length]));   // οι ακμές από την αντλία αφαιρούνται αμέσως μετά
    if (P) g.outE.get(P).forEach(id => { const v = g.eById.get(id).to; if (v !== P) indeg.set(v, indeg.get(v) - 1); });
    const queue = [...inside].filter(v => indeg.get(v) === 0), order = [];
    while (queue.length) {
      const v = queue.shift(); order.push(v);
      g.outE.get(v).forEach(id => { const w = g.eById.get(id).to; if (w === P) return; indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) queue.push(w); });
    }
    const cyclic = [...inside].filter(v => !order.includes(v));
    if (cyclic.length) topoErr.push(`Κυκλική ροή που δεν περνά από την αντλία: ${cyclic.map(id => nodeLabel(g.nById.get(id))).join(", ")}.`);

    // Παροχές
    const fl = solveFlows(net, g, fp);
    const edges = net.edges.map(e => {
      const Qr = fl.q.has(e.id) ? fl.q.get(e.id) : NaN, src = fl.src.get(e.id) || "none";
      const Q = Qr > 0 ? Qr : NaN;
      const c = e.direct
        ? { Q, pipe: { v: NaN, Re: NaN, lambda: NaN, dP: 0, R: NaN, Leff: 0 }, fittings: [], sumFit: 0, equip: [], sumEquip: 0, dP: 0, ctrl: null, bal: [] }
        : calcBranch(e, fp.nu, fp, Q);
      c.Qsrc = src;
      const er = e.direct ? { errors: [], missing: [] } : branchErrors(e, c);
      if (e.direct && !(Q > 0)) { er.errors.push(`${edgeLabel(e)} (${nodeLabel(g.nById.get(e.from))} → ${nodeLabel(g.nById.get(e.to))}): δεν προκύπτει παροχή.`); er.missing.push("Q"); }
      if (isFinite(Qr) && !(Qr > 0)) er.errors.unshift(`${edgeLabel(e)}: από το ισοζύγιο η παροχή βγαίνει ${fmt(Qr, 2)} m³/h — έλεγξε τις παροχές γύρω του.`);
      c.errors = er.errors; c.missing = er.missing; c.complete = !er.errors.length;
      return { e, br: e, c };
    });
    const ecById = new Map(edges.map(x => [x.e.id, x]));
    const nodes = net.nodes.map(n => {
      const t = nodeType(n.type), s = nst.get(n.id);
      let m = 0;
      if (t.dp && String(n.dP == null ? "" : n.dP).trim() !== "") { m = toM(n.dP, n.unit, fp); if (!isFinite(m)) { s.errs.push(`${nodeLabel(n)}: μη έγκυρη ΔP.`); m = 0; } }
      const ins = g.inE.get(n.id), outs = g.outE.get(n.id), T = fl.through.get(n.id);
      const qv = id => fl.q.get(id), ok = id => isFinite(qv(id));
      const sIn = ins.length && ins.every(ok) ? ins.reduce((a, id) => a + qv(id), 0) : NaN;
      const sOut = outs.length && outs.every(ok) ? outs.reduce((a, id) => a + qv(id), 0) : NaN;
      const tol = x => D.qBalTol * Math.max(Math.abs(x), 1e-9);
      if (isFinite(sIn) && isFinite(sOut) && Math.abs(sIn - sOut) > tol(Math.max(sIn, sOut)))
        s.errs.push(`${nodeLabel(n)}: μπαίνουν ${fmt(sIn, 2)} m³/h, βγαίνουν ${fmt(sOut, 2)} m³/h.`);
      if (T > 0 && isFinite(sIn) && Math.abs(sIn - T) > tol(T)) s.errs.push(`${nodeLabel(n)}: η παροχή του (${fmt(T, 2)}) διαφέρει από όση μπαίνει (${fmt(sIn, 2)} m³/h).`);
      else if (T > 0 && isFinite(sOut) && Math.abs(sOut - T) > tol(T)) s.errs.push(`${nodeLabel(n)}: η παροχή του (${fmt(T, 2)}) διαφέρει από όση βγαίνει (${fmt(sOut, 2)} m³/h).`);
      if (t.decoupler && (ins.length > 1 || outs.length > 1)) s.warns.push(`${nodeLabel(n)}: ${t.label} με πολλές συνδέσεις κόβει το κύκλωμα σε δύο — ό,τι κυκλοφορεί άλλη αντλία υπολογίζεται χωριστά.`);
      return { n, m, T, sIn, sOut, errs: s.errs, warns: s.warns, complete: !s.errs.length, openEnd: open && n.id !== P && !outs.length, source: open && n.id !== P && !ins.length };
    });
    const ncById = new Map(nodes.map(x => [x.n.id, x]));

    // Μεγαλύτερη διαδρομή σε κατευθυνόμενο γράφο χωρίς κύκλους (τοπολογική σειρά)
    function longest(startIds, isEnd, completeOnly) {
      const dist = new Map(), pre = new Map();
      startIds.forEach(s => dist.set(s, s === P ? 0 : ncById.get(s).m));
      if (completeOnly) startIds.forEach(s => { if (s !== P && !ncById.get(s).complete) dist.delete(s); });
      for (const v of order) {
        if (dist.has(v) && startIds.includes(v)) continue;
        let best = -Infinity, bp = null;
        g.inE.get(v).forEach(id => { const x = ecById.get(id), u = x.e.from; if (!dist.has(u) || (completeOnly && !x.c.complete)) return; const d = dist.get(u) + x.c.dP; if (d > best) { best = d; bp = id; } });
        if (bp === null) continue;
        const nd = ncById.get(v); if (completeOnly && !nd.complete) continue;
        dist.set(v, best + nd.m); pre.set(v, bp);
      }
      let best = -Infinity, end = null;
      // τέλος: είσοδος αντλίας (μέσω ακμής) ή ανοιχτό άκρο
      if (P) g.inE.get(P).forEach(id => { const x = ecById.get(id), u = x.e.from; if (!dist.has(u) || (completeOnly && !x.c.complete)) return; const d = dist.get(u) + x.c.dP; if (d > best) { best = d; end = { edge: id }; } });
      if (isEnd) order.forEach(v => { if (isEnd(v) && dist.has(v) && dist.get(v) > best) { best = dist.get(v); end = { node: v }; } });
      if (!end) return null;
      const es = [], ns = [];
      let v;
      if (end.edge) { es.push(end.edge); v = g.eById.get(end.edge).from; } else v = end.node;
      while (v !== undefined && v !== P) { ns.unshift(v); if (startIds.includes(v) && !pre.has(v)) break; const id = pre.get(v); if (!id) break; es.unshift(id); v = g.eById.get(id).from; }
      return { dP: best, edges: es, nodes: ns, toPump: !!end.edge };
    }
    const isSink = v => sinks.includes(v);
    let dis = P ? longest([P], open ? isSink : null, true) : null, disComplete = !!dis;
    if (!dis && P) dis = longest([P], open ? isSink : null, false);
    // Αναρρόφηση (μόνο ανοιχτό κύκλωμα): από πηγή ως την είσοδο της αντλίας
    let suc = null;
    if (open && P && sources.length && !(dis && dis.toPump)) suc = longest(sources, null, true) || longest(sources, null, false);
    const pathMax = (dis ? dis.dP : 0) + (suc ? suc.dP : 0);

    // Όλες οι διαδρομές για τον πίνακα (έξοδος αντλίας → είσοδος ή ανοιχτό άκρο)
    const paths = []; let pathsTrunc = false;
    if (P) {
      const dfs = (u, es, ns, s, ok, mq, seen) => {
        if (paths.length >= 300) { pathsTrunc = true; return; }
        const outs = g.outE.get(u);
        if (u !== P && open && !outs.length) { paths.push({ edges: es, nodes: ns, dP: s, complete: ok, minQ: mq, toPump: false }); return; }
        outs.forEach(id => {
          const x = ecById.get(id), v = x.e.to, s2 = s + x.c.dP, ok2 = ok && x.c.complete, mq2 = Math.min(mq, x.c.Q > 0 ? x.c.Q : Infinity);
          if (v === P) { paths.push({ edges: es.concat(id), nodes: ns, dP: s2, complete: ok2, minQ: mq2, toPump: true }); return; }
          if (seen.has(v)) return;
          const nd = ncById.get(v); seen.add(v);
          dfs(v, es.concat(id), ns.concat(v), s2 + nd.m, ok2 && nd.complete, mq2, seen);
          seen.delete(v);
        });
      };
      dfs(P, [], [], 0, true, Infinity, new Set());
    }
    const wKey = dis ? dis.edges.join(",") : "";
    const disMax = dis ? dis.dP : 0;
    paths.forEach(pt => {
      pt.worst = pt.edges.join(",") === wKey;
      pt.excess = pt.complete && disComplete ? disMax - pt.dP : NaN;
      pt.excessKPa = toKPa(pt.excess, fp);
      pt.kvReq = pt.excess > 1e-6 && isFinite(pt.minQ) ? pt.minQ / Math.sqrt(pt.excessKPa / 100) : NaN;
    });

    const margin = (num(project.marginPct) || 0) / 100;
    const base = pathMax, Hfric = base * (1 + margin);
    const Hstatic = open ? (num(project.staticHead) || 0) : 0;
    const H = Hfric + Hstatic;
    let Qd = NaN;
    if (P) { const qs = g.outE.get(P).map(id => ecById.get(id).c.Q); if (qs.length && qs.every(q => q > 0)) Qd = qs.reduce((a, b) => a + b, 0); }
    const Ph = fp.rho * D.g * (Qd / 3600) * H;
    const fit = fitPump(project.pump.points);
    const Kq = Qd > 0 ? base / (Qd * Qd) : NaN;
    const op = opPoint(fit, Hstatic, Kq);
    const eta = num(project.pump.eta) / 100;
    if (op) { op.Ph = fp.rho * D.g * (op.Q / 3600) * op.H; op.Pshaft = eta > 0 ? op.Ph / eta : NaN; }
    const provisional = !P || topoErr.length > 0 || !disComplete || edges.some(x => !x.c.complete) || nodes.some(x => !x.complete) || fp.frozen;
    const via = pt => {
      if (!pt) return "";
      const term = pt.nodes.map(id => g.nById.get(id)).filter(n => nodeType(n.type).terminal);
      if (term.length) return term.map(nodeLabel).join(", ");
      const eq = pt.nodes.map(id => g.nById.get(id)).filter(n => n.type !== "junction");
      if (eq.length) return nodeLabel(eq[eq.length - 1]);
      return pt.edges.length ? edgeLabel(g.eById.get(pt.edges[pt.edges.length - 1])) : "";
    };
    return {
      mode: "network", fp, g, pumpId: P, order, cyclic, open, sinks, sources, fwd, bwd,
      edges, nodes, ecById, ncById, cById: ecById, branches: edges, flows: fl, topoErr, paths, pathsTrunc,
      worst: dis ? { ...dis, complete: disComplete } : null, suction: suc, via,
      worstText: dis ? via(dis) : "", sumBranches: pathMax, startM: 0, sumExtras: 0,
      base, Hfric, Hstatic, H, margin, Qd, Ph, pump: { fit, op, Kq, eta }, provisional
    };
  }
  function validateNetwork(res, errors, warns) {
    errors.push(...res.topoErr);
    res.nodes.forEach(x => { errors.push(...x.errs); warns.push(...x.warns); });
    res.edges.forEach(x => { errors.push(...x.c.errors); if (!x.e.direct) warns.push(...branchWarns(x.e, x.c, res)); });
    const codes = {};
    project.net.edges.forEach(e => { const k = (e.code || "").trim(); if (k) codes[k] = (codes[k] || 0) + 1; });
    Object.keys(codes).forEach(k => { if (codes[k] > 1) warns.push(`Ο κωδικός ${k} χρησιμοποιείται ${codes[k]} φορές.`); });
    if (res.pathsTrunc) warns.push("Πολλές διαδρομές — ο πίνακας δείχνει τις πρώτες 300· το H υπολογίζεται από όλες.");
  }

  /* ---------------- ΣΧΗΜΑΤΙΚΟ ΔΙΚΤΥΟΥ (SVG) ---------------- */
  const SCHEM_STYLE = `<style>
    .schem text{font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;fill:#26364A}
    .schem .t-cap{font-size:10px;font-weight:600;letter-spacing:.06em;fill:#5E6E80}
    .schem .t-strong{font-size:13px;font-weight:600;fill:#132033}
    .schem .t-small{font-size:11px;fill:#4A5A6C}
    .schem .t-code{font-family:"IBM Plex Mono",Consolas,monospace;font-size:13px;font-weight:600;fill:#132033}
    .schem .t-desc{font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;font-size:11.5px;font-weight:400;fill:#26364A}
    .schem .t-num{font-family:"IBM Plex Mono",Consolas,monospace;font-size:11.5px;fill:#26364A}
    .schem .t-miss{font-size:11.5px;fill:#B42318;font-weight:600}
    .schem .t-q{font-family:"IBM Plex Mono",Consolas,monospace;font-size:10.5px;fill:#5E6E80}
    .schem .sbox{fill:#FFFFFF;stroke:#132033;stroke-width:1.5}
    .schem .tbox{fill:#FFFFFF;stroke:#9AABBE}
    .schem .ln-trunk{stroke:#132033;stroke-width:3}
    .schem .ln-norm{stroke:#8A9BB0;stroke-width:3.5;fill:none;stroke-linejoin:round}
    .schem .ln-worst{stroke:#0B6FB8;stroke-width:6;fill:none;stroke-linejoin:round;stroke-linecap:round}
    .schem .ln-inc{stroke:#B42318;stroke-width:3;fill:none;stroke-dasharray:7 5;stroke-linejoin:round}
    .schem .ln-halo{stroke:#0B6FB8;stroke-opacity:.18;stroke-width:18;fill:none;stroke-linejoin:round;stroke-linecap:round}
    .schem .ln-hit{stroke:transparent;stroke-width:26;fill:none;pointer-events:stroke}
    .schem .seg{cursor:pointer;outline:none}
    .schem .seg:hover .t-code,.schem .seg.sel .t-code{fill:#0B4F86}
    .schem .seg:focus-visible .ln-hit{stroke:#0B6FB8;stroke-opacity:.25}
    .schem .junc{fill:#132033}
    .schem .endcap{fill:#FFFFFF;stroke:#8A9BB0;stroke-width:2}
    .schem .pc{fill:#FFFFFF;stroke:#132033;stroke-width:2}
    .schem .pt{fill:#132033}
    .schem .si-ok{fill:#1E7A45}.schem .si-warn{fill:#8A5A00}.schem .si-inc{fill:#FFFFFF;stroke:#B42318;stroke-width:2}
    .schem .si-chk{stroke:#FFFFFF;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
    .schem .si-t{font-size:10px;font-weight:700;fill:#FFFFFF}
    .schem .plus{cursor:pointer;outline:none}
    .schem .plus circle{fill:#FFFFFF;stroke:#0B6FB8;stroke-width:1.6}
    .schem .plus path{stroke:#0B6FB8;stroke-width:2.2}
    .schem .plus:hover circle,.schem .plus:focus-visible circle{fill:#0B6FB8}
    .schem .plus:hover path,.schem .plus:focus-visible path{stroke:#FFFFFF}
    .schem .delb{cursor:pointer;outline:none}
    .schem .delb circle{fill:#FFFFFF;stroke:#B42318;stroke-width:1.6}
    .schem .delb path{stroke:#B42318;stroke-width:2;stroke-linecap:round}
    .schem .delb:hover circle,.schem .delb:focus-visible circle{fill:#B42318}
    .schem .delb:hover path,.schem .delb:focus-visible path{stroke:#FFFFFF}
  </style>`;
  function plusBtn(x, y, id, label, act = "plus") {
    return `<g class="plus" data-act="${act}" data-id="${esc(id)}" data-x="${x}" data-y="${y}" role="button" tabindex="0" aria-label="${esc(label)}"><circle cx="${x}" cy="${y}" r="11"/><path d="M${x - 5} ${y}h10M${x} ${y - 5}v10"/></g>`;
  }

  /* ---------------- ΔΙΚΤΥΟ: σχέδιο ---------------- */
  const NET_STYLE = `<style>
    .schem .nbox{fill:#FFFFFF;stroke:#132033;stroke-width:1.5}
    .schem .nbox.worst{stroke:#0B6FB8;stroke-width:2.2}
    .schem .nbox.nerr{fill:#FDECEA;stroke:#B42318;stroke-width:2}
    .schem .nbox.nwarn{stroke:#8A5A00;stroke-width:2}
    .schem .nhalo{fill:none;stroke:#0B6FB8;stroke-opacity:.25;stroke-width:8}
    .schem .njun{fill:#132033}
    .schem .njun.nerr{fill:#B42318}
    .schem .nd{cursor:pointer;outline:none}
    .schem .nd:focus-visible .nbox,.schem .nd:hover .nbox{stroke:#0B6FB8}
    .schem .ln-direct{stroke:#132033;stroke-width:2;fill:none;stroke-linejoin:round}
    .schem .arr{fill:#5E6E80}
    .schem .arr.w{fill:#0B6FB8}
    .schem .t-open{font-size:10px;font-weight:600;fill:#8A3B00}
  </style>`;
  let netAnchors = new Map(), edgeAnchors = new Map();
  /* Τελευταία θέση κάθε σημείου στο σχέδιο: αν κοπεί ένας σωλήνας, ό,τι μένει
     ασύνδετο κρατά τη θέση του (δεν πετάγεται κάτω) ώστε να το ξαναενώσεις. */
  const lastPos = new Map();
  function nodeHalf(n) { return n.type === PUMP ? 20 : n.type === "junction" ? 7 : 68; }
  function layoutNet(res) {
    const g = res.g, P = res.pumpId, net = project.net;
    const layer = new Map(), row = new Map(), occ = new Set();
    const seeds = [];
    if (P) seeds.push(P);
    if (res.open) res.sources.forEach(s => seeds.push(s));
    if (!seeds.length && net.nodes.length) seeds.push(net.nodes[0].id);
    seeds.forEach(s => layer.set(s, 0));
    res.order.forEach(v => {
      if (layer.has(v)) return;
      let L = -1;
      g.inE.get(v).forEach(id => { const u = g.eById.get(id).from; if (layer.has(u)) L = Math.max(L, layer.get(u)); });
      if (L < 0 && lastPos.has(v)) L = lastPos.get(v).L - 1;
      layer.set(v, L + 1);
    });
    net.nodes.forEach(n => { if (!layer.has(n.id)) layer.set(n.id, 0); });
    let nextRow = 0;
    const free = (L, r) => !occ.has(L + ":" + r);
    const put = (v, r) => { row.set(v, r); occ.add(layer.get(v) + ":" + r); };
    const visit = u => {
      let first = true;
      g.outE.get(u).forEach(id => {
        const v = g.eById.get(id).to;
        if (v === P || row.has(v)) return;
        let r = first && free(layer.get(v), row.get(u)) ? row.get(u) : nextRow++;
        while (!free(layer.get(v), r)) r = nextRow++;
        put(v, r); first = false;
        visit(v);
      });
    };
    seeds.forEach(s => { if (!row.has(s)) { let r = nextRow++; while (!free(layer.get(s), r)) r = nextRow++; put(s, r); visit(s); } });
    net.nodes.forEach(n => {
      const s = n.id; if (row.has(s)) return;
      const lp = lastPos.get(s);
      let r = lp && free(layer.get(s), lp.r) ? lp.r : nextRow++;
      while (!free(layer.get(s), r)) r = nextRow++;
      put(s, r); visit(s);
    });
    let maxL = 0, maxR = 0;
    layer.forEach(L => { maxL = Math.max(maxL, L); });
    row.forEach(r => { maxR = Math.max(maxR, r); });
    layer.forEach((L, id) => { if (row.has(id)) lastPos.set(id, { L, r: row.get(id) }); });
    return { layer, row, rows: Math.max(nextRow, maxR + 1, 1), maxL };
  }
  function schematicNet(res, interactive, availW) {
    const g = res.g, P = res.pumpId, net = project.net;
    const { layer, row, rows, maxL } = layoutNet(res);
    const colW = Math.max(180, Math.min(240, Math.floor((availW - 150) / (maxL + 1)))), rowH = 104, padT = 64, padL = 60;
    const X = id => padL + layer.get(id) * colW, Y = id => padT + row.get(id) * rowH;
    const closing = net.edges.filter(e => e.to === P);
    const xMax = padL + maxL * colW + 70, yMax = padT + (rows - 1) * rowH + 30;
    const W = Math.max(availW, xMax + 60 + closing.length * 14), H = yMax + 60 + closing.length * 18 + (closing.length ? 30 : 0);
    const onWorst = new Set();
    if (res.worst && res.worst.complete) res.worst.edges.forEach(id => onWorst.add(id));
    if (res.suction) res.suction.edges.forEach(id => onWorst.add(id));
    const worstNodes = new Set(res.worst && res.worst.complete ? res.worst.nodes : []);
    const L = [], N = [], PL = [];
    const txt = (x, y, s, a = "") => `<text x="${x}" y="${y}" ${a}>${esc(s)}</text>`;
    netAnchors = new Map(); edgeAnchors = new Map();
    let ci = 0;
    net.edges.forEach(e => {
      const x = res.ecById.get(e.id), c = x.c;
      const u = g.nById.get(e.from), v = g.nById.get(e.to);
      const xu = X(e.from), yu = Y(e.from), xv = X(e.to), yv = Y(e.to), hu = nodeHalf(u), hv = nodeHalf(v);
      let d, seg, dir = 1;
      if (e.to === P && e.from !== P) {
        const k = ci++, xR = xMax + k * 14, yB = yMax + 40 + k * 18;
        d = `M${xu} ${yu} H${xR} V${yB} H${xv - 40} V${yv} H${xv - 20}`; seg = [xR, xv - 40, yB]; dir = -1;
      } else if (e.from === e.to) {
        d = `M${xu} ${yu} V${yu - 44} H${xu + 60} V${yu}`; seg = [xu, xu + 60, yu - 44];
      } else if (xv > xu) {
        if (yv === yu) { d = `M${xu} ${yu} H${xv}`; seg = [xu + hu, xv - hv, yu]; }
        else if (yv > yu) { const ex = xu + hu + 18; d = `M${xu} ${yu} H${ex} V${yv} H${xv}`; seg = [ex, xv - hv, yv]; }
        else { const ex = xv - hv - 18; d = `M${xu} ${yu} H${ex} V${yv} H${xv}`; seg = [xu + hu, ex, yu]; }
      } else {
        const yB = Math.max(yu, yv) + rowH / 2; d = `M${xu} ${yu} V${yB} H${xv} V${yv}`; seg = [xu, xv, yB]; dir = -1;
      }
      const [s1, s2, sy] = seg, mx = (s1 + s2) / 2, len = Math.abs(s2 - s1);
      const cls = !c.complete ? "ln-inc" : e.direct ? "ln-direct" : onWorst.has(e.id) ? "ln-worst" : "ln-norm";
      const sel = interactive && e.id === selId;
      const chars = Math.max(6, Math.floor((len - 8) / 6.6));
      const code = edgeLabel(e), desc = e.direct ? "" : ((e.desc || "").trim() || e.pipeSize);
      const arrow = dir > 0 ? `M${mx - 4} ${sy - 4.5} L${mx + 5} ${sy} L${mx - 4} ${sy + 4.5} Z` : `M${mx + 4} ${sy - 4.5} L${mx - 5} ${sy} L${mx + 4} ${sy + 4.5} Z`;
      let labels = "";
      if (!e.direct || !c.complete) {
        labels += `<text x="${mx}" y="${sy - 10}" text-anchor="middle" class="t-code">${esc(code)}${desc ? `<tspan class="t-desc" dx="5">${esc(trunc(desc, chars - code.length - 1))}</tspan>` : ""}</text>`;
        labels += c.complete
          ? `<text x="${mx}" y="${sy + 18}" text-anchor="middle" class="t-num">${esc(e.direct ? "" : "ΔP " + fmt(c.dP) + " mwc")}</text><text x="${mx}" y="${sy + 31}" text-anchor="middle" class="t-q">Q ${fmt(c.Q, 2)} m³/h</text>`
          : `<text x="${mx}" y="${sy + 18}" text-anchor="middle" class="t-miss">${esc(trunc("λείπει: " + c.missing.join(", "), chars))}</text>${c.Q > 0 ? `<text x="${mx}" y="${sy + 31}" text-anchor="middle" class="t-q">Q ${fmt(c.Q, 2)} m³/h</text>` : ""}`;
      } else if (c.Q > 0) labels += `<text x="${mx}" y="${sy + 16}" text-anchor="middle" class="t-q">${fmt(c.Q, 2)} m³/h</text>`;
      L.push(`<g class="seg ${sel ? "sel" : ""}" ${interactive ? `data-act="pick" data-id="${esc(e.id)}" role="button" tabindex="0" aria-label="Σωλήνας ${esc(code)}"` : ""}>
        ${sel ? `<path d="${d}" class="ln-halo"/>` : ""}<path d="${d}" class="${cls}"/>${interactive ? `<path d="${d}" class="ln-hit"/>` : ""}
        <path d="${arrow}" class="arr ${onWorst.has(e.id) ? "w" : ""}"/>${labels}</g>`);
      edgeAnchors.set(e.id, { x: s2 - 38, y: sy + 22, hw: 11 });
      if (sel) PL.push(plusBtn(s2 - 38, sy + 22, e.id, `Παρεμβολή σημείου ή εξοπλισμού στον ${code}`, "plus-edge"));
      if (sel) PL.push(`<g class="delb" data-act="del" data-id="${esc(e.id)}" role="button" tabindex="0" aria-label="Διαγραφή ${esc(code)}"><title>Διαγραφή ${esc(code)}</title><circle cx="${s2 - 12}" cy="${sy + 22}" r="9"/><path d="M${s2 - 15.5} ${sy + 18.5}l7 7M${s2 - 8.5} ${sy + 18.5}l-7 7"/></g>`);
    });
    net.nodes.forEach(n => {
      const x = X(n.id), y = Y(n.id), nc = res.ncById.get(n.id), t = nodeType(n.type);
      const sel = interactive && n.id === selNode, err = nc && !nc.complete, warn = nc && nc.warns.length;
      const hw = nodeHalf(n);
      netAnchors.set(n.id, { x, y, hw });
      const attrs = interactive ? `data-act="pick-node" data-id="${esc(n.id)}" role="button" tabindex="0" aria-label="${esc(nodeLabel(n))}"` : "";
      let body;
      if (n.type === PUMP) {
        body = `${sel ? `<circle cx="${x}" cy="${y}" r="25" class="nhalo"/>` : ""}<circle cx="${x}" cy="${y}" r="20" class="nbox ${err ? "nerr" : ""}"/><path d="M${x - 7} ${y - 10} L${x + 11} ${y} L${x - 7} ${y + 10} Z" class="pt"/>
          ${txt(x, y + 36, nodeLabel(n), 'class="t-strong" text-anchor="middle"')}${res.Qd > 0 ? txt(x, y + 50, fmt(res.Qd, 2) + " m³/h", 'class="t-q" text-anchor="middle"') : ""}`;
      } else if (n.type === "junction") {
        body = `${sel ? `<circle cx="${x}" cy="${y}" r="12" class="nhalo"/>` : ""}<circle cx="${x}" cy="${y}" r="7" class="njun ${err ? "nerr" : ""}"/><circle cx="${x}" cy="${y}" r="14" fill="transparent"/>
          ${/^Κόμβος \d+$/.test(nodeLabel(n)) ? `<title>${esc(nodeLabel(n))}</title>` : txt(x, y + 24, trunc(nodeLabel(n), 16), 'class="t-small" text-anchor="middle"')}`;
      } else {
        const dp = nc && nc.m > 0 ? `ΔP ${fmt(nc.m, 2)} mwc` : t.dp ? "ΔP —" : "";
        body = `${sel ? `<rect x="${x - hw - 4}" y="${y - 31}" width="${2 * hw + 8}" height="62" rx="12" class="nhalo"/>` : ""}
          <rect x="${x - hw}" y="${y - 27}" width="${2 * hw}" height="54" rx="9" class="nbox ${err ? "nerr" : warn ? "nwarn" : worstNodes.has(n.id) ? "worst" : ""}"/>
          ${txt(x, y - 11, t.short.toUpperCase(), 'class="t-cap" text-anchor="middle"')}
          ${txt(x, y + 4, trunc(nodeLabel(n), 18), 'class="t-strong" text-anchor="middle"')}
          ${txt(x, y + 19, dp, 'class="t-num" text-anchor="middle"')}
          ${nc && nc.openEnd ? txt(x, y + 41, "ανοιχτό άκρο", 'class="t-open" text-anchor="middle"') : ""}`;
      }
      N.push(`<g class="nd" ${attrs}>${body}</g>`);
      if (interactive) {
        const px = n.type === PUMP ? x + 24 : n.type === "junction" ? x + 12 : x + hw + 2, py = n.type === PUMP ? y - 24 : n.type === "junction" ? y - 16 : y - 29;
        PL.push(plusBtn(px, py, n.id, `Νέος σωλήνας ή σύνδεση από ${nodeLabel(n)}`));
      }
    });
    return { svg: `<svg class="schem" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Σχέδιο δικτύου">${SCHEM_STYLE}${NET_STYLE}${L.join("")}${N.join("")}${PL.join("")}</svg>`, W, H };
  }

  function netStatusHtml(res) {
    const g = res.g, items = [];
    if (!res.pumpId) items.push(`<span class="ns bad">Χωρίς αντλία</span>`);
    else if (res.open) items.push(`<span class="ns ok">Ανοιχτό κύκλωμα${res.sinks.length ? " · άκρα: " + esc(res.sinks.map(id => nodeLabel(g.nById.get(id))).join(", ")) : ""}</span>`);
    else {
      const notBack = res.nodes.filter(x => x.n.id !== res.pumpId && !res.bwd.has(x.n.id)).map(x => nodeLabel(x.n));
      const closed = g.inE.get(res.pumpId).length > 0 && !notBack.length;
      items.push(closed ? `<span class="ns ok">✓ Κλειστό κύκλωμα</span>` : `<span class="ns bad">Δεν κλείνει${notBack.length ? ": " + esc(notBack.slice(0, 4).join(", ")) + (notBack.length > 4 ? "…" : "") + " δεν επιστρέφουν" : ""}</span>`);
    }
    const bal = res.nodes.filter(x => x.errs.some(e => e.includes("μπαίνουν") || e.includes("διαφέρει"))).map(x => nodeLabel(x.n));
    const noQ = res.edges.filter(x => !(x.c.Q > 0)).map(x => edgeLabel(x.e));
    if (bal.length) items.push(`<span class="ns bad">✗ Ισοζύγιο: ${esc(bal.join(", "))}</span>`);
    else if (noQ.length) items.push(`<span class="ns warn">Χωρίς παροχή: ${esc(noQ.slice(0, 6).join(", "))}${noQ.length > 6 ? "…" : ""}</span>`);
    else if (res.edges.length) items.push(`<span class="ns ok">✓ Ισοζύγιο παροχών σε όλα τα σημεία</span>`);
    if (res.Qd > 0) items.push(`<span class="ns">Q αντλίας <b class="num">${fmt(res.Qd, 2)} m³/h</b></span>`);
    return items.join("");
  }

  function netPathsTable(res) {
    if (!res.paths.length) return `<p class="desc">Καμία διαδρομή ακόμα — ξεκίνα από το <b>+</b> της αντλίας.</p>`;
    const g = res.g;
    const parts = pt => {
      const out = [];
      pt.edges.forEach((id, i) => {
        const x = res.ecById.get(id);
        if (!x.e.direct || !x.c.complete) out.push(`${esc(edgeLabel(x.e))} ${x.c.complete ? fmt(x.c.dP) : "<span class='errTxt'>—</span>"}`);
        const nid = pt.nodes[i];
        if (nid) { const nc = res.ncById.get(nid); if (nc.m > 0 || !nc.complete) out.push(`${esc(nodeLabel(nc.n))} ${nc.complete ? fmt(nc.m) : "<span class='errTxt'>!</span>"}`); }
      });
      return out.join(" + ");
    };
    const rows = res.paths.slice().sort((a, b) => (b.worst - a.worst) || (b.complete - a.complete) || (b.dP - a.dP)).map(pt => {
      const inc = [...pt.edges.filter(id => !res.ecById.get(id).c.complete).map(id => edgeLabel(g.eById.get(id))), ...pt.nodes.filter(id => !res.ncById.get(id).complete).map(id => nodeLabel(g.nById.get(id)))];
      const outc = !pt.complete ? `<span class="errTxt">Ελλιπής — εκτός υπολογισμού (${esc(inc.join(", "))})</span>`
        : pt.worst && res.worst && res.worst.complete ? `<b class="acc">Δυσμενέστερη — δίνει το H</b>`
        : isFinite(pt.excessKPa) ? `Στραγγαλισμός ${fmt(pt.excessKPa, 1)} kPa${isFinite(pt.kvReq) ? ` · βάνα Kv ≈ ${fmt(pt.kvReq, 2)}` : ""}` : "—";
      return `<tr class="${pt.worst && pt.complete ? "worst" : ""} ${pt.complete ? "" : "inc"}">
        <td>${esc(res.via(pt) || "—")}${pt.toPump ? "" : " <small class='muted'>→ ανοιχτό άκρο</small>"}</td>
        <td class="mono sum">${parts(pt)}</td>
        <td class="r mono"><b>${pt.complete ? fmt(pt.dP) + " mwc" : "—"}</b></td><td>${outc}</td></tr>`;
    }).join("");
    const suc = res.suction ? `<p class="desc">Αναρρόφηση (πηγή → αντλία): <b class="num">${fmt(res.suction.dP)} mwc</b> — προστίθεται στη δυσμενέστερη.</p>` : "";
    return `<div class="tablewrap"><table class="table paths"><thead><tr><th>Μέσω</th><th>Άθροισμα [mwc]</th><th class="r">ΔP</th><th>Αποτέλεσμα</th></tr></thead><tbody>${rows}</tbody></table></div>${suc}`;
  }

  function renderNetPop(res) {
    const el = $("#pop"); if (!el) return;
    const net = project.net;
    const e = pop && pop.edge && net.edges.find(x => x.id === pop.id);
    const n = pop && !pop.edge && net.nodes.find(x => x.id === pop.id);
    if (!n && !e) { el.hidden = true; el.innerHTML = ""; return; }
    const hasPump = net.nodes.some(x => x.type === PUMP);
    const types = DB.NODE_TYPES.filter(t => t.id !== PUMP || !hasPump);
    const SHORT = { junction: "Κόμβος / ταφ", hp: "Αντλία θερμ.", sep: "Διαχωριστής", fcu: "FCU", coil: "Στοιχείο ΚΚΜ", ufh: "Ενδοδαπέδια", rad: "Θερμ. σώμα", device: "Όργανο / βάνα", other: "Άλλο" };
    const typeBtn = (t, attrs) => `<button ${attrs} data-type="${t.id}" title="${esc(t.label)}">${esc(SHORT[t.id] || t.label)}</button>`;
    if (e) {
      const u = net.nodes.find(x => x.id === e.from), v = net.nodes.find(x => x.id === e.to);
      el.innerHTML = `<div class="pop-h">Παρεμβολή στον ${esc(edgeLabel(e))}</div>
        <div class="pop-sub">Ο σωλήνας κόβεται στα δύο: ${esc(nodeLabel(u))} → <b>νέο</b> → ${esc(nodeLabel(v))}.</div>
        <div class="pop-grid">${types.filter(t => t.id !== PUMP).map(t => typeBtn(t, `data-act="insert" data-id="${esc(e.id)}"`)).join("")}</div>`;
    } else {
      const g = res.g;
      const others = net.nodes.filter(x => x.id !== n.id);
      const noIn = o => o.type !== PUMP && g.inE.get(o.id).filter(id => g.eById.get(id).from !== o.id).length === 0;
      const rank = o => o.type === PUMP ? 0 : noIn(o) ? 1 : 2;
      others.sort((a, b) => rank(a) - rank(b));
      const tag = o => o.type === PUMP ? (project.openCircuit ? "αναρρόφηση αντλίας" : "κλείνει το κύκλωμα") : noIn(o) ? "χωρίς είσοδο — ενώνει κομμένο κομμάτι" : nodeType(o.type).short;
      el.innerHTML = `<div class="pop-h">Από: ${esc(nodeLabel(n))}</div>
        <div class="pop-sub">Σωλήνας προς <b>νέο</b> σημείο:</div>
        <div class="pop-grid">${types.map(t => typeBtn(t, `data-act="add-to" data-from="${esc(n.id)}"`)).join("")}</div>
        ${others.length ? `<div class="pop-sub">ή σωλήνας προς <b>υπάρχον</b> σημείο:</div>
        <div class="pop-list">${others.map(o => `<button data-act="connect" data-from="${esc(n.id)}" data-to="${esc(o.id)}" class="${rank(o) < 2 ? "hl" : ""}"><b>→ ${esc(nodeLabel(o))}</b><small>${esc(tag(o))}</small></button>`).join("")}</div>` : ""}`;
    }
    const wrap = $("#schemWrap"), outer = $("#schemOuter"), a = (e ? edgeAnchors.get(e.id) : netAnchors.get(n.id)) || { x: 0, y: 0, hw: 0 };
    const sx = wrap ? wrap.scrollLeft : 0, sy = wrap ? wrap.scrollTop : 0, ow = outer ? outer.clientWidth : 1000, pw = Math.min(410, ow - 8);
    let left = a.x + a.hw + 20 - sx;
    if (left + pw > ow) left = Math.max(4, a.x - a.hw - pw - 20 - sx);
    el.style.left = left + "px";
    el.style.top = Math.max(4, a.y - 40 - sy) + "px";
    el.hidden = false;
  }

  function nodeEditorHtml(res) {
    const n = project.net.nodes.find(x => x.id === selNode); if (!n) return "";
    const t = nodeType(n.type);
    const typeOpts = DB.NODE_TYPES.map(x => `<option value="${x.id}" ${x.id === n.type ? "selected" : ""}>${esc(x.label)}</option>`).join("");
    return `<section class="dr-sec" id="sec-node">
      <div class="br-h"><h2 id="ndTitle"></h2><span class="chip" id="ndChip"></span></div>
      ${sub("Α", "Εξοπλισμός", "ndA", `<div class="grid g2">
        ${field("Τύπος", `<select data-node="type">${typeOpts}</select>`)}
        ${field("Όνομα", `<input type="text" data-node="label" value="${esc(n.label)}">`)}</div>`)}
      ${t.dp ? sub("Β", "Πτώση πίεσης", "ndB", `<div class="grid g2">
        ${field("ΔP στην παροχή σχεδιασμού", `<input type="number" data-node="dP" value="${esc(n.dP)}" step="0.1" placeholder="0">`)}
        ${field("Μονάδα", `<select data-node="unit">${["kPa", "m"].map(u => `<option value="${u}" ${u === n.unit ? "selected" : ""}>${u === "m" ? "mwc" : u}</option>`).join("")}</select>`)}</div>
        <p class="desc">Από το φύλλο του κατασκευαστή.${t.decoupler ? " Buffer, διαχωριστής ή δεξαμενή στη μέση του δικτύου κόβει το κύκλωμα — ό,τι ακολουθεί το κυκλοφορεί άλλη αντλία." : ""}</p>`) : n.type === PUMP ? `<p class="desc">Η αντλία δεν έχει απώλειες· το H που χρειάζεται είναι το αποτέλεσμα. Σε κλειστό κύκλωμα η θέση της δεν αλλάζει το H.</p>` : ""}
      ${n.type !== PUMP ? sub(t.dp ? "Γ" : "Β", "Παροχή μέσα από αυτό <small>προαιρετικό</small>", "ndQ", `<div class="grid g2">
        ${field("Q [m³/h]", `<input type="number" data-node="Q" value="${esc(num(n.loadKW) > 0 ? "" : n.Q)}" step="0.01" ${num(n.loadKW) > 0 ? "disabled placeholder='από φορτίο'" : ""}>`)}
        ${field("ή φορτίο [kW]", `<input type="number" data-node="loadKW" value="${esc(n.loadKW)}" step="0.1">`)}</div>
        <p class="desc">Αν τη δώσεις, οι σωλήνες πριν και μετά παίρνουν παροχή από το ισοζύγιο.</p>`) : ""}
      <div class="sub"><div class="sub-h"><span class="lt">⇄</span><span class="stt">Συνδέσεις και ισοζύγιο</span></div><div class="sub-b" id="ndConn"></div></div>
      <div class="dr-actions">
        <button class="primary small" data-act="plus-node" data-id="${esc(n.id)}">+ Σωλήνας από εδώ</button>
        <button class="ghost small danger" data-act="del-node" data-id="${esc(n.id)}">Διαγραφή</button>
      </div>
    </section>`;
  }
  function renderNodeOutputs(res) {
    const n = project.net.nodes.find(x => x.id === selNode); if (!n || !$("#sec-node")) return;
    const nc = res.ncById.get(n.id), g = res.g;
    $("#ndTitle").innerHTML = `${esc(nodeType(n.type).label)} <span class="brt-desc">· ${esc(nodeLabel(n))}</span>`;
    const chip = $("#ndChip");
    chip.className = "chip " + (!nc.complete ? "c-inc" : nc.warns.length ? "c-warn" : "c-ok");
    chip.textContent = !nc.complete ? "Θέλει διόρθωση" : nc.warns.length ? "Με παρατήρηση" : "Εντάξει";
    const eb = $("#ndB"); if (eb) eb.textContent = nc.m > 0 ? fmt(nc.m) + " mwc" : "";
    const eq = $("#ndQ"); if (eq) eq.textContent = isFinite(nc.sIn) ? fmt(nc.sIn, 2) + " m³/h" : "";
    const line = (ids, dir) => ids.map(id => { const x = res.ecById.get(id), o = g.nById.get(dir === "in" ? x.e.from : x.e.to); return `<li><b class="mono">${esc(edgeLabel(x.e))}</b> ${dir === "in" ? "από" : "προς"} ${esc(nodeLabel(o))} · <span class="num">${x.c.Q > 0 ? fmt(x.c.Q, 2) : "—"} m³/h</span></li>`; }).join("");
    const ins = g.inE.get(n.id), outs = g.outE.get(n.id);
    const balOk = isFinite(nc.sIn) && isFinite(nc.sOut) && !nc.errs.some(e => e.includes("μπαίνουν") || e.includes("διαφέρει"));
    $("#ndConn").innerHTML = `<div class="conn2"><div><h4>Μπαίνουν</h4><ul>${line(ins, "in") || "<li class='muted'>—</li>"}</ul><p class="num">Σ ${fmt(nc.sIn, 2)} m³/h</p></div>
      <div><h4>Βγαίνουν</h4><ul>${line(outs, "out") || `<li class='muted'>${nc.openEnd ? "ανοιχτό άκρο" : "—"}</li>`}</ul><p class="num">Σ ${fmt(nc.sOut, 2)} m³/h</p></div></div>
      ${nc.errs.length ? `<ul class="lst err">${nc.errs.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : balOk ? `<div class="good">Ό,τι μπαίνει βγαίνει.</div>` : ""}
      ${nc.warns.length ? `<ul class="lst warn">${nc.warns.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}`;
  }
  function renderDrawer(res) {
    const dr = $("#drawer"); if (!dr) return;
    const net = project.mode === "network";
    const edge = net && selId && project.net.edges.find(e => e.id === selId);
    const node = net && selNode && project.net.nodes.find(n => n.id === selNode);
    if (!edge && !node) { dr.hidden = true; dr.innerHTML = ""; document.body.classList.remove("drawer-open"); return; }
    dr.innerHTML = `<div class="dr-h"><span>${edge ? "Σωλήνας" : "Εξοπλισμός / σημείο"}</span><button class="icon" data-act="close-drawer" aria-label="Κλείσιμο">✕</button></div>
      <div class="dr-b">${edge ? renderBranchCard(res) : nodeEditorHtml(res)}</div>`;
    dr.hidden = false;
    document.body.classList.add("drawer-open");
  }

  /* ---------------- RENDER: βοηθητικά ---------------- */
  const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
  function descOf(br) { return (br.desc || "").trim() || `${br.pipeFamily} ${br.pipeSize}`; }
  function field(label, inner, cls = "") { return `<div class="fld ${cls}"><label>${label}</label>${inner}</div>`; }
  function unitSel(attr, i, unit) {
    return `<select ${attr}="${i}" data-k="unit" aria-label="Μονάδα">${["kPa", "m"].map(u => `<option value="${u}" ${u === unit ? "selected" : ""}>${u === "m" ? "mwc" : u}</option>`).join("")}</select>`;
  }
  function stateOf(x, res) { return !x.c.complete ? "inc" : branchWarns(x.br, x.c, res).length ? "warn" : "ok"; }
  function stIcon(s) { return s === "ok" ? `<span class="st st-ok">${CHECK}</span>` : s === "warn" ? `<span class="st st-warn">!</span>` : `<span class="st st-inc"></span>`; }
  function sub(letter, title, outId, body) {
    return `<div class="sub"><div class="sub-h"><span class="lt">${letter}</span><span class="stt">${title}</span><b class="num" id="${outId}"></b></div><div class="sub-b">${body}</div></div>`;
  }

  /* ---------------- RENDER: κύρια φόρμα ---------------- */
  function renderMain(res) {
    const m = project.meta, net = project.mode === "network";
    const fl = DB.FLUIDS;
    const fluidOpts = Object.keys(fl).map(k => `<option value="${k}" ${project.fluid === k ? "selected" : ""}>${esc(fl[k].label)}</option>`).join("");
    const hasConc = fl[project.fluid] && fl[project.fluid].hasConc;

    const cProj = `
      <section class="card" id="c-proj">
        <div class="card-h"><h2>Έργο και ρευστό</h2></div>
        <div class="grid g4">
          ${field("Όνομα", `<input type="text" data-meta="name" value="${esc(m.name)}">`)}
          ${field("Κωδικός", `<input type="text" data-meta="code" value="${esc(m.code)}">`)}
          ${field("Ημερομηνία", `<input type="date" data-meta="date" value="${esc(m.date)}">`)}
          ${field("Μηχανικός", `<input type="text" data-meta="engineer" value="${esc(m.engineer)}">`)}
        </div>
        <div class="grid g6 mt">
          ${field("Ρευστό", `<select data-p="fluid">${fluidOpts}</select>`)}
          ${hasConc ? field("Συγκέντρ. [% κ.β.]", `<input type="number" data-p="concPct" value="${esc(project.concPct)}" min="0" max="60" step="5">`) : ""}
          ${field("Θερμοκρασία [°C]", `<input type="number" data-p="waterTemp" value="${esc(project.waterTemp)}" step="1">`)}
          ${field("ΔT [K]", `<input type="number" data-p="dT" value="${esc(project.dT)}" min="0" step="0.5">`)}
          ${field("Προσαύξηση [%]", `<input type="number" data-p="marginPct" value="${esc(project.marginPct)}" min="0" step="5">`)}
          ${field("Κύκλωμα", `<select data-p="openCircuit"><option value="0" ${project.openCircuit ? "" : "selected"}>Κλειστό</option><option value="1" ${project.openCircuit ? "selected" : ""}>Ανοιχτό</option></select>`)}
          ${project.openCircuit ? field("Στατικό ύψος [m]", `<input type="number" data-p="staticHead" value="${esc(project.staticHead)}" step="0.1">`) : ""}
        </div>
        <div class="optrow">
          <label class="check"><input type="checkbox" data-p="aged" ${project.aged ? "checked" : ""}> Παλαιό δίκτυο (αυξημένη τραχύτητα, π.χ. σιδηροσωλήνας 0.046 → 0.2 mm)</label>
          <p class="desc" id="fluidHint"></p>
        </div>
      </section>`;

    const st = project.start;
    const startOpts = DB.START_TYPES.map(t => `<option ${t === st.type ? "selected" : ""}>${esc(t)}</option>`).join("");
    const cSimple = `
      <section class="card" id="c-net">
        <div class="card-h">
          <h2>${net ? "Δίκτυο" : "Διαδρομή"}</h2>
          <div class="segctl" role="group" aria-label="Τρόπος υπολογισμού">
            <button class="${net ? "" : "on"}" data-act="mode" data-mode="simple" aria-pressed="${!net}">Απλή διαδρομή</button>
            <button class="${net ? "on" : ""}" data-act="mode" data-mode="network" aria-pressed="${net}">Δίκτυο με διακλαδώσεις</button>
          </div>
        </div>
        <p class="lead">${net
          ? "Ο βρόχος της αντλίας που υπολογίζεις. Πάτα έναν κλάδο για να τον συμπληρώσεις. Το <b>+</b> στο τέλος ενός κλάδου δίνει συνέχεια μετά από αυτόν ή παράλληλο κλάδο δίπλα του. Ο επιλεγμένος κλάδος σβήνεται με το <b class='x'>✕</b>. Σε κλειστό βρόχο η θέση της αντλίας δεν αλλάζει το H."
          : "Κλάδοι σε σειρά, από την αρχή του βρόχου ως το δυσμενέστερο τερματικό. Όλοι αθροίζονται. Για παράλληλους κλάδους διάλεξε «Δίκτυο με διακλαδώσεις»."}</p>
        <div class="startrow">
          ${field("Αρχή βρόχου", `<select data-start="type">${startOpts}</select>`)}
          ${field("Περιγραφή", `<input type="text" data-start="label" value="${esc(st.label)}" placeholder="π.χ. μετά τον διαχωριστή">`)}
          ${field("ΔP αρχής", `<input type="number" id="startDP" data-start="dP" value="${esc(st.dP)}" step="0.1" placeholder="0">`)}
          ${field("Μονάδα", `<select data-start="unit">${["kPa", "m"].map(u => `<option value="${u}" ${u === st.unit ? "selected" : ""}>${u === "m" ? "mwc" : u}</option>`).join("")}</select>`)}
        </div>
        <p class="desc">${st.type === "Αντλία"
          ? "Ο βρόχος ξεκινά και τελειώνει στην αντλία. Σωλήνες πριν και μετά την αντλία είναι απλώς κλάδοι σε σειρά — η σειρά τους δεν αλλάζει το άθροισμα. ΔP αρχής: κενό."
          : "ΔP της αρχής όταν ο βρόχος περνά μέσα από αυτήν (π.χ. εξατμιστής ψύκτη, εναλλάκτης). Buffer, διαχωριστής, συλλέκτης: άφησέ το κενό. Buffer ή διαχωριστής στη μέση του δικτύου σημαίνει τέλος του βρόχου αυτής της αντλίας — ό,τι ακολουθεί είναι άλλος υπολογισμός."}</p>
        <p class="desc"><b>Επιστροφή:</b> ο βρόχος κλείνει μόνος του. Κλάδος με «×2» μετράει προσαγωγή και επιστροφή ως την αρχή. Αν η επιστροφή ακολουθεί άλλη διαδρομή (π.χ. κοινός συλλέκτης επιστροφής), βάλ' τη ως δικό της κλάδο με «συνολικό» μήκος στην ίδια διαδρομή — αν είναι κοινή για όλους, πριν από τις διακλαδώσεις.</p>
        ${net
          ? `<div class="schem-outer" id="schemOuter"><div class="schem-wrap" id="schemWrap"><div id="schem"></div></div><div id="pop" class="pop" hidden></div></div>
             <div class="legend">
               <span><i class="lg-worst"></i>Δυσμενέστερη διαδρομή — δίνει το H</span>
               <span><i class="lg-dot ok"></i>Πλήρης</span>
               <span><i class="lg-dot warn"></i>Πλήρης, με παρατήρηση</span>
               <span><i class="lg-dot inc"></i>Λείπουν στοιχεία — δεν μετράει</span>
             </div>`
          : `<div class="chain" id="chain"></div>`}
      </section>`;

    const open = !!project.openCircuit;
    const cNet = !net ? cSimple : `
      <section class="card" id="c-net">
        <div class="card-h">
          <h2>Δίκτυο</h2>
          <div class="hbtns">
            <button class="ghost small" data-act="net-expand" aria-pressed="${netFull}">${netFull ? "✕ Κλείσιμο μεγέθυνσης" : "⤢ Μεγέθυνση"}</button>
            <div class="segctl" role="group" aria-label="Τρόπος υπολογισμού">
              <button data-act="mode" data-mode="simple" aria-pressed="false">Απλή διαδρομή</button>
              <button class="on" data-act="mode" data-mode="network" aria-pressed="true">Δίκτυο</button>
            </div>
          </div>
        </div>
        <p class="lead">Στήσε το κύκλωμα ξεκινώντας από την αντλία. Πάτα το <b>+</b> ενός σημείου: νέος σωλήνας προς νέο εξοπλισμό, ή σωλήνας προς υπάρχον σημείο — ${open ? "σε <b>ανοιχτό κύκλωμα</b> σημείο χωρίς συνέχεια είναι ανοιχτό άκρο (π.χ. πύργος, δεξαμενή)" : "έτσι κλείνει το κύκλωμα πίσω στην αντλία"}. Πάτα έναν σωλήνα ή εξοπλισμό για τα στοιχεία του.</p>
        <div class="netstatus" id="netStatus"></div>
        <div class="schem-outer" id="schemOuter"><div class="schem-wrap" id="schemWrap"><div id="schem"></div></div><div id="pop" class="pop" hidden></div></div>
        <div class="legend">
          <span><i class="lg-worst"></i>Δυσμενέστερη διαδρομή — δίνει το H</span>
          <span><i class="lg-dir"></i>Φορά ροής</span>
          <span><i class="lg-dot inc"></i>Λείπουν στοιχεία — δεν μετράει</span>
          <span><i class="lg-box err"></i>Εξοπλισμός με πρόβλημα (ισοζύγιο, σύνδεση)</span>
        </div>
      </section>`;
    const cPaths = net ? `
      <section class="card" id="c-paths">
        <div class="card-h"><h2>Διαδρομές — τι αθροίζεται</h2></div>
        <div id="paths"></div>
      </section>` : "";

    const cBranch = net ? "" : renderBranchCard(res);

    const extras = project.extras.map((e, i) => `
      <div class="eqrow">
        <input type="text" data-ex="${i}" data-k="label" placeholder="π.χ. Εναλλάκτης πλακών" value="${esc(e.label)}" aria-label="Περιγραφή">
        <input type="number" data-ex="${i}" data-k="dP" step="0.01" value="${esc(e.dP)}" aria-label="ΔP" placeholder="ΔP">
        ${unitSel("data-ex", i, e.unit)}
        <button class="icon" data-act="ex-del" data-i="${i}" aria-label="Διαγραφή">✕</button>
      </div>`).join("");
    const cExtras = `
      <section class="card" id="c-extras">
        <div class="card-h"><h2>Κοινός εξοπλισμός</h2><b class="num" id="exTot"></b></div>
        <p class="lead">Ό,τι διαρρέεται από όλη την παροχή της αντλίας (εναλλάκτης, λέβητας, ψύκτης, φίλτρο στο μηχανοστάσιο). Προστίθεται μία φορά στο H. Εξοπλισμός ενός μόνο κλάδου (FCU, ενδοδαπέδια) μπαίνει στον κλάδο του.</p>
        ${extras}
        <button class="add" data-act="ex-add">+ Κοινός εξοπλισμός</button>
      </section>`;

    const pts = project.pump.points.map((p, i) => `
      <tr><td class="muted">${i + 1}</td>
        <td><input type="number" data-pp="${i}" data-k="Q" value="${esc(p.Q)}" step="0.1" aria-label="Q σημείου ${i + 1}"></td>
        <td><input type="number" data-pp="${i}" data-k="H" value="${esc(p.H)}" step="0.1" aria-label="H σημείου ${i + 1}"></td>
        <td>${project.pump.points.length > 3 ? `<button class="icon" data-act="pp-del" data-i="${i}" aria-label="Διαγραφή">✕</button>` : ""}</td></tr>`).join("");
    const cCurve = `
      <details class="card curve" id="c-curve" ${curveOpen ? "open" : ""}>
        <summary><span>Καμπύλη δικτύου και αντλίας</span><small>προαιρετικό</small></summary>
        <p class="lead">Η καμπύλη του δικτύου βγαίνει πάντα. Για σημείο λειτουργίας δώσε 3–5 σημεία από το φύλλο της αντλίας.</p>
        <div class="pumpgrid">
          <div>
            <table class="table"><thead><tr><th></th><th>Q [m³/h]</th><th>H [mwc]</th><th></th></tr></thead><tbody>${pts}</tbody></table>
            ${project.pump.points.length < 5 ? `<button class="add" data-act="pp-add">+ Σημείο</button>` : ""}
            ${field("Βαθμός απόδοσης η [%]", `<input type="number" data-pump="eta" value="${esc(project.pump.eta)}" min="1" max="100" step="1">`)}
          </div>
          <div id="pumpOut"></div>
        </div>
      </details>`;

    const banner = restorable ? `<div class="restore"><span>Υπάρχει έργο από την προηγούμενη επίσκεψη σε αυτόν τον browser: <b>«${esc(restorable.meta.name || "χωρίς όνομα")}»</b> (${restorable.branches.length} κλάδοι).</span>
      <button class="primary small" data-act="restore">Άνοιγμα</button><button class="ghost small" data-act="restore-no">Όχι, νέο έργο</button></div>` : "";
    $("#flowMain").innerHTML = banner + cProj + cNet + cPaths + cBranch + (net ? "" : cExtras) + cCurve;
    const cc = $("#c-curve");
    if (cc) cc.addEventListener("toggle", () => { curveOpen = cc.open; if (curveOpen) liveRecalc(); });
  }

  function renderBranchCard(res) {
    const entry = res.cById.get(selId);
    if (!entry) return "";
    const { br } = entry, net = project.mode === "network";
    const famOpts = DB.PIPE_FAMILIES.map(f => `<option ${f.family === br.pipeFamily ? "selected" : ""}>${esc(f.family)}</option>`).join("");
    const fam = DB.PIPE_FAMILIES.find(f => f.family === br.pipeFamily) || DB.PIPE_FAMILIES[0];
    const sizeOpts = fam.sizes.map(s => `<option ${s[0] === br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("");
    const byLoad = num(br.loadKW) > 0;
    const autoQ = net;
    const dbl = kindOf(br.kind).double;

    let parentSel = "";
    if (net) {
      const opts = sel => project.net.nodes.map(n => `<option value="${esc(n.id)}" ${n.id === sel ? "selected" : ""}>${esc(nodeLabel(n))}</option>`).join("");
      parentSel = field("Από", `<select data-br="from">${opts(br.from)}</select>`) + field("Προς", `<select data-br="to">${opts(br.to)}</select>`);
    }

    const fitRows = br.fittings.map((f, i) => {
      const sizeSel = `<select data-fit="${i}" data-k="size" aria-label="Διατομή"><option value="">= σωλήνα</option>${fam.sizes.map(s => `<option ${s[0] === f.size && f.size !== br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("")}</select>`;
      return `<tr data-fi="${i}">
        <td class="c-type"><select data-fit="${i}" data-k="type" aria-label="Είδος">${fittingSelectHTML(f.type)}</select></td>
        <td class="c-size" data-l="Διατομή">${sizeSel}</td>
        <td class="c-n c-qty" data-l="Τεμ."><input type="number" class="n" data-fit="${i}" data-k="qty" value="${esc(f.qty)}" min="0" step="1" aria-label="Τεμάχια"></td>
        <td class="c-n c-z" data-l="ζ"><input type="number" class="n" data-fit="${i}" data-k="zeta" value="${esc(f.zeta)}" step="0.05" placeholder="ζ" aria-label="ζ"></td>
        <td class="c-n c-kv" data-l="Kv"><input type="number" class="n" data-fit="${i}" data-k="kv" value="${esc(f.kv)}" step="0.1" placeholder="Kv" aria-label="Kv"></td>
        <td class="meth"></td>
        <td class="out r tot" data-l="ΔP [mwc]"></td>
        <td class="c-del"><button class="icon" data-act="fit-del" data-i="${i}" aria-label="Διαγραφή">✕</button></td>
      </tr>`;
    }).join("");

    const eqRows = (br.equip || []).map((e, i) => `
      <div class="eqrow">
        <input type="text" data-eq="${i}" data-k="label" placeholder="π.χ. Στοιχείο FCU" value="${esc(e.label)}" aria-label="Περιγραφή">
        <input type="number" data-eq="${i}" data-k="dP" step="0.1" value="${esc(e.dP)}" aria-label="ΔP" placeholder="ΔP">
        ${unitSel("data-eq", i, e.unit)}
        <button class="icon" data-act="eq-del" data-i="${i}" aria-label="Διαγραφή">✕</button>
      </div>`).join("");

    const A = sub("Α", net ? "Όνομα και σύνδεση" : "Όνομα", "subA", `
      <div class="grid ${net ? "g-a-net2" : "g-a"}">
        ${field("Κωδικός", `<input type="text" class="mono" data-br="code" value="${esc(br.code)}">`)}
        ${field("Περιγραφή", `<input type="text" data-br="desc" value="${esc(br.desc)}" placeholder="${esc(br.pipeFamily + " " + br.pipeSize)}">`)}
        ${parentSel}
      </div>
      ${net ? `<label class="check mt"><input type="checkbox" data-br="direct" ${br.direct ? "checked" : ""}> Απευθείας σύνδεση, χωρίς σωλήνα (ΔP 0)</label>` : ""}
      <p class="desc" id="parInfo"></p>`);
    const B = sub("Β", "Παροχή", "subQ", `
      <div class="grid g3">
        ${field("Q [m³/h]", `<input type="number" data-br="Q" value="${esc(byLoad ? "" : br.Q)}" step="0.01" ${byLoad ? "disabled" : ""} placeholder="${byLoad ? "από φορτίο" : autoQ ? "από ισοζύγιο" : ""}">`)}
        ${field("ή φορτίο [kW]", `<input type="number" data-br="loadKW" value="${esc(br.loadKW)}" step="0.1" placeholder="προαιρετικό">`)}
      </div>
      <p class="desc" id="qInfo"></p>`);
    const C = sub("Γ", "Σωλήνας", "subPipe", `
      <div class="grid g3">
        ${field("Υλικό", `<select data-br="pipeFamily">${famOpts}</select>`)}
        ${field("Διατομή", `<select data-br="pipeSize">${sizeOpts}</select>`)}
        ${field("Μήκος [m]", `<input type="number" data-br="length" value="${esc(br.length)}" step="0.1">`)}
      </div>
      <div class="lenmode"><span>Το μήκος είναι</span>
        <div class="segctl sm" role="group" aria-label="Μήκος">
          ${DB.KINDS.map(k => `<button class="${k.id === br.kind ? "on" : ""}" data-act="lenmode" data-v="${k.id}" aria-pressed="${k.id === br.kind}">${esc(k.label)}</button>`).join("")}
        </div>
        <span id="lenInfo"></span>
      </div>
      <div class="kpis" id="pipeKpis"></div>`);
    const Dd = sub("Δ", "Εξαρτήματα και βάνες", "subFit", `
      ${fitRows ? `<div class="tablewrap"><table class="table fit">
        <thead><tr><th>Είδος</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th>Με</th><th class="r">ΔP [mwc]</th><th></th></tr></thead>
        <tbody>${fitRows}</tbody></table></div>` : ""}
      <button class="add" data-act="fit-add">+ Εξάρτημα</button>
      <p class="desc">Αν δώσεις Kv από το φύλλο του κατασκευαστή, χρησιμοποιείται αυτό αντί για το ζ.${dbl ? " Τα τεμάχια είναι συνολικά για προσαγωγή και επιστροφή." : ""}</p>
      <p class="desc" id="authInfo"></p>`);
    const E = sub("Ε", "Εξοπλισμός του κλάδου <small>ΔP από φύλλο κατασκευαστή</small>", "subEq", `
      ${eqRows}
      <button class="add" data-act="eq-add">+ Εξοπλισμός</button>`);

    return `
      <section class="card br-card" id="sec-branch">
        <div class="br-h">
          <h2 id="brTitle"></h2>
          <span class="chip" id="brChip"></span>
          <span class="brh-btns">${net ? `<button class="ghost small" data-act="insert-open" data-id="${esc(br.id)}" title="Κόβει τον σωλήνα και βάζει ενδιάμεσα σημείο ή εξοπλισμό">+ Παρεμβολή</button>` : ""}
          <button class="ghost small danger" data-act="del" data-id="${esc(br.id)}">Διαγραφή</button></span>
        </div>
        ${A}${B}${br.direct ? "" : C + Dd + E}
        <div class="brtotal">
          <div class="bt-top"><span id="brTotLbl"></span><b id="brTot"></b></div>
          <div class="stack" id="brStack"></div>
          <div class="stack-l" id="brStackL"></div>
        </div>
      </section>`;
  }
  function fittingSelectHTML(selected) {
    let found = false;
    const html = DB.FITTINGS.map(cat =>
      `<optgroup label="${esc(cat.category)}">` +
      cat.items.map(it => { const s = it.name === selected; if (s) found = true; return `<option value="${esc(it.name)}" ${s ? "selected" : ""}>${esc(it.name)}</option>`; }).join("") +
      `</optgroup>`).join("");
    return (!found && selected ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : "") + html;
  }

  /* ---------------- RENDER: έξοδοι (χωρίς να ξαναχτίζονται τα πεδία) ---------------- */
  function renderOutputs(res, val) {
    const fp = res.fp, net = project.mode === "network";
    const fh = $("#fluidHint");
    if (fh) fh.innerHTML = fp.frozen
      ? `<span class="errTxt">Κάτω από το σημείο πήξης (${fmt(fp.tFreeze, 1)} °C).</span>`
      : `ν <b class="num">${fmt(fp.nu * 1e6, 3)}×10⁻⁶ m²/s</b> · ρ <b class="num">${fmt(fp.rho, 1)} kg/m³</b> · cp <b class="num">${fmt(fp.cp, 3)} kJ/kgK</b>` +
        (DB.FLUIDS[project.fluid] && DB.FLUIDS[project.fluid].hasConc ? ` · πήξη <b class="num">${fmt(fp.tFreeze, 1)} °C</b>` : "");

    if (net) { const ns = $("#netStatus"); if (ns) ns.innerHTML = netStatusHtml(res); renderSchematic(res); } else renderChain(res);
    const pth = $("#paths"); if (pth) pth.innerHTML = net ? netPathsTable(res) : "";
    const ex = $("#exTot"); if (ex) ex.textContent = project.extras.length ? fmt(res.sumExtras - res.startM) + " mwc" : "";

    const entry = res.cById.get(selId);
    if (entry && $("#sec-branch")) renderBranchOutputs(entry, res);
    if (net && selNode) renderNodeOutputs(res);

    const po = $("#pumpOut");
    if (po && curveOpen) po.innerHTML = pumpBlock(res);
    renderSide(res, val);
    renderMbar(res);
  }

  function renderChain(res) {
    const el = $("#chain"); if (!el) return;
    const st = project.start;
    const items = res.tree.order.map(id => {
      const x = res.cById.get(id), s = stateOf(x, res), sel = id === selId;
      return `<span class="arr" aria-hidden="true">→</span>
        <button class="cchip s-${s} ${sel ? "sel" : ""}" data-act="pick" data-id="${esc(id)}">
          ${stIcon(s)}<span class="cc-main"><span class="cc-t"><b class="mono">${esc(branchLabel(x.br))}</b><span class="cc-d">${esc(trunc(descOf(x.br), 26))}</span></span>
          <small>${x.c.complete ? fmt(x.c.dP) + " mwc" : "λείπει: " + esc(x.c.missing.join(", "))}</small></span>
        </button>`;
    }).join("");
    el.innerHTML = `<span class="cstart">Αρχή · ${esc(st.type)}${st.label ? ": " + esc(trunc(st.label, 22)) : ""}</span>${items}
      <span class="arr" aria-hidden="true">→</span><button class="add" data-act="add-end">+ Κλάδος</button>`;
  }

  function renderSchematic(res) {
    const host = $("#schem"), wrap = $("#schemWrap"); if (!host || !wrap) return;
    const avail = Math.max(640, wrap.clientWidth - 2);
    const sl = wrap.scrollLeft, st = wrap.scrollTop;
    host.innerHTML = schematicNet(res, true, avail).svg;
    wrap.scrollLeft = sl; wrap.scrollTop = st;
    renderNetPop(res);
  }

  function renderBranchOutputs(entry, res) {
    const { br, c } = entry, p = c.pipe, fp = res.fp, net = project.mode === "network";
    const warns = br.direct ? [] : branchWarns(br, c, res);
    $("#brTitle").innerHTML = net
      ? (br.direct ? `Σύνδεση <span class="brt-desc">· ${esc(nodeLabel(res.g.nById.get(br.from)))} → ${esc(nodeLabel(res.g.nById.get(br.to)))}</span>` : `Σωλήνας <span class="mono">${esc(edgeLabel(br))}</span> <span class="brt-desc">· ${esc(descOf(br))}</span>`)
      : `Κλάδος <span class="mono">${esc(branchLabel(br))}</span> <span class="brt-desc">· ${esc(descOf(br))}</span>`;
    const chip = $("#brChip");
    chip.className = "chip " + (!c.complete ? "c-inc" : warns.length ? "c-warn" : "c-ok");
    chip.textContent = !c.complete ? "Λείπει: " + c.missing.join(", ") : warns.length ? `Πλήρης · ${warns.length} παρατηρ.` : "Πλήρης";
    const pi = $("#parInfo");
    if (pi) {
      pi.innerHTML = net ? `Ροή από <b>${esc(nodeLabel(res.g.nById.get(br.from)))}</b> προς <b>${esc(nodeLabel(res.g.nById.get(br.to)))}</b>.` : "";
    }
    $("#subQ").textContent = c.Q > 0 ? fmt(c.Q, 2) + " m³/h" : "—";
    const qi = [];
    if (c.Qsrc === "load") qi.push(`Από φορτίο: Q = 3600·P/(ρ·cp·ΔT) = <b class="num">${fmt(c.Q, 3)} m³/h</b> (ΔT ${esc(project.dT)} K)`);
    if (net) {
      if (c.Qsrc === "auto") qi.push(c.Q > 0 ? `Από το ισοζύγιο παροχών: <b class="num">${fmt(c.Q, 2)} m³/h</b>.` : "Το ισοζύγιο δίνει μη θετική παροχή — έλεγξε τις παροχές γύρω.");
      else if (c.Qsrc === "none") qi.push("Δεν προκύπτει ακόμα — δώσε Q εδώ ή παροχή/φορτίο σε εξοπλισμό (π.χ. στις τερματικές μονάδες).");
      else if (c.Qsrc === "manual") qi.push("Χειροκίνητη τιμή — σβήσ' την για να βγει από το ισοζύγιο.");
    } else if (c.Qsrc === "auto") qi.push(c.Q > 0 ? `Αυτόματα: άθροισμα των κλάδων μετά = <b class="num">${fmt(c.Q, 2)} m³/h</b>.` : "Αυτόματα από τους κλάδους μετά — δεν έχουν όλοι παροχή ακόμα.");
    $("#qInfo").innerHTML = qi.join(" ");
    if (br.direct) {
      $("#brTotLbl").textContent = "ΔP σύνδεσης"; $("#brTot").textContent = "0 mwc";
      const bs = $("#brStack"); if (bs) bs.innerHTML = ""; const bl = $("#brStackL"); if (bl) bl.innerHTML = "";
      return;
    }
    $("#subPipe").textContent = isFinite(p.dP) ? fmt(p.dP) + " mwc" : "—";
    $("#lenInfo").innerHTML = num(br.length) > 0 ? `στον υπολογισμό <b class="num">${fmt(p.Leff, 1)} m</b>` : "";
    const vs = vState(p.v, p.D_int), rs = rState(p.R);
    $("#pipeKpis").innerHTML = [
      ["Εσωτ. διάμετρος", fmt(p.D_int, 2) + " mm", ""],
      [`Ταχύτητα${isFinite(p.D_int) ? " · όριο " + fmt(vMaxFor(p.D_int), 1) : ""}`, fmt(p.v, 3) + " m/s", vs],
      [`Απώλεια · όριο ${D.rWarn}`, fmt(p.R, 0) + " Pa/m", rs],
      [`Re · ${p.regime || "—"}`, isFinite(p.Re) ? String(Math.round(p.Re)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202F") : "—", p.regime && p.regime !== "τυρβώδης" ? "warn" : ""],
      [`λ · k ${isFinite(p.k) ? p.k : "—"} mm`, fmt(p.lambda, 4), ""]
    ].map(([l, v, s]) => `<div class="kp ${s ? "s-" + s : ""}"><span>${l}</span><b>${v}</b></div>`).join("");
    c.fittings.forEach((r, i) => {
      const row = $(`#sec-branch tr[data-fi="${i}"]`);
      if (!row) return;
      row.querySelector(".meth").textContent = r.method;
      row.querySelector(".out").textContent = fmt(r.total);
      const z = row.querySelector('[data-k="zeta"]'), k = row.querySelector('[data-k="kv"]');
      z.classList.toggle("dim", r.method === "Kv"); k.classList.toggle("dim", r.method !== "Kv");
    });
    $("#subFit").textContent = br.fittings.length ? fmt(c.sumFit) + " mwc" : "";
    $("#authInfo").innerHTML = c.ctrl ? `Βάνα ελέγχου: ΔP <b class="num">${fmt(toKPa(c.ctrl.dPv, fp), 1)} kPa</b> · authority β = <b class="num ${c.ctrl.auth < D.authMin ? "warnTxt" : "ok"}">${fmt(c.ctrl.auth, 2)}</b> (στόχος ≥ ${D.authMin})` : "";
    $("#subEq").textContent = (br.equip || []).length ? fmt(c.sumEquip) + " mwc" : "";
    $("#brTotLbl").textContent = `ΔP ${net ? "σωλήνα" : "κλάδου"} ${branchLabel(br)}`;
    $("#brTot").textContent = `${fmt(c.dP)} mwc · ${fmt(toKPa(c.dP, fp), 1)} kPa`;
    const pd = isFinite(p.dP) ? p.dP : 0, tot = pd + c.sumFit + c.sumEquip;
    const pc = v => tot > 0 ? (100 * v / tot).toFixed(1) : 0;
    $("#brStack").innerHTML = tot > 0 ? `<i class="k1" style="width:${pc(pd)}%"></i><i class="k2" style="width:${pc(c.sumFit)}%"></i><i class="k3" style="width:${pc(c.sumEquip)}%"></i>` : "";
    $("#brStackL").innerHTML = `<span><i class="k1"></i>Γ Σωλήνας ${fmt(pd)}</span><span><i class="k2"></i>Δ Εξαρτήματα ${fmt(c.sumFit)}</span><span><i class="k3"></i>Ε Εξοπλισμός ${fmt(c.sumEquip)}</span>`;
    $$("#sec-branch [data-br='Q'], #sec-branch [data-br='length']").forEach(inp => {
      const k = inp.dataset.br;
      inp.classList.toggle("need", k === "Q" ? !(c.Q > 0) && !inp.disabled : !(num(br.length) > 0));
    });
  }

  function renderSide(res, val) {
    const fp = res.fp;
    const net = res.mode === "network";
    const worstLeaf = !net && res.worst ? res.cById.get(res.worst.leaf) : null;
    const wName = net ? res.worstText : worstLeaf ? branchLabel(worstLeaf.br) : "";
    const rows = [[`Δυσμενέστερη διαδρομή${wName ? (net ? " μέσω " : " → ") + esc(wName) : ""}`, fmt(net && res.suction ? res.worst.dP : res.sumBranches) + " mwc"]];
    if (net && res.suction) rows.push(["Αναρρόφηση (πηγή → αντλία)", fmt(res.suction.dP) + " mwc"]);
    if (res.startM > 0) rows.push([`Αρχή βρόχου (${esc(project.start.type)})`, fmt(res.startM) + " mwc"]);
    if (project.extras.length) rows.push(["Κοινός εξοπλισμός", fmt(res.sumExtras - res.startM) + " mwc"]);
    rows.push([`Προσαύξηση ${fmt(res.margin * 100, 0)} %`, fmt(res.Hfric - res.base) + " mwc"]);
    if (project.openCircuit) rows.push(["Στατικό ύψος", fmt(res.Hstatic, 2) + " mwc"]);
    rows.push(["Υδραυλική ισχύς", isFinite(res.Ph) ? fmt(res.Ph, 0) + " W" : "—"]);

    const miss = val.errors.length ? `<div class="mini"><h3>Τι λείπει</h3><ul class="lst err">${val.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    const obs = val.warns.length ? `<div class="mini"><h3>Παρατηρήσεις</h3><ul class="lst warn">${val.warns.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    const good = !val.errors.length && !val.warns.length ? `<div class="mini"><div class="good">Όλα συμπληρωμένα, χωρίς παρατηρήσεις.</div></div>` : "";
    $("#side").innerHTML = `
      <div class="mini" id="result">
        <h3>Αποτέλεσμα</h3>
        <div class="kpi-main ${res.provisional ? "prov" : ""}">
          <span>Μανομετρικό κυκλοφορητή ${res.provisional ? `<em class="pbadge">προσωρινό</em>` : ""}</span>
          <b>${res.H > 0 ? fmt(res.H, 2) + " mwc" : "—"}</b>
          <span class="kpi-sub">${res.H > 0 ? fmt(toKPa(res.H, fp), 1) + " kPa · " : ""}Q = ${fmt(res.Qd, 2)} m³/h</span>
        </div>
        ${res.provisional ? `<p class="provnote">Λείπουν στοιχεία (δες «Τι λείπει»). Ελλιπείς κλάδοι δεν μετράνε ακόμα — το H μπορεί να αυξηθεί.</p>` : ""}
        ${rows.map(([a, b]) => `<div class="rowline"><span>${a}</span><span>${b}</span></div>`).join("")}
      </div>
      ${miss}${obs}${good}
      <div class="mini actions">
        <button class="primary" data-act="report">Αναφορά PDF</button>
        <button class="primary alt" data-act="save-html" title="Αρχείο .html που ανοίγει το εργαλείο συμπληρωμένο">Αποθήκευση έργου</button>
        <button data-act="save">Αποθήκευση .json</button>
        <button data-act="load">Άνοιγμα αρχείου</button>
        <button class="danger" data-act="new">Νέο έργο</button>
      </div>
      <details class="mini"><summary>Τύποι υπολογισμού</summary><div class="formulas">${DB.THEORY.map(t => `<div><b>${esc(t[0])}</b><br><code>${esc(t[1])}</code>${t[3] ? `<br><span class="muted">${esc(t[3])}</span>` : ""}</div>`).join("")}</div></details>`;
  }

  function renderMbar(res) {
    const mb = $("#mbar"); if (!mb) return;
    mb.innerHTML = `<div><small>Μανομετρικό${res.provisional ? " · προσωρινό" : ""}</small><b>${res.H > 0 ? fmt(res.H, 2) + " mwc" : "—"}</b><small>Q ${fmt(res.Qd, 2)} m³/h</small></div><button data-act="to-side">Ανάλυση ↓</button>`;
  }

  /* ---------------- Διάγραμμα αντλίας / δικτύου (SVG) ---------------- */
  function pumpChart(res, W = 440, Hh = 260) {
    const fit = res.pump.fit, op = res.pump.op;
    const Qd = res.Qd, Hd = res.H, base = res.base, Hs = res.Hstatic;
    if (!(Qd > 0) || !(res.base > 0)) return "";
    const qMax = Math.max(Qd * 1.4, fit ? fit.qMax * 1.05 : 0);
    const sys = q => Hs + base * (q / Qd) * (q / Qd);
    let hMax = Math.max(Hd * 1.3, sys(qMax) * 0.6);
    if (fit) hMax = Math.max(hMax, fit.H(0) * 1.1);
    hMax = Math.min(hMax, Math.max(Hd * 2.5, fit ? fit.H(0) * 1.15 : 0));
    const L = 44, R = 12, T = 12, B = 34, w = W - L - R, h = Hh - T - B;
    const X = q => L + w * q / qMax, Y = v => T + h * (1 - v / hMax);
    const cid = "clp" + Math.random().toString(36).slice(2, 7);
    const pathOf = f => { let d = ""; for (let i = 0; i <= 60; i++) { const q = qMax * i / 60; d += (i ? "L" : "M") + X(q).toFixed(1) + "," + Y(f(q)).toFixed(1); } return d; };
    const ticks = (mx) => { const st = Math.pow(10, Math.floor(Math.log10(mx / 4))); const s = [1, 2, 5, 10].map(k => k * st).find(k => mx / k <= 6) || st * 10; const r = []; for (let v = 0; v <= mx + 1e-9; v += s) r.push(v); return r; };
    const gx = ticks(qMax).map(q => `<line x1="${X(q)}" y1="${T}" x2="${X(q)}" y2="${T + h}" class="g"/><text x="${X(q)}" y="${T + h + 14}" text-anchor="middle">${+q.toFixed(2)}</text>`).join("");
    const gy = ticks(hMax).map(v => `<line x1="${L}" y1="${Y(v)}" x2="${L + w}" y2="${Y(v)}" class="g"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Καμπύλες αντλίας και δικτύου">
      <style>.chart text{font:10px var(--mono,monospace);fill:#4A5A6C}.chart .g{stroke:#E1E6EC}.chart .sys{stroke:#0B6FB8;stroke-width:2.2;fill:none}.chart .pmp{stroke:#132033;stroke-width:2.2;fill:none}</style>
      ${gx}${gy}
      <line x1="${L}" y1="${T + h}" x2="${L + w}" y2="${T + h}" stroke="#9AABBE"/><line x1="${L}" y1="${T}" x2="${L}" y2="${T + h}" stroke="#9AABBE"/>
      <clipPath id="${cid}"><rect x="${L}" y="${T}" width="${w}" height="${h}"/></clipPath>
      <g clip-path="url(#${cid})">
      <path class="sys" d="${pathOf(sys)}"/>
      ${fit ? `<path class="pmp" d="${pathOf(fit.H)}"/>` + fit.pts.map(([q, hh]) => `<circle cx="${X(q)}" cy="${Y(hh)}" r="3" fill="#132033"/>`).join("") : ""}
      </g>
      <circle cx="${X(Qd)}" cy="${Y(Hd)}" r="5" fill="#FFFFFF" stroke="#C2410C" stroke-width="2.4"/>
      ${op ? `<circle cx="${X(op.Q)}" cy="${Y(op.H)}" r="5.5" fill="#1E7A45"/>` : ""}
      <text x="${L + w}" y="${T + h + 28}" text-anchor="end">Q [m³/h]</text>
      <text x="${L + 6}" y="${T + 10}">H [mwc]</text>
    </svg>
    <div class="legend"><span><i class="l-sys"></i>Δίκτυο</span>${fit ? `<span><i class="l-pmp"></i>Αντλία</span>` : ""}<span><i class="l-des"></i>Σχεδιασμός</span>${op ? `<span><i class="l-op"></i>Σημείο λειτουργίας</span>` : ""}</div>`;
  }
  function pumpBlock(res) {
    const op = res.pump.op;
    let txt = "";
    if (!res.pump.fit) txt = `<p class="desc">Χωρίς σημεία αντλίας φαίνεται μόνο η καμπύλη του δικτύου και το σημείο σχεδιασμού.</p>`;
    else if (!op) txt = `<div class="warnbox">Η καμπύλη της αντλίας δεν τέμνει την καμπύλη του δικτύου.</div>`;
    else txt = `<div class="rowline"><span>Σημείο λειτουργίας</span><span>${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} mwc</span></div>
      <div class="rowline"><span>Απόκλιση από σχεδιασμό</span><span>${op.Q >= res.Qd ? "+" : ""}${fmt(100 * (op.Q / res.Qd - 1), 1)} %</span></div>
      <div class="rowline"><span>Υδραυλική ισχύς</span><span>${fmt(op.Ph, 0)} W</span></div>
      <div class="rowline"><span>Ισχύς άξονα</span><span>${isFinite(op.Pshaft) ? fmt(op.Pshaft, 0) + " W" : "δώσε η"}</span></div>`;
    return pumpChart(res) + txt;
  }

  /* ---------------- FULL RENDER ---------------- */
  function render() {
    if (!$("#flowMain")) return;
    const res = calcProject();
    if (selId && !res.cById.has(selId)) selId = null;
    if (res.mode === "network") {
      if (selNode && !res.ncById.has(selNode)) selNode = null;
    } else if (!selId && res.tree.order.length) selId = res.tree.order[0];
    document.body.classList.toggle("net-full", netFull && res.mode === "network");
    renderMain(res);
    renderDrawer(res);
    renderOutputs(res, validate(res));
    save();
  }
  function liveRecalc() {
    const res = calcProject();
    renderOutputs(res, validate(res));
    save();
  }
  function scrollToEl(sel) { const el = $(sel); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" }); }

  /* ---------------- EVENTS ---------------- */
  function curBranch() { return (project.mode === "network" ? project.net.edges : project.branches).find(b => b.id === selId); }
  function curNode() { return project.mode === "network" ? project.net.nodes.find(n => n.id === selNode) : null; }
  /* Δίκτυο: νέος σωλήνας από ένα σημείο προς νέο εξοπλισμό ή προς υπάρχον σημείο.
     Η οθόνη δεν μετακινείται· το νέο στοιχείο δεν ανοίγει μόνο του. */
  function netAdd(fromId, type, toId) {
    const net = project.net, g = graphOf(net);
    const like = [...g.inE.get(fromId), ...g.outE.get(fromId)].map(id => g.eById.get(id)).find(e => !e.direct) || net.edges.find(e => !e.direct);
    snap();
    let to = toId;
    if (!to) { const n = newNode(type); net.nodes.push(n); to = n.id; }
    net.edges.push(newEdge(fromId, to, like, false));
    pop = null;
    render();
  }
  /* Παρεμβολή: ο σωλήνας κόβεται στο νέο σημείο. Ο αρχικός κρατά κωδικό,
     εξαρτήματα και μήκος (να διορθωθεί)· ο νέος μετά το σημείο παίρνει ίδιο
     υλικό και διατομή και μένει χωρίς μήκος ώστε να φαίνεται ότι θέλει στοιχεία. */
  function insertOnEdge(edgeId, type) {
    const net = project.net, e = net.edges.find(x => x.id === edgeId); if (!e) return;
    snap();
    const n = newNode(type); net.nodes.push(n);
    const e2 = newEdge(n.id, e.to, e.direct ? null : e, e.direct);
    e2.kind = e.kind;
    e.to = n.id;
    net.edges.splice(net.edges.indexOf(e) + 1, 0, e2);
    pop = null; selId = null; selNode = null;
    render();
    toast(e.direct ? `Προστέθηκε ${nodeLabel(n)}.` : `Ο ${edgeLabel(e)} κόπηκε στο «${nodeLabel(n)}»: ${edgeLabel(e)} πριν, ${edgeLabel(e2)} μετά. Διόρθωσε το μήκος του ${edgeLabel(e)} και δώσε μήκος στον ${edgeLabel(e2)}.`, true);
  }
  function delEdge(id) {
    const e = project.net.edges.find(x => x.id === id); if (!e) return;
    snap();
    project.net.edges = project.net.edges.filter(x => x.id !== id);
    if (selId === id) selId = null;
    pop = null; render();
    toast(`Διαγράφηκε ο ${edgeLabel(e)}. Ένωσε ξανά με το + του σημείου πριν → «υπάρχον σημείο».`, true);
  }
  /* Διαγραφή σημείου. Αν είναι ενδιάμεσο (ένας σωλήνας μπαίνει, ένας βγαίνει)
     το δίκτυο δεν κόβεται:
     - ίδιος σωλήνας πριν και μετά, ή κόμβος → οι δύο σωλήνες γίνονται ένας (μήκη και εξαρτήματα αθροίζονται)
     - εξοπλισμός ανάμεσα σε διαφορετικούς σωλήνες → μένει κόμβος (αλλαγή διατομής), τίποτα δεν χάνεται. */
  function delNode(id) {
    const net = project.net, n = net.nodes.find(x => x.id === id); if (!n) return;
    const ins = net.edges.filter(e => e.to === id && e.from !== id), outs = net.edges.filter(e => e.from === id && e.to !== id);
    const name = nodeLabel(n);
    snap();
    let msg;
    if (n.type !== PUMP && ins.length === 1 && outs.length === 1 && ins[0].from !== outs[0].to) {
      const a = ins[0], b = outs[0];
      const same = !a.direct && !b.direct && a.pipeFamily === b.pipeFamily && a.pipeSize === b.pipeSize;
      // Η παροχή που είχε δοθεί στο σημείο περνά στον σωλήνα (σε σειρά είναι ίδια)
      const keepQ = e2 => { if (String(e2.Q).trim() === "" && !(num(e2.loadKW) > 0) && (String(n.Q).trim() !== "" || num(n.loadKW) > 0)) { e2.Q = n.Q; e2.loadKW = n.loadKW; } };
      if (a.direct || b.direct || same || n.type === "junction") {
        const keep = a.direct && !b.direct ? b : a, other = keep === a ? b : a;
        const from = a.from, to = b.to;
        if (!a.direct && !b.direct) {
          const la = String(a.length).trim() === "" ? NaN : lengthEff(a), lb = String(b.length).trim() === "" ? NaN : lengthEff(b);
          const L = la + lb;
          keep.length = isFinite(L) ? String(+(L / (kindOf(keep.kind).double ? 2 : 1)).toFixed(2)) : "";
          keep.fittings = a.fittings.concat(b.fittings);
          keep.equip = (a.equip || []).concat(b.equip || []);
          if (String(keep.Q).trim() === "" && !(num(keep.loadKW) > 0)) { keep.Q = other.Q; keep.loadKW = other.loadKW; }
        }
        keep.from = from; keep.to = to; keepQ(keep);
        net.edges = net.edges.filter(x => x !== other);
        net.nodes = net.nodes.filter(x => x.id !== id);
        msg = a.direct || b.direct ? `Διαγράφηκε: ${name}. Ο ${edgeLabel(keep)} συνεχίζει.`
          : `Διαγράφηκε: ${name}. Οι ${edgeLabel(a)} και ${edgeLabel(b)} έγιναν ένας (${edgeLabel(keep)}): μήκη και εξαρτήματα αθροίστηκαν${same ? "" : `, διατομή ${keep.pipeFamily} ${keep.pipeSize} — έλεγξέ τη`}.`;
      } else {
        keepQ(a);
        const j = newNode("junction");
        Object.assign(n, { type: "junction", label: j.label, dP: "", Q: "", loadKW: "" });
        msg = `Αφαιρέθηκε ο εξοπλισμός ${name}. Έμεινε κόμβος αλλαγής διατομής ανάμεσα σε ${edgeLabel(a)} (${a.pipeSize}) και ${edgeLabel(b)} (${b.pipeSize}).`;
      }
    } else {
      const k = net.edges.filter(e => e.from === id || e.to === id).length;
      net.edges = net.edges.filter(e => e.from !== id && e.to !== id);
      net.nodes = net.nodes.filter(x => x.id !== id);
      msg = `Διαγράφηκε: ${name}${k ? ` και ${k === 1 ? "ο σωλήνας του" : `οι ${k} σωλήνες του`}` : ""}.`;
    }
    selNode = null; pop = null; render();
    toast(msg, true);
  }
  /* Αναίρεση αντί για παράθυρα επιβεβαίωσης: κάθε αλλαγή δομής κρατά αντίγραφο. */
  const undoStack = [];
  function snap() { undoStack.push(JSON.stringify(project)); if (undoStack.length > 50) undoStack.shift(); }
  function undo() {
    const s = undoStack.pop();
    if (!s) { toast("Δεν υπάρχει κάτι για αναίρεση."); return; }
    project = normalize(JSON.parse(s)); pop = null;
    render(); toast("Αναιρέθηκε.");
  }
  let toastT = null;
  function toast(msg, canUndo) {
    if (typeof document === "undefined" || !document.body) return;
    let el = $("#toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
    el.innerHTML = `<span>${esc(msg)}</span>${canUndo ? `<button data-act="undo">Αναίρεση</button>` : ""}<button class="icon" data-act="toast-x" aria-label="Κλείσιμο">✕</button>`;
    el.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, canUndo ? 9000 : 3000);
  }
  /* Ο νέος κλάδος επιλέγεται αλλά η οθόνη μένει εκεί που είσαι: στήνεις πρώτα
     το δίκτυο και τον συμπληρώνεις μετά (μένει κόκκινος ως τότε). */
  function addBranch(parentId, like) {
    const b = blankBranch(parentId, like);
    project.branches.push(b); selId = b.id; pop = null;
    render();
  }

  function onInput(e) {
    const t = e.target;
    if (t.tagName === "SELECT" || t.type === "checkbox") return;   // στο change
    const ds = t.dataset;
    if (ds.meta) { project.meta[ds.meta] = t.value; liveRecalc(); return; }
    if (ds.p) { project[ds.p] = t.value; liveRecalc(); return; }
    if (ds.start) { project.start[ds.start] = t.value; liveRecalc(); return; }
    if (ds.br) {
      const br = curBranch(); if (!br) return;
      br[ds.br] = t.value;
      if (ds.br === "loadKW") { const q = $("#sec-branch [data-br='Q']"); const on = num(t.value) > 0; if (q) { q.disabled = on; q.placeholder = on ? "από φορτίο" : ""; if (on) q.value = ""; } }
      liveRecalc(); return;
    }
    if (ds.node) {
      const n = curNode(); if (!n) return;
      n[ds.node] = t.value;
      if (ds.node === "loadKW") { const q = $("#sec-node [data-node='Q']"); const on = num(t.value) > 0; if (q) { q.disabled = on; q.placeholder = on ? "από φορτίο" : ""; if (on) q.value = ""; } }
      liveRecalc(); return;
    }
    if (ds.fit !== undefined) { curBranch().fittings[+ds.fit][ds.k] = t.value; liveRecalc(); return; }
    if (ds.eq !== undefined) { curBranch().equip[+ds.eq][ds.k] = t.value; liveRecalc(); return; }
    if (ds.ex !== undefined) { project.extras[+ds.ex][ds.k] = t.value; liveRecalc(); return; }
    if (ds.pp !== undefined) { project.pump.points[+ds.pp][ds.k] = t.value; liveRecalc(); return; }
    if (ds.pump) { project.pump[ds.pump] = t.value; liveRecalc(); return; }
  }
  function onChange(e) {
    const t = e.target, ds = t.dataset;
    if (t.tagName !== "SELECT" && t.type !== "checkbox") return;
    if (ds.p === "fluid") { project.fluid = t.value; render(); return; }
    if (ds.p === "openCircuit") { project.openCircuit = t.value === "1"; render(); return; }
    if (ds.p === "aged") { project.aged = t.checked; liveRecalc(); return; }
    if (ds.start) { project.start[ds.start] = t.value; liveRecalc(); return; }
    if (ds.node) { const n = curNode(); if (!n) return; n[ds.node] = t.value; render(); return; }
    if (ds.br) {
      const br = curBranch(); if (!br) return;
      if (ds.br === "parent") br.parent = t.value || null;
      else if (ds.br === "direct") { br.direct = t.checked; if (!br.direct && !br.code) br.code = nextCode(); }
      else br[ds.br] = t.value;
      if (ds.br === "pipeFamily") { const fam = DB.PIPE_FAMILIES.find(f => f.family === t.value); br.pipeSize = fam.sizes[0][0]; br.fittings.forEach(f => { f.size = ""; }); }
      render(); return;
    }
    if (ds.fit !== undefined) {
      const br = curBranch(), i = +ds.fit;
      if (ds.k === "type") {
        const def = findFittingDef(t.value);
        br.fittings[i].type = t.value;
        if (def) {
          br.fittings[i].zeta = (def.zeta != null && def.zeta !== 0) ? def.zeta : "";
          br.fittings[i].kv = (def.kv != null) ? def.kv : "";
        }
      } else br.fittings[i][ds.k] = t.value;
      render(); return;
    }
    if (ds.eq !== undefined) { curBranch().equip[+ds.eq][ds.k] = t.value; liveRecalc(); return; }
    if (ds.ex !== undefined) { project.extras[+ds.ex][ds.k] = t.value; liveRecalc(); return; }
  }
  function onClick(e) {
    const t = e.target.closest("[data-act]");
    if (pop && !e.target.closest("#pop") && !(t && /^(plus|plus-node|plus-edge|insert-open)$/.test(t.dataset.act))) { pop = null; const p = $("#pop"); if (p) { p.hidden = true; p.innerHTML = ""; } }
    if (!t) return;
    const a = t.dataset.act, id = t.dataset.id;
    if (a === "undo") { undo(); return; }
    if (a === "toast-x") { const x = $("#toast"); if (x) x.hidden = true; return; }
    if (a === "mode") {
      snap();
      const r = setMode(t.dataset.mode);
      if (!r.ok) { alert(r.msg); return; }
      pop = null; render(); return;
    }
    if (project.mode === "network") {
      if (a === "pick") { selId = id; selNode = null; pop = null; render(); return; }
      if (a === "pick-node") { selNode = id; selId = null; pop = null; render(); return; }
      if (a === "plus" || a === "plus-node") { pop = pop && pop.id === id ? null : { id }; renderNetPop(calcProject()); return; }
      if (a === "plus-edge") { pop = pop && pop.id === id ? null : { id, edge: true }; renderNetPop(calcProject()); return; }
      if (a === "insert-open") { const r = $("#schemWrap"); pop = { id, edge: true }; renderNetPop(calcProject()); if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" }); return; }
      if (a === "add-to") { netAdd(t.dataset.from, t.dataset.type); return; }
      if (a === "connect") { netAdd(t.dataset.from, null, t.dataset.to); return; }
      if (a === "insert") { insertOnEdge(id, t.dataset.type); return; }
      if (a === "del-node") { delNode(id); return; }
      if (a === "del") { delEdge(id); return; }
      if (a === "close-drawer") { selId = null; selNode = null; render(); return; }
      if (a === "net-expand") { netFull = !netFull; render(); return; }
    }
    if (a === "pick") { selId = id; pop = null; render(); scrollToEl("#sec-branch"); return; }
    if (a === "add-end") { const last = project.branches[project.branches.length - 1]; addBranch(last ? last.id : null, last); return; }
    if (a === "start-eq") { pop = null; const s = $("#startDP"); if (s) s.focus(); return; }
    if (a === "del") { delBranch(id); return; }
    if (a === "lenmode") { const br = curBranch(); if (br) { br.kind = t.dataset.v; render(); } return; }
    if (a === "fit-add") { const br = curBranch(); const def = DB.FITTINGS[0].items[0]; br.fittings.push({ type: def.name, size: "", qty: 1, zeta: def.zeta || "", kv: def.kv || "" }); render(); return; }
    if (a === "fit-del") { curBranch().fittings.splice(+t.dataset.i, 1); render(); return; }
    if (a === "eq-add") { curBranch().equip.push({ label: "", dP: "", unit: "kPa" }); render(); return; }
    if (a === "eq-del") { curBranch().equip.splice(+t.dataset.i, 1); render(); return; }
    if (a === "ex-add") { project.extras.push({ label: "", dP: "", unit: "kPa" }); render(); return; }
    if (a === "ex-del") { project.extras.splice(+t.dataset.i, 1); render(); return; }
    if (a === "pp-add") { project.pump.points.push({ Q: "", H: "" }); render(); return; }
    if (a === "pp-del") { project.pump.points.splice(+t.dataset.i, 1); render(); return; }
    if (a === "report") { openReport(); return; }
    if (a === "save") { saveFile(); return; }
    if (a === "save-html") { saveHtmlFile(); return; }
    if (a === "restore") { if (restorable) { project = normalize(restorable); restorable = null; selId = null; pop = null; render(); } return; }
    if (a === "restore-no") { restorable = null; render(); return; }
    if (a === "load") { $("#fileInput").click(); return; }
    if (a === "to-side") { const s = $("#side"); if (s) s.scrollIntoView({ behavior: "smooth" }); return; }
    if (a === "new") { snap(); project = blankProject(); selId = null; selNode = null; pop = null; render(); toast("Νέο έργο.", true); return; }
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z") && !/INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || "")) { e.preventDefault(); undo(); return; }
    if (e.key === "Escape") {
      if (pop) { pop = null; const p = $("#pop"); if (p) { p.hidden = true; p.innerHTML = ""; } return; }
      if (project.mode === "network" && (selId || selNode)) { selId = null; selNode = null; render(); return; }
      if (netFull) { netFull = false; render(); return; }
    }
    const t = e.target;
    if (e.key === "Delete" && t && t.classList && t.dataset && t.dataset.id && !/INPUT|SELECT|TEXTAREA/.test(t.tagName)) {
      if (t.classList.contains("nd")) { e.preventDefault(); delNode(t.dataset.id); return; }
      if (t.classList.contains("seg")) {
        e.preventDefault();
        if (project.mode !== "network") { delBranch(t.dataset.id); return; }
        delEdge(t.dataset.id);
        return;
      }
    }
    if ((e.key === "Enter" || e.key === " ") && t && t.getAttribute && t.getAttribute("role") === "button" && t.tagName !== "BUTTON") {
      e.preventDefault(); t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }
  function delBranch(id) {
    const b = project.branches.find(x => x.id === id); if (!b) return;
    const kids = project.branches.filter(x => x.parent === id);
    const msg = `Διαγράφηκε ο ${branchLabel(b)}.` + (kids.length ? ` Οι ${kids.map(branchLabel).join(", ")} ξεκινούν πλέον από εκεί που ξεκινούσε.` : "");
    snap();
    kids.forEach(k => { k.parent = b.parent; });
    project.branches = project.branches.filter(x => x.id !== id);
    if (selId === id) selId = b.parent || null;
    pop = null;
    render();
    toast(msg, true);
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
  }

  /* ---------------- PERSISTENCE ---------------- */
  function isEmpty(p) { return !p.branches.length && !p.extras.length && !(p.net && p.net.edges.length); }
  function save() { try { if (isEmpty(project)) localStorage.removeItem(LS_KEY); else localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (e) { } }
  /* Δεν ανοίγει μόνο του ό,τι έμεινε στον browser· προτείνεται με κουμπί.
     Κλειδιά άλλων εκδόσεων σβήνονται. */
  function load() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith("pumpcalc.project.") && k !== LS_KEY) localStorage.removeItem(k); }
      const s = localStorage.getItem(LS_KEY);
      if (s) { const p = normalize(JSON.parse(s)); if (!isEmpty(p)) restorable = p; }
    } catch (e) { }
  }
  const fileSafe = (x) => (String(x || "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 80) || "kykloforitis");
  function dateStamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function download(content, type, name) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  /* Αρχείο έργου .html (όπως στο LoadCalculator): κρατά τα δεδομένα και με διπλό
     κλικ ανοίγει το εργαλείο συμπληρωμένο. Τα δεδομένα είναι και JSON μέσα στο
     <script id="pcproj"> — διαβάζονται και από το «Άνοιγμα αρχείου». */
  function saveHtmlFile() {
    const json = JSON.stringify(project).replace(/</g, "\\u003c");
    const app = location.href.split("#")[0];
    const name = esc(project.meta.name || "Έργο");
    const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>${name} — Υπολογισμός κυκλοφορητή</title></head>`
      + `<body style="font-family:system-ui,sans-serif;padding:40px;color:#132033">`
      + `<p>Άνοιγμα του έργου «${name}» στον Υπολογισμό κυκλοφορητή…</p>`
      + `<p><a id="go" href="${esc(app)}">Αν δεν ανοίξει αυτόματα, πάτα εδώ.</a></p>`
      + `<p style="color:#4A5A6C;font-size:14px">Αρχείο έργου PumpCalculator v${esc(APP_VERSION)}. Ανοίγει και με το «Άνοιγμα αρχείου» μέσα στο εργαλείο.</p>`
      + `<script id="pcproj" type="application/json">${json}<\/script>`
      + `<script>(function(){var A=${JSON.stringify(app)};var j=document.getElementById("pcproj").textContent;var b=btoa(unescape(encodeURIComponent(j)));var u=A+"#pcproj="+encodeURIComponent(b);document.getElementById("go").href=u;location.replace(u);})();<\/script>`
      + `</body></html>`;
    download(html, "text/html;charset=utf-8", `${fileSafe(project.meta.name)} ${dateStamp()}.pump.html`);
  }
  function parseProjectText(text) {
    const t = String(text || "").trim();
    if (t.startsWith("{")) return JSON.parse(t);
    const doc = new DOMParser().parseFromString(t, "text/html");
    const node = doc.getElementById("pcproj");
    if (!node) throw new Error("no project data");
    return JSON.parse(node.textContent);
  }
  function loadFromHash() {
    const m = /[#&]pcproj=([^&]+)/.exec(location.hash || "");
    if (!m) return false;
    try {
      const j = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
      project = normalize(JSON.parse(j)); restorable = null;
      history.replaceState(null, "", location.href.split("#")[0]);
      return true;
    } catch (e) { alert("Το αρχείο έργου δεν διαβάστηκε."); return false; }
  }
  function saveFile() {
    download(JSON.stringify(project, null, 2), "application/json", `${fileSafe(project.meta.name)} ${dateStamp()}.pump.json`);
  }
  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = parseProjectText(r.result);
        const had = !isEmpty(project);
        if (had) snap();
        project = normalize(p); restorable = null; selId = null; pop = null; render();
        if (had) toast("Άνοιξε το αρχείο· το προηγούμενο έργο αντικαταστάθηκε.", true);
      }
      catch (e) { alert("Το αρχείο δεν είναι έργο του Υπολογισμού κυκλοφορητή (.html ή .json)."); }
    };
    r.readAsText(file);
  }

  /* ---------------- REPORT ---------------- */
  const REPORT_CSS = `
    @page { size: A4; margin: 14mm 14mm 16mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif; color: #132033; font-size: 10pt; line-height: 1.4; }
    .num, .mono { font-family: "IBM Plex Mono", Consolas, monospace; white-space: nowrap; }
    header.rep { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #0B6FB8; padding-bottom: 8px; margin-bottom: 12px; }
    header.rep h1 { margin: 0; font-size: 17pt; letter-spacing: -0.01em; }
    header.rep .meta { text-align: right; font-size: 9pt; color: #4A5A6C; }
    header.rep .meta b { color: #132033; }
    h2 { font-size: 12pt; margin: 16px 0 6px; color: #0B4F86; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid #9AABBE; padding-bottom: 3px; }
    .prov { border: 2px solid #B42318; background: #FDECEA; color: #B42318; border-radius: 6px; padding: 6px 10px; font-weight: 700; margin-bottom: 10px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0 12px; }
    .kpi { border: 1px solid #D5DCE4; border-radius: 8px; padding: 8px 10px; }
    .kpi .l { font-size: 8.5pt; color: #4A5A6C; }
    .kpi .v { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13pt; font-weight: 600; }
    .kpi .s { font-size: 8pt; color: #4A5A6C; font-family: "IBM Plex Mono", Consolas, monospace; }
    .kpi.main { background: #EEF5FC; border-color: #B9D3EA; }
    .kpi.main .v { color: #0B4F86; font-size: 15pt; }
    table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; }
    th, td { padding: 4px 6px; border-bottom: 1px solid #E1E6EC; text-align: left; vertical-align: top; }
    thead th { font-size: 8.5pt; color: #4A5A6C; font-weight: 600; border-bottom: 1.5px solid #9AABBE; }
    td.r, th.r { text-align: right; }
    tr.tot td { font-weight: 700; border-top: 1.5px solid #132033; border-bottom: 0; }
    tr.H td { font-weight: 700; background: #EEF5FC; color: #0B4F86; }
    tr.wst td { background: #EEF5FC; }
    tr.inc td { color: #B42318; }
    .code { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 600; }
    .ktag { display: inline-block; font-size: 7.5pt; font-weight: 600; padding: 0 5px; border-radius: 4px; background: #EEF1F5; color: #26364A; margin-left: 4px; }
    .br { break-inside: avoid; margin: 10px 0 6px; }
    .br .bh { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
    .br .badge { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 600; color: #fff; background: #0B6FB8; border-radius: 5px; padding: 1px 8px; font-size: 10.5pt; }
    .br .bt { font-size: 11pt; font-weight: 700; }
    .br .params { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 8.5pt; color: #4A5A6C; margin-bottom: 4px; }
    .dpline { text-align: right; font-size: 9.5pt; }
    .dpline b { background: #EEF5FC; color: #0B4F86; padding: 2px 8px; border-radius: 4px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .warnbox { border: 1px solid #F3D9A4; background: #FFF6E5; color: #6B4A00; border-radius: 6px; padding: 6px 10px; font-size: 9pt; margin-bottom: 8px; }
    .errbox { border: 1px solid #F4B8B2; background: #FDECEA; color: #B42318; border-radius: 6px; padding: 6px 10px; font-size: 9pt; margin-bottom: 8px; }
    .warnbox ul, .errbox ul { margin: 2px 0 0 16px; padding: 0; }
    .chart { width: 100%; max-width: 440px; }
    .chart text { font: 9px "IBM Plex Mono", monospace; fill: #4A5A6C; }
    .legend { display: flex; gap: 12px; font-size: 8.5pt; color: #4A5A6C; }
    .legend i { display: inline-block; width: 14px; height: 3px; margin-right: 4px; vertical-align: middle; }
    .l-sys { background: #0B6FB8; } .l-pmp { background: #132033; } .l-des { background: #C2410C; } .l-op { background: #1E7A45; }
    .cols { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; align-items: start; }
    code { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 8.5pt; }
    .note { font-size: 8.5pt; color: #4A5A6C; border-top: 1px solid #D5DCE4; margin-top: 16px; padding-top: 8px; }
    .pb { break-before: page; }
    footer.rep { margin-top: 18px; font-size: 8pt; color: #5E6E80; display: flex; justify-content: space-between; }
    svg.schem { width: 100%; height: auto; border: 1px solid #D5DCE4; border-radius: 8px; }
    @media screen { body { padding: 24px; max-width: 900px; margin: 0 auto; } }
  `;
  function openReport() {
    if (project.mode === "network") { openReportNet(); return; }
    const res = calcProject();
    const val = validate(res);
    if (val.errors.length && !confirm(`Υπάρχουν ${val.errors.length} ελλείψεις. Το H είναι προσωρινό. Συνέχεια στην αναφορά;`)) return;
    const m = project.meta, fp = res.fp, net = project.mode === "network";
    const kp = h => fmt(toKPa(h, fp), 1);
    const onWorst = new Set(res.worst ? res.worst.ids : []);

    const sumRows = res.tree.order.map(id => {
      const { br, c } = res.cById.get(id), p = c.pipe;
      return `<tr class="${c.complete ? "" : "inc"}"><td class="code">${esc(branchLabel(br))}${onWorst.has(id) && net ? " ★" : ""}</td>
        <td><b>${esc(descOf(br))}</b></td><td>${esc(br.pipeFamily)} ${esc(br.pipeSize)}</td>
        <td class="r num">${fmt(p.Leff, 1)}${kindOf(br.kind).double ? "<span class='ktag'>×2</span>" : ""}</td><td class="r num">${fmt(c.Q, 2)}</td><td class="r num">${fmt(p.v, 2)}</td>
        <td class="r num">${fmt(p.R, 0)}</td><td class="r num">${c.complete ? fmt(c.dP) : "ελλιπής"}</td></tr>`;
    }).join("");

    const circRows = res.circuits.slice().sort((a, b) => (b.worst - a.worst) || (b.complete - a.complete) || (b.dP - a.dP)).map(ci => {
      const leaf = res.cById.get(ci.leaf).br;
      return `<tr class="${ci.worst && ci.complete ? "wst" : ""} ${ci.complete ? "" : "inc"}"><td class="code">${esc(branchLabel(leaf))}</td><td>${esc(descOf(leaf))}</td>
        <td class="mono">${ci.ids.map(id => esc(branchLabel(res.cById.get(id).br))).join(" + ")}</td>
        <td class="r num">${ci.complete ? fmt(ci.dP) : "—"}</td>
        <td class="r num">${!ci.complete ? "ελλιπής" : ci.worst ? "δυσμενέστερη" : fmt(ci.excessKPa, 1)}</td><td class="r num">${ci.complete && !ci.worst ? fmt(ci.kvReq, 2) : "—"}</td></tr>`;
    }).join("");

    const hRows = `
      <tr><td>Δυσμενέστερη διαδρομή${res.worst ? " → " + esc(branchLabel(res.cById.get(res.worst.leaf).br)) : ""}</td><td class="r num">${fmt(res.sumBranches)}</td><td class="r num">${kp(res.sumBranches)}</td></tr>
      ${res.startM > 0 ? `<tr><td>Αρχή βρόχου: ${esc(project.start.type)}${project.start.label ? " — " + esc(project.start.label) : ""}</td><td class="r num">${fmt(res.startM)}</td><td class="r num">${kp(res.startM)}</td></tr>` : ""}
      ${project.extras.map(e => `<tr><td>${esc(e.label || "Εξοπλισμός")}</td><td class="r num">${fmt(toM(e.dP, e.unit, fp))}</td><td class="r num">${kp(toM(e.dP, e.unit, fp))}</td></tr>`).join("")}
      <tr class="tot"><td>Σύνολο χωρίς προσαύξηση</td><td class="r num">${fmt(res.base)}</td><td class="r num">${kp(res.base)}</td></tr>
      <tr><td>Προσαύξηση ${fmt(res.margin * 100, 0)} %</td><td class="r num">${fmt(res.Hfric - res.base)}</td><td class="r num">${kp(res.Hfric - res.base)}</td></tr>
      ${project.openCircuit ? `<tr><td>Στατικό ύψος</td><td class="r num">${fmt(res.Hstatic)}</td><td class="r num">${kp(res.Hstatic)}</td></tr>` : ""}
      <tr class="H"><td>Μανομετρικό κυκλοφορητή H${res.provisional ? " (προσωρινό)" : ""}</td><td class="r num">${fmt(res.H)}</td><td class="r num">${kp(res.H)}</td></tr>`;

    const detail = res.tree.order.map(id => {
      const { br, c } = res.cById.get(id), p = c.pipe;
      const fits = br.fittings.map((f, j) => {
        const r = c.fittings[j];
        return `<tr><td>${esc(f.type)}</td><td>${r.ownSize ? esc(f.size) : "—"}</td><td class="r num">${esc(f.qty)}</td>
          <td class="r num">${r.method === "ζ" ? esc(f.zeta) : "—"}</td><td class="r num">${r.method === "Kv" ? esc(f.kv) : "—"}</td>
          <td class="r num">${fmt(r.per)}</td><td class="r num">${fmt(r.total)}</td></tr>`;
      }).join("");
      const eqs = (br.equip || []).map((e, j) => `<tr><td>${esc(e.label || "Εξοπλισμός")}</td><td>—</td><td></td><td></td><td></td><td class="r num">${esc(e.dP)} ${esc(e.unit)}</td><td class="r num">${fmt(c.equip[j])}</td></tr>`).join("");
      const dbl = kindOf(br.kind).double;
      const from = net ? (br.parent ? ` · ξεκινά από το τέλος του ${esc(branchLabel(res.tree.byId.get(br.parent)))}` : " · ξεκινά από την αρχή") : "";
      return `<div class="br">
        <div class="bh"><span class="badge">${esc(branchLabel(br))}</span><span class="bt">${esc(descOf(br))}</span>${c.complete ? "" : `<span class="ktag" style="background:#FDECEA;color:#B42318">ελλιπής: ${esc(c.missing.join(", "))}</span>`}</div>
        <div class="params">${esc(br.pipeFamily)} ${esc(br.pipeSize)} · D ${fmt(p.D_int, 2)} mm · k ${fmt(p.k, 3)} mm · L ${dbl ? `2×${esc(br.length)} = ` : ""}${fmt(p.Leff, 1)} m · Q ${fmt(c.Q, 2)} m³/h${c.Qsrc === "load" ? ` (${esc(br.loadKW)} kW)` : c.Qsrc === "auto" ? " (Σ κλάδων μετά)" : ""}<br>v ${fmt(p.v, 3)} m/s · Re ${isFinite(p.Re) ? Math.round(p.Re) : "—"} (${esc(p.regime || "—")}) · λ ${fmt(p.lambda, 4)} · R ${fmt(p.R, 0)} Pa/m · ΔP σωλήνα ${fmt(p.dP)} m${from}</div>
        ${fits || eqs ? `<table><thead><tr><th>Εξάρτημα / εξοπλισμός</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th class="r">ΔP/τεμ [mwc]</th><th class="r">ΔP [mwc]</th></tr></thead><tbody>${fits}${eqs}</tbody></table>` : ""}
        ${c.ctrl ? `<div class="params">Βάνα ελέγχου: authority β = ${fmt(c.ctrl.auth, 2)}</div>` : ""}
        <p class="dpline">ΔP κλάδου ${esc(branchLabel(br))} = <b>${fmt(c.dP)} mwc · ${kp(c.dP)} kPa</b></p>
      </div>`;
    }).join("");

    const theory = DB.THEORY.map(t => `<tr><td>${esc(t[0])}</td><td><code>${esc(t[1])}</code></td><td>${esc(t[2])}</td><td>${esc(t[3])}</td></tr>`).join("");
    const op = res.pump.op;
    const pumpSec = res.Qd > 0 && res.base > 0 ? `<h2>Καμπύλη δικτύου${res.pump.fit ? " και αντλίας" : ""}</h2><div class="cols"><div>${pumpChart(res)}</div><div>
        <table><tbody>
          <tr><td>Σχεδιασμός</td><td class="r num">${fmt(res.Qd, 2)} m³/h · ${fmt(res.H, 2)} mwc</td></tr>
          ${op ? `<tr><td>Σημείο λειτουργίας</td><td class="r num">${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} mwc</td></tr>
          <tr><td>Υδραυλική ισχύς</td><td class="r num">${fmt(op.Ph, 0)} W</td></tr>
          <tr><td>Ισχύς άξονα${res.pump.eta > 0 ? ` (η ${fmt(res.pump.eta * 100, 0)} %)` : ""}</td><td class="r num">${isFinite(op.Pshaft) ? fmt(op.Pshaft, 0) + " W" : "—"}</td></tr>`
          : `<tr><td>Υδραυλική ισχύς (σχεδιασμός)</td><td class="r num">${fmt(res.Ph, 0)} W</td></tr>`}
        </tbody></table></div></div>` : "";

    const errBox = val.errors.length ? `<div class="errbox"><b>Ελλείψεις</b><ul>${val.errors.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const warnBox = val.warns.length ? `<div class="warnbox"><b>Παρατηρήσεις</b><ul>${val.warns.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const date = m.date ? new Date(m.date).toLocaleDateString("el-GR") : "";
    const schemSec = net ? `<h2>Διάγραμμα δικτύου</h2>${schematic(res, false, 680).svg}` : "";

    const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Αναφορά κυκλοφορητή — ${esc(m.name)}</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>${REPORT_CSS}</style></head><body>
      <header class="rep"><div><h1>Υπολογισμός μανομετρικού κυκλοφορητή</h1><div>${esc(m.name)}${m.code ? " · " + esc(m.code) : ""}</div></div>
        <div class="meta">Ημερομηνία: <b>${esc(date)}</b><br>${m.engineer ? `Μηχανικός: <b>${esc(m.engineer)}</b><br>` : ""}Ρευστό: <b>${esc(fp.label)} · ${esc(project.waterTemp)} °C</b></div></header>
      ${res.provisional ? `<div class="prov">ΠΡΟΣΩΡΙΝΟ — λείπουν στοιχεία. Ελλιπείς κλάδοι δεν περιλαμβάνονται στο H.</div>` : ""}
      <div class="kpis">
        <div class="kpi main"><div class="l">Μανομετρικό H</div><div class="v">${fmt(res.H, 2)} mwc</div><div class="s">${kp(res.H)} kPa</div></div>
        <div class="kpi"><div class="l">Παροχή σημείου λειτουργίας</div><div class="v">${fmt(res.Qd, 2)} m³/h</div><div class="s">${fmt(res.Qd / 3.6, 3)} l/s</div></div>
        <div class="kpi"><div class="l">Υδραυλική ισχύς</div><div class="v">${fmt(res.Ph, 0)} W</div><div class="s">ρ·g·Q·H</div></div>
        <div class="kpi"><div class="l">Ρευστό</div><div class="v" style="font-size:10pt">${esc(fp.label)}</div><div class="s">ν ${fmt(fp.nu * 1e6, 3)}e-6 · ρ ${fmt(fp.rho, 0)}${project.aged ? " · παλαιό δίκτυο" : ""}</div></div>
      </div>
      ${schemSec}
      <h2>Σχηματισμός H</h2>
      <table><thead><tr><th></th><th class="r">mwc</th><th class="r">kPa</th></tr></thead><tbody>${hRows}</tbody></table>
      ${net ? `<h2>Διαδρομές</h2>
      <table><thead><tr><th>Ως το τέλος του</th><th>Περιγραφή</th><th>Άθροισμα κλάδων</th><th class="r">ΔP [mwc]</th><th class="r">Στραγγαλισμός [kPa]</th><th class="r">Kv εξισ.</th></tr></thead><tbody>${circRows}</tbody></table>` : ""}
      <h2>Κλάδοι</h2>
      <table><thead><tr><th>Κλάδος</th><th>Περιγραφή</th><th>Σωλήνας</th><th class="r">L [m]</th><th class="r">Q [m³/h]</th><th class="r">v [m/s]</th><th class="r">R [Pa/m]</th><th class="r">ΔP [mwc]</th></tr></thead><tbody>${sumRows}</tbody></table>
      ${errBox}${warnBox}
      ${pumpSec}
      <h2 class="pb">Αναλυτικά ανά κλάδο</h2>
      ${detail}
      <h2>Παράρτημα — τύποι</h2>
      <table><thead><tr><th>Μέγεθος</th><th>Τύπος</th><th>Μον.</th><th>Σημείωση</th></tr></thead><tbody>${theory}</tbody></table>
      <p class="note">Τιμές ζ ενδεικτικές (±30%) — για βάνες και εξοπλισμό προτιμώνται Kv/ΔP από φύλλα κατασκευαστών. Ιδιότητες γλυκόλης: Melinder (IIR 2010). H σε m στήλης του ρευστού.</p>
      <footer class="rep"><span>PumpCalculator v${DB.VERSION}</span><span>${esc(m.name)}</span></footer>
      </body></html>`;

    const w = window.open("", "_blank");
    if (!w) { alert("Επίτρεψε τα αναδυόμενα παράθυρα για την αναφορά."); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { } }, 600);
  }

  function pipeDetailHtml(br, c, fp, extra) {
    const p = c.pipe, kp = h => fmt(toKPa(h, fp), 1);
    const fits = br.fittings.map((f, j) => {
      const r = c.fittings[j];
      return `<tr><td>${esc(f.type)}</td><td>${r.ownSize ? esc(f.size) : "—"}</td><td class="r num">${esc(f.qty)}</td>
        <td class="r num">${r.method === "ζ" ? esc(f.zeta) : "—"}</td><td class="r num">${r.method === "Kv" ? esc(f.kv) : "—"}</td>
        <td class="r num">${fmt(r.per)}</td><td class="r num">${fmt(r.total)}</td></tr>`;
    }).join("");
    const eqs = (br.equip || []).map((e, j) => `<tr><td>${esc(e.label || "Εξοπλισμός")}</td><td>—</td><td></td><td></td><td></td><td class="r num">${esc(e.dP)} ${esc(e.unit)}</td><td class="r num">${fmt(c.equip[j])}</td></tr>`).join("");
    const dbl = kindOf(br.kind).double;
    return `<div class="br">
      <div class="bh"><span class="badge">${esc(branchLabel(br))}</span><span class="bt">${esc(descOf(br))}</span>${c.complete ? "" : `<span class="ktag" style="background:#FDECEA;color:#B42318">ελλιπής: ${esc(c.missing.join(", "))}</span>`}</div>
      <div class="params">${esc(br.pipeFamily)} ${esc(br.pipeSize)} · D ${fmt(p.D_int, 2)} mm · k ${fmt(p.k, 3)} mm · L ${dbl ? `2×${esc(br.length)} = ` : ""}${fmt(p.Leff, 1)} m · Q ${fmt(c.Q, 2)} m³/h${c.Qsrc === "load" ? ` (${esc(br.loadKW)} kW)` : c.Qsrc === "auto" ? " (ισοζύγιο)" : ""}<br>v ${fmt(p.v, 3)} m/s · Re ${isFinite(p.Re) ? Math.round(p.Re) : "—"} (${esc(p.regime || "—")}) · λ ${fmt(p.lambda, 4)} · R ${fmt(p.R, 0)} Pa/m · ΔP σωλήνα ${fmt(p.dP)} m${extra || ""}</div>
      ${fits || eqs ? `<table><thead><tr><th>Εξάρτημα / εξοπλισμός</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th class="r">ΔP/τεμ [mwc]</th><th class="r">ΔP [mwc]</th></tr></thead><tbody>${fits}${eqs}</tbody></table>` : ""}
      ${c.ctrl ? `<div class="params">Βάνα ελέγχου: authority β = ${fmt(c.ctrl.auth, 2)}</div>` : ""}
      <p class="dpline">ΔP ${esc(branchLabel(br))} = <b>${fmt(c.dP)} mwc · ${kp(c.dP)} kPa</b></p>
    </div>`;
  }
  function openReportNet() {
    const res = calcProject(), val = validate(res);
    if (val.errors.length && !confirm(`Υπάρχουν ${val.errors.length} ελλείψεις. Το H είναι προσωρινό. Συνέχεια στην αναφορά;`)) return;
    const m = project.meta, fp = res.fp, g = res.g, kp = h => fmt(toKPa(h, fp), 1);
    const onW = new Set(res.worst && res.worst.complete ? res.worst.edges : []);
    const nm = id => esc(nodeLabel(g.nById.get(id)));
    const hRows = `<tr><td>Δυσμενέστερη διαδρομή${res.worstText ? " μέσω " + esc(res.worstText) : ""}</td><td class="r num">${fmt(res.worst ? res.worst.dP : 0)}</td><td class="r num">${kp(res.worst ? res.worst.dP : 0)}</td></tr>
      ${res.suction ? `<tr><td>Αναρρόφηση (πηγή → αντλία)</td><td class="r num">${fmt(res.suction.dP)}</td><td class="r num">${kp(res.suction.dP)}</td></tr>` : ""}
      <tr class="tot"><td>Σύνολο χωρίς προσαύξηση</td><td class="r num">${fmt(res.base)}</td><td class="r num">${kp(res.base)}</td></tr>
      <tr><td>Προσαύξηση ${fmt(res.margin * 100, 0)} %</td><td class="r num">${fmt(res.Hfric - res.base)}</td><td class="r num">${kp(res.Hfric - res.base)}</td></tr>
      ${res.open ? `<tr><td>Στατικό ύψος</td><td class="r num">${fmt(res.Hstatic)}</td><td class="r num">${kp(res.Hstatic)}</td></tr>` : ""}
      <tr class="H"><td>Μανομετρικό κυκλοφορητή H${res.provisional ? " (προσωρινό)" : ""}</td><td class="r num">${fmt(res.H)}</td><td class="r num">${kp(res.H)}</td></tr>`;
    const pathRows = res.paths.slice().sort((a, b) => (b.worst - a.worst) || (b.complete - a.complete) || (b.dP - a.dP)).map(pt => {
      const seq = pt.edges.map((id, i) => { const x = res.ecById.get(id); const nid = pt.nodes[i]; return (x.e.direct ? "" : esc(edgeLabel(x.e))) + (nid ? (x.e.direct ? "" : " → ") + nm(nid) : ""); }).filter(Boolean).join(" → ");
      return `<tr class="${pt.worst && pt.complete ? "wst" : ""} ${pt.complete ? "" : "inc"}"><td>${esc(res.via(pt) || "—")}</td><td class="mono" style="white-space:normal">${seq}${pt.toPump ? " → αντλία" : " → ανοιχτό άκρο"}</td>
        <td class="r num">${pt.complete ? fmt(pt.dP) : "—"}</td><td class="r num">${!pt.complete ? "ελλιπής" : pt.worst ? "δυσμενέστερη" : fmt(pt.excessKPa, 1)}</td><td class="r num">${pt.complete && !pt.worst ? fmt(pt.kvReq, 2) : "—"}</td></tr>`;
    }).join("");
    const pipeRows = res.edges.filter(x => !x.e.direct).map(x => {
      const p = x.c.pipe;
      return `<tr class="${x.c.complete ? "" : "inc"}"><td class="code">${esc(edgeLabel(x.e))}${onW.has(x.e.id) ? " ★" : ""}</td><td>${esc(descOf(x.e))}</td><td>${nm(x.e.from)} → ${nm(x.e.to)}</td><td>${esc(x.e.pipeFamily)} ${esc(x.e.pipeSize)}</td>
        <td class="r num">${fmt(p.Leff, 1)}</td><td class="r num">${fmt(x.c.Q, 2)}</td><td class="r num">${fmt(p.v, 2)}</td><td class="r num">${fmt(p.R, 0)}</td><td class="r num">${x.c.complete ? fmt(x.c.dP) : "ελλιπής"}</td></tr>`;
    }).join("");
    const eqRows = res.nodes.filter(x => x.n.type !== "junction").map(x => `<tr class="${x.complete ? "" : "inc"}"><td><b>${esc(nodeLabel(x.n))}</b></td><td>${esc(nodeType(x.n.type).label)}</td>
      <td class="r num">${fmt(x.sIn, 2)}</td><td class="r num">${x.n.type === PUMP ? "—" : x.m > 0 ? fmt(toKPa(x.m, fp), 1) : "0"}</td><td class="r num">${x.n.type === PUMP ? "—" : fmt(x.m)}</td><td>${x.openEnd ? "ανοιχτό άκρο" : ""}</td></tr>`).join("");
    const errBox = val.errors.length ? `<div class="errbox"><b>Ελλείψεις</b><ul>${val.errors.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const warnBox = val.warns.length ? `<div class="warnbox"><b>Παρατηρήσεις</b><ul>${val.warns.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const op = res.pump.op;
    const pumpSec = res.Qd > 0 && res.base > 0 ? `<h2>Καμπύλη δικτύου${res.pump.fit ? " και αντλίας" : ""}</h2><div class="cols"><div>${pumpChart(res)}</div><div><table><tbody>
      <tr><td>Σχεδιασμός</td><td class="r num">${fmt(res.Qd, 2)} m³/h · ${fmt(res.H, 2)} mwc</td></tr>
      ${op ? `<tr><td>Σημείο λειτουργίας</td><td class="r num">${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} mwc</td></tr><tr><td>Υδραυλική ισχύς</td><td class="r num">${fmt(op.Ph, 0)} W</td></tr><tr><td>Ισχύς άξονα</td><td class="r num">${isFinite(op.Pshaft) ? fmt(op.Pshaft, 0) + " W" : "—"}</td></tr>`
        : `<tr><td>Υδραυλική ισχύς (σχεδιασμός)</td><td class="r num">${fmt(res.Ph, 0)} W</td></tr>`}</tbody></table></div></div>` : "";
    const detail = res.edges.filter(x => !x.e.direct).map(x => pipeDetailHtml(x.e, x.c, fp, ` · ${nm(x.e.from)} → ${nm(x.e.to)}`)).join("");
    const theory = DB.THEORY.map(t => `<tr><td>${esc(t[0])}</td><td><code>${esc(t[1])}</code></td><td>${esc(t[2])}</td><td>${esc(t[3])}</td></tr>`).join("");
    const date = m.date ? new Date(m.date).toLocaleDateString("el-GR") : "";
    const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Αναφορά κυκλοφορητή — ${esc(m.name)}</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>${REPORT_CSS}</style></head><body>
      <header class="rep"><div><h1>Υπολογισμός μανομετρικού κυκλοφορητή</h1><div>${esc(m.name)}${m.code ? " · " + esc(m.code) : ""}</div></div>
        <div class="meta">Ημερομηνία: <b>${esc(date)}</b><br>${m.engineer ? `Μηχανικός: <b>${esc(m.engineer)}</b><br>` : ""}Ρευστό: <b>${esc(fp.label)} · ${esc(project.waterTemp)} °C</b><br>${res.open ? "Ανοιχτό" : "Κλειστό"} κύκλωμα</div></header>
      ${res.provisional ? `<div class="prov">ΠΡΟΣΩΡΙΝΟ — λείπουν στοιχεία ή υπάρχουν σφάλματα. Ελλιπείς διαδρομές δεν περιλαμβάνονται στο H.</div>` : ""}
      <div class="kpis">
        <div class="kpi main"><div class="l">Μανομετρικό H</div><div class="v">${fmt(res.H, 2)} mwc</div><div class="s">${kp(res.H)} kPa</div></div>
        <div class="kpi"><div class="l">Παροχή αντλίας</div><div class="v">${fmt(res.Qd, 2)} m³/h</div><div class="s">${fmt(res.Qd / 3.6, 3)} l/s</div></div>
        <div class="kpi"><div class="l">Υδραυλική ισχύς</div><div class="v">${fmt(res.Ph, 0)} W</div><div class="s">ρ·g·Q·H</div></div>
        <div class="kpi"><div class="l">Ρευστό</div><div class="v" style="font-size:10pt">${esc(fp.label)}</div><div class="s">ν ${fmt(fp.nu * 1e6, 3)}e-6 · ρ ${fmt(fp.rho, 0)}${project.aged ? " · παλαιό δίκτυο" : ""}</div></div>
      </div>
      <h2>Σχέδιο δικτύου</h2>${schematicNet(res, false, 680).svg}
      <h2>Σχηματισμός H</h2><table><thead><tr><th></th><th class="r">mwc</th><th class="r">kPa</th></tr></thead><tbody>${hRows}</tbody></table>
      <h2>Διαδρομές</h2><table><thead><tr><th>Μέσω</th><th>Διαδρομή</th><th class="r">ΔP [mwc]</th><th class="r">Στραγγαλισμός [kPa]</th><th class="r">Kv εξισ.</th></tr></thead><tbody>${pathRows}</tbody></table>
      <h2>Εξοπλισμός</h2><table><thead><tr><th>Όνομα</th><th>Τύπος</th><th class="r">Q [m³/h]</th><th class="r">ΔP [kPa]</th><th class="r">ΔP [mwc]</th><th></th></tr></thead><tbody>${eqRows}</tbody></table>
      <h2>Σωλήνες</h2><table><thead><tr><th>Κωδ.</th><th>Περιγραφή</th><th>Από → προς</th><th>Σωλήνας</th><th class="r">L [m]</th><th class="r">Q [m³/h]</th><th class="r">v [m/s]</th><th class="r">R [Pa/m]</th><th class="r">ΔP [mwc]</th></tr></thead><tbody>${pipeRows}</tbody></table>
      ${errBox}${warnBox}${pumpSec}
      <h2 class="pb">Αναλυτικά ανά σωλήνα</h2>${detail}
      <h2>Παράρτημα — τύποι</h2><table><thead><tr><th>Μέγεθος</th><th>Τύπος</th><th>Μον.</th><th>Σημείωση</th></tr></thead><tbody>${theory}</tbody></table>
      <p class="note">Τιμές ζ ενδεικτικές (±30%) — για βάνες και εξοπλισμό προτιμώνται Kv/ΔP από φύλλα κατασκευαστών. Ιδιότητες γλυκόλης: Melinder (IIR 2010). H σε m στήλης του ρευστού. Οι μη δυσμενείς διαδρομές θεωρούνται εξισορροπημένες στην ίδια ΔP.</p>
      <footer class="rep"><span>PumpCalculator v${DB.VERSION}</span><span>${esc(m.name)}</span></footer></body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert("Επίτρεψε τα αναδυόμενα παράθυρα για την αναφορά."); return; }
    w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) { } }, 600);
  }

  /* ---------------- Δεξιά στήλη που ακολουθεί το scroll ---------------- */
  function initStickySide() {
    const side = $("#side");
    if (!side || !window.matchMedia) return;
    let top = 16, lastY = window.scrollY;
    const wide = () => window.matchMedia("(min-width: 1120px)").matches;
    const apply = () => {
      if (!wide()) { side.style.top = ""; return; }
      const minTop = Math.min(16, window.innerHeight - side.offsetHeight - 16);
      const y = window.scrollY, dy = y - lastY;
      lastY = y;
      top = Math.max(minTop, Math.min(16, top - dy));
      side.style.top = top + "px";
    };
    window.addEventListener("scroll", apply, { passive: true });
    window.addEventListener("resize", apply);
    if (window.ResizeObserver) new ResizeObserver(apply).observe(side);
    apply();
  }

  /* ---------------- TEST HOOK (δεν επηρεάζει τη χρήση) ---------------- */
  window.PumpEngine = {
    nuWater, interp, fluidProps, lookupPipe, calcPipe, calcFitting, calcBranch,
    calcProject, validate, friction, qOf, fitPump, opPoint, normalize, vMaxFor, toKPa, toM, nextCode,
    setMode, treeOf, schematicNet, parseProjectText, calcNetwork, treeToGraph, chainToGraph, graphOf,
    delNode, delEdge, insertOnEdge, netAdd, undo,
    setProject(p) { project = p; },
    getProject() { return project; }
  };

  /* ---------------- INIT ---------------- */
  function init() {
    load();
    loadFromHash();
    normalize(project);
    $("#fileInput").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
    render();
    initStickySide();
    let rt = null;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (project.mode === "network") liveRecalc(); }, 150); });
  }
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("DOMContentLoaded", init);
})();
