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
  const LS_KEY = "pumpcalc.project.v1";

  function blankProject() {
    return {
      v: 3, mode: "simple",
      meta: { name: "Νέο έργο", code: "", engineer: "", date: new Date().toISOString().slice(0, 10), notes: "" },
      fluid: D.fluid, concPct: D.concPct, waterTemp: D.waterTemp, marginPct: D.marginPct, dT: D.dT,
      aged: false, openCircuit: false, staticHead: "",
      start: { type: DB.START_TYPES[0], label: "", dP: "", unit: "kPa" },
      extras: [], branches: [],
      pump: { points: [{ Q: "", H: "" }, { Q: "", H: "" }, { Q: "", H: "" }], eta: "" }
    };
  }
  function nextCode() {
    let n = 0;
    project.branches.forEach(b => { const m = /^L(\d+)/i.exec(b.code || ""); if (m) n = Math.max(n, +m[1]); });
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
      errors.push(c.Qsrc === "auto" ? `${nm}: λείπει η παροχή Q — βγαίνει από τους κλάδους μετά, που δεν έχουν όλοι Q.` : `${nm}: λείπει η παροχή Q.`);
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
    if (project.branches.length === 0) errors.push("Δεν υπάρχει κανένας κλάδος.");
    const fp = res.fp;
    if (fp.frozen) errors.push(`Ρευστό: ${fmt(fp.T, 0)} °C είναι κάτω από το σημείο πήξης (${fmt(fp.tFreeze, 1)} °C).`);
    else if (fp.approx) warns.push(`Ρευστό: κοντά στο σημείο πήξης (${fmt(fp.tFreeze, 1)} °C) — ιδιότητες κατά προσέγγιση.`);
    if (fp.clamped) warns.push("Ρευστό: θερμοκρασία ή συγκέντρωση εκτός πίνακα (−30…90 °C, 0…60%) — χρησιμοποιήθηκε το όριο.");
    if (res.tree && res.tree.cyclic.length) errors.push("Δίκτυο: κύκλος στις συνδέσεις κλάδων — έλεγξε το «Ξεκινά από».");
    const codes = {};
    project.branches.forEach(b => { const k = (b.code || "").trim(); if (k) codes[k] = (codes[k] || 0) + 1; });
    Object.keys(codes).forEach(k => { if (codes[k] > 1) warns.push(`Ο κωδικός ${k} χρησιμοποιείται ${codes[k]} φορές.`); });
    res.branches.forEach(({ br, c }) => { errors.push(...c.errors); warns.push(...branchWarns(br, c, res)); });
    if (String(project.start.dP).trim() !== "" && !isFinite(num(project.start.dP))) errors.push("Αρχή βρόχου: μη έγκυρη ΔP.");
    project.extras.forEach((e, i) => { if (!isFinite(num(e.dP))) errors.push(`Κοινός εξοπλισμός #${i + 1} (${e.label || "χωρίς περιγραφή"}): λείπει η ΔP.`); });
    const op = res.pump && res.pump.op;
    if (res.pump && res.pump.fit && !op) warns.push("Αντλία: η καμπύλη δεν τέμνει την καμπύλη δικτύου.");
    if (op && op.Q < res.Qd * (1 - D.qBalTol)) warns.push(`Αντλία: στο σημείο λειτουργίας δίνει ${fmt(op.Q, 2)} m³/h, λιγότερο από τα ${fmt(res.Qd, 2)} m³/h του σχεδιασμού.`);
    return { errors, warns };
  }

  /* Αλλαγή τρόπου. Σε απλή διαδρομή μόνο αν το δίκτυο είναι αλυσίδα·
     οι αυτόματες παροχές γράφονται ως τιμές ώστε να μην αλλάξει τίποτα. */
  function setMode(m) {
    if (m === project.mode) return { ok: true };
    if (m === "simple") {
      const res = calcProject();
      if (!isChainTree(res.tree)) return { ok: false, msg: "Το δίκτυο έχει διακλαδώσεις. Για απλή διαδρομή άφησε μόνο έναν κλάδο σε κάθε σημείο (σβήσε τους παράλληλους)." };
      res.branches.forEach(({ br, c }) => { if (c.Qsrc === "auto" && c.Q > 0) br.Q = +c.Q.toFixed(4); });
      project.branches = res.tree.order.map(id => res.tree.byId.get(id));
    }
    project.mode = m;
    return { ok: true };
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
  function layoutTree(tree) {
    const pos = new Map(); let r = 0, maxD = 0;
    const place = (id, d) => {
      maxD = Math.max(maxD, d);
      const ks = tree.kids.get(id);
      if (!ks.length) { pos.set(id, { d, row: r++ }); return; }
      ks.forEach(k => place(k, d + 1));
      pos.set(id, { d, row: pos.get(ks[0]).row });
    };
    tree.roots.forEach(id => place(id, 0));
    tree.cyclic.forEach(id => { if (!pos.has(id)) pos.set(id, { d: 0, row: r++ }); });
    return { pos, rows: Math.max(r, 1), maxD };
  }
  function schematic(res, interactive, availW) {
    const tree = res.tree, { pos, rows, maxD } = layoutTree(tree);
    const onWorst = new Set(res.worst && res.worst.complete ? res.worst.ids : []);
    const boxX = 8, boxW = 132, pumpX = boxX + boxW + 30, x0 = pumpX + 26, termW = 124;
    let segW = Math.floor((availW - x0 - termW - 36) / (maxD + 1));
    segW = Math.max(150, Math.min(230, segW));
    const rowH = 96, padT = 34;
    const W = Math.max(availW, x0 + segW * (maxD + 1) + termW + 36), Hh = padT + rows * rowH + 8;
    const yOf = row => padT + row * rowH + rowH / 2 - 8;
    const yStart = tree.roots.length ? yOf(pos.get(tree.roots[0]).row) : yOf(0);
    const out = [], pluses = [];
    const txt = (x, y, s, a = "") => `<text x="${x}" y="${y}" ${a}>${esc(s)}</text>`;
    const st = project.start;
    out.push(`<g class="startnode">
      <rect x="${boxX}" y="${yStart - 32}" width="${boxW}" height="64" rx="10" class="sbox"/>
      ${txt(boxX + boxW / 2, yStart - 13, "ΑΡΧΗ ΒΡΟΧΟΥ", 'class="t-cap" text-anchor="middle"')}
      ${txt(boxX + boxW / 2, yStart + 5, trunc(st.type, 18), 'class="t-strong" text-anchor="middle"')}
      ${txt(boxX + boxW / 2, yStart + 21, trunc(st.label || (res.startM > 0 ? "ΔP " + fmt(res.startM) + " m" : ""), 20), 'class="t-small" text-anchor="middle"')}
    </g>`);
    out.push(`<line x1="${boxX + boxW}" y1="${yStart}" x2="${pumpX - 13}" y2="${yStart}" class="ln-trunk"/>`);
    out.push(`<g class="pump"><title>Αντλία — σε κλειστό βρόχο η θέση της δεν αλλάζει το H</title><circle cx="${pumpX}" cy="${yStart}" r="13" class="pc"/><path d="M${pumpX - 5} ${yStart - 7} L${pumpX + 8} ${yStart} L${pumpX - 5} ${yStart + 7} Z" class="pt"/></g>`);
    out.push(`<line x1="${pumpX + 13}" y1="${yStart}" x2="${x0}" y2="${yStart}" class="ln-trunk"/>`);
    out.push(`<circle cx="${x0}" cy="${yStart}" r="5" class="junc"/>`);

    tree.order.forEach(id => {
      const p = pos.get(id); if (!p) return;
      const { br, c } = res.cById.get(id);
      const par = br.parent && pos.get(br.parent);
      const yP = par ? yOf(par.row) : yStart;
      const xs = x0 + p.d * segW, xe = xs + segW, y = yOf(p.row);
      const d = yP === y ? `M${xs} ${y} H${xe}` : `M${xs} ${yP} V${y} H${xe}`;
      const warn = c.complete && branchWarns(br, c, res).length > 0;
      const cls = !c.complete ? "ln-inc" : onWorst.has(id) ? "ln-worst" : "ln-norm";
      const sel = interactive && id === selId;
      const ks = tree.kids.get(id);
      const eq = (br.equip || []).filter(e => e.label || String(e.dP).trim() !== "");
      const lx = xs + 16, maxChars = Math.floor((segW - 30) / 6.6);
      const code = branchLabel(br), desc = (br.desc || "").trim() || `${br.pipeFamily} ${br.pipeSize}`;
      const statusIcon = !c.complete ? `<circle cx="${lx + 7}" cy="${y + 18}" r="6.5" class="si-inc"/>`
        : warn ? `<circle cx="${lx + 7}" cy="${y + 18}" r="7" class="si-warn"/><text x="${lx + 7}" y="${y + 21.5}" class="si-t" text-anchor="middle">!</text>`
        : `<circle cx="${lx + 7}" cy="${y + 18}" r="7" class="si-ok"/><path d="M${lx + 3.5} ${y + 18} l2.5 2.5 l4.5 -5" class="si-chk"/>`;
      const lower = c.complete ? `ΔP ${fmt(c.dP)} m` : `λείπει: ${c.missing.join(", ")}`;
      const third = c.Q > 0 ? `Q ${fmt(c.Q, 2)} m³/h` : "";
      out.push(`<g class="seg ${sel ? "sel" : ""}" ${interactive ? `data-act="pick" data-id="${esc(id)}" role="button" tabindex="0" aria-label="Κλάδος ${esc(code)} ${esc(desc)}"` : ""}>
        ${sel ? `<path d="${d}" class="ln-halo"/>` : ""}
        <path d="${d}" class="${cls}"/>
        ${interactive ? `<path d="${d}" class="ln-hit"/>` : ""}
        <text x="${lx}" y="${y - 12}" class="t-code">${esc(code)}<tspan class="t-desc" dx="6">${esc(trunc(desc, maxChars - code.length - 1))}</tspan></text>
        ${statusIcon}
        <text x="${lx + 19}" y="${y + 22}" class="${c.complete ? "t-num" : "t-miss"}">${esc(trunc(lower, maxChars - 2))}</text>
        ${third ? `<text x="${lx + 19}" y="${y + 37}" class="t-q">${esc(third)}</text>` : ""}
      </g>`);
      if (sel) out.push(`<g class="delb" data-act="del" data-id="${esc(id)}" role="button" tabindex="0" aria-label="Διαγραφή ${esc(code)}"><title>Διαγραφή ${esc(code)}</title><circle cx="${xe - 16}" cy="${y + 18}" r="9"/><path d="M${xe - 19.5} ${y + 14.5}l7 7M${xe - 12.5} ${y + 14.5}l-7 7"/></g>`);
      if (ks.length) out.push(`<circle cx="${xe}" cy="${y}" r="5" class="junc"/>`);
      let plusX = xe + 20, plusY = y;
      if (!ks.length) {
        if (eq.length) {
          const bw = termW - 24, cx = xe + 6 + bw / 2;
          out.push(`<g class="term"><rect x="${xe + 6}" y="${y - 17}" width="${bw}" height="34" rx="7" class="tbox"/>
            ${txt(cx, y - 2, trunc(eq[0].label || "Εξοπλισμός", 14) + (eq.length > 1 ? ` +${eq.length - 1}` : ""), 'class="t-small" text-anchor="middle"')}
            ${txt(cx, y + 12, isFinite(c.sumEquip) ? fmt(c.sumEquip, 2) + " m" : "", 'class="t-num" text-anchor="middle"')}</g>`);
          plusX = xe + termW - 4;
        } else out.push(`<circle cx="${xe}" cy="${y}" r="4" class="endcap"/>`);
      } else { plusX = xe; plusY = y - 26; }
      if (interactive) pluses.push(plusBtn(plusX, plusY, id, `Νέος κλάδος από το τέλος του ${code}`));
    });
    if (interactive) pluses.unshift(plusBtn(x0, yStart - 24, "__start", "Νέος κλάδος από την αρχή"));
    out.push(...pluses);
    return { svg: `<svg class="schem" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Σχηματικό δικτύου">${SCHEM_STYLE}${out.join("")}</svg>`, W, H: Hh };
  }
  function plusBtn(x, y, id, label) {
    return `<g class="plus" data-act="plus" data-id="${esc(id)}" data-x="${x}" data-y="${y}" role="button" tabindex="0" aria-label="${esc(label)}"><circle cx="${x}" cy="${y}" r="11"/><path d="M${x - 5} ${y}h10M${x} ${y - 5}v10"/></g>`;
  }

  /* ---------------- RENDER: βοηθητικά ---------------- */
  const CHECK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
  function descOf(br) { return (br.desc || "").trim() || `${br.pipeFamily} ${br.pipeSize}`; }
  function field(label, inner, cls = "") { return `<div class="fld ${cls}"><label>${label}</label>${inner}</div>`; }
  function unitSel(attr, i, unit) {
    return `<select ${attr}="${i}" data-k="unit" aria-label="Μονάδα">${["kPa", "m"].map(u => `<option ${u === unit ? "selected" : ""}>${u}</option>`).join("")}</select>`;
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
    const cNet = `
      <section class="card" id="c-net">
        <div class="card-h">
          <h2>${net ? "Δίκτυο" : "Διαδρομή"}</h2>
          <div class="segctl" role="group" aria-label="Τρόπος υπολογισμού">
            <button class="${net ? "" : "on"}" data-act="mode" data-mode="simple" aria-pressed="${!net}">Απλή διαδρομή</button>
            <button class="${net ? "on" : ""}" data-act="mode" data-mode="network" aria-pressed="${net}">Δίκτυο με διακλαδώσεις</button>
          </div>
        </div>
        <p class="lead">${net
          ? "Ο βρόχος της αντλίας που υπολογίζεις. Πάτα έναν κλάδο για να τον συμπληρώσεις. Το <b>+</b> είναι σημείο του δικτύου: νέος κλάδος ξεκινά από εκεί — αν από το ίδιο σημείο ξεκινά ήδη κλάδος, ο νέος είναι παράλληλος. Ο επιλεγμένος κλάδος σβήνεται με το <b class='x'>✕</b>. Σε κλειστό βρόχο η θέση της αντλίας δεν αλλάζει το H."
          : "Κλάδοι σε σειρά, από την αρχή του βρόχου ως το δυσμενέστερο τερματικό. Όλοι αθροίζονται. Για παράλληλους κλάδους διάλεξε «Δίκτυο με διακλαδώσεις»."}</p>
        <div class="startrow">
          ${field("Αρχή βρόχου", `<select data-start="type">${startOpts}</select>`)}
          ${field("Περιγραφή", `<input type="text" data-start="label" value="${esc(st.label)}" placeholder="π.χ. μετά τον διαχωριστή">`)}
          ${field("ΔP αρχής", `<input type="number" id="startDP" data-start="dP" value="${esc(st.dP)}" step="0.1" placeholder="0">`)}
          ${field("Μονάδα", `<select data-start="unit">${["kPa", "m"].map(u => `<option ${u === st.unit ? "selected" : ""}>${u}</option>`).join("")}</select>`)}
        </div>
        <p class="desc">ΔP της αρχής όταν ο βρόχος περνά μέσα από αυτήν (π.χ. εξατμιστής ψύκτη, εναλλάκτης). Buffer, διαχωριστής, συλλέκτης: άφησέ το κενό. Buffer ή διαχωριστής στη μέση του δικτύου σημαίνει τέλος του βρόχου αυτής της αντλίας — ό,τι ακολουθεί είναι άλλος υπολογισμός.</p>
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

    const cPaths = net ? `
      <section class="card" id="c-paths">
        <div class="card-h"><h2>Διαδρομές — τι αθροίζεται</h2></div>
        <div id="paths"></div>
      </section>` : "";

    const cBranch = renderBranchCard(res);

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
            <table class="table"><thead><tr><th></th><th>Q [m³/h]</th><th>H [m]</th><th></th></tr></thead><tbody>${pts}</tbody></table>
            ${project.pump.points.length < 5 ? `<button class="add" data-act="pp-add">+ Σημείο</button>` : ""}
            ${field("Βαθμός απόδοσης η [%]", `<input type="number" data-pump="eta" value="${esc(project.pump.eta)}" min="1" max="100" step="1">`)}
          </div>
          <div id="pumpOut"></div>
        </div>
      </details>`;

    $("#flowMain").innerHTML = cProj + cNet + cPaths + cBranch + cExtras + cCurve;
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
    const ks = res.tree.kids.get(br.id) || [];
    const autoQ = net && ks.length > 0;
    const dbl = kindOf(br.kind).double;

    let parentSel = "";
    if (net) {
      const desc = descendants(br.id, res.tree);
      const opts = `<option value="">την αρχή του βρόχου</option>` + res.tree.order
        .filter(id => id !== br.id && !desc.has(id))
        .map(id => { const b = res.tree.byId.get(id); return `<option value="${id}" ${br.parent === id ? "selected" : ""}>το τέλος του ${esc(branchLabel(b))} · ${esc(descOf(b))}</option>`; }).join("");
      parentSel = field("Ξεκινά από", `<select data-br="parent">${opts}</select>`);
    }

    const fitRows = br.fittings.map((f, i) => {
      const sizeSel = `<select data-fit="${i}" data-k="size" aria-label="Διατομή"><option value="">= σωλήνα</option>${fam.sizes.map(s => `<option ${s[0] === f.size && f.size !== br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("")}</select>`;
      return `<tr data-fi="${i}">
        <td class="c-type"><select data-fit="${i}" data-k="type" aria-label="Είδος">${fittingSelectHTML(f.type)}</select></td>
        <td class="c-size">${sizeSel}</td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="qty" value="${esc(f.qty)}" min="0" step="1" aria-label="Τεμάχια"></td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="zeta" value="${esc(f.zeta)}" step="0.05" placeholder="ζ" aria-label="ζ"></td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="kv" value="${esc(f.kv)}" step="0.1" placeholder="Kv" aria-label="Kv"></td>
        <td class="meth"></td>
        <td class="out r tot"></td>
        <td><button class="icon" data-act="fit-del" data-i="${i}" aria-label="Διαγραφή">✕</button></td>
      </tr>`;
    }).join("");

    const eqRows = (br.equip || []).map((e, i) => `
      <div class="eqrow">
        <input type="text" data-eq="${i}" data-k="label" placeholder="π.χ. Στοιχείο FCU" value="${esc(e.label)}" aria-label="Περιγραφή">
        <input type="number" data-eq="${i}" data-k="dP" step="0.1" value="${esc(e.dP)}" aria-label="ΔP" placeholder="ΔP">
        ${unitSel("data-eq", i, e.unit)}
        <button class="icon" data-act="eq-del" data-i="${i}" aria-label="Διαγραφή">✕</button>
      </div>`).join("");

    const A = sub("Α", net ? "Όνομα και θέση στο δίκτυο" : "Όνομα", "subA", `
      <div class="grid ${net ? "g-a-net" : "g-a"}">
        ${field("Κωδικός", `<input type="text" class="mono" data-br="code" value="${esc(br.code)}">`)}
        ${field("Περιγραφή", `<input type="text" data-br="desc" value="${esc(br.desc)}" placeholder="${esc(br.pipeFamily + " " + br.pipeSize)}">`)}
        ${parentSel}
      </div>
      <p class="desc" id="parInfo"></p>`);
    const B = sub("Β", "Παροχή", "subQ", `
      <div class="grid g3">
        ${field("Q [m³/h]", `<input type="number" data-br="Q" value="${esc(byLoad ? "" : br.Q)}" step="0.01" ${byLoad ? "disabled" : ""} placeholder="${byLoad ? "από φορτίο" : autoQ ? "αυτόματα" : ""}">`)}
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
        <thead><tr><th>Είδος</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th>Με</th><th class="r">ΔP [m]</th><th></th></tr></thead>
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
          <button class="ghost small danger" data-act="del" data-id="${esc(br.id)}">Διαγραφή</button>
        </div>
        ${A}${B}${C}${Dd}${E}
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

    if (net) renderSchematic(res); else renderChain(res);
    const pth = $("#paths"); if (pth) pth.innerHTML = pathsTable(res);
    const ex = $("#exTot"); if (ex) ex.textContent = project.extras.length ? fmt(res.sumExtras - res.startM) + " m" : "";

    const entry = res.cById.get(selId);
    if (entry && $("#sec-branch")) renderBranchOutputs(entry, res);

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
          <small>${x.c.complete ? fmt(x.c.dP) + " m" : "λείπει: " + esc(x.c.missing.join(", "))}</small></span>
        </button>`;
    }).join("");
    el.innerHTML = `<span class="cstart">Αρχή · ${esc(st.type)}${st.label ? ": " + esc(trunc(st.label, 22)) : ""}</span>${items}
      <span class="arr" aria-hidden="true">→</span><button class="add" data-act="add-end">+ Κλάδος</button>`;
  }

  function renderSchematic(res) {
    const host = $("#schem"), wrap = $("#schemWrap"); if (!host || !wrap) return;
    const avail = Math.max(640, wrap.clientWidth - 2);
    host.innerHTML = schematic(res, true, avail).svg;
    renderPop(res);
  }
  function renderPop(res) {
    const el = $("#pop"); if (!el) return;
    if (!pop || (pop.id !== "__start" && !res.cById.has(pop.id))) { el.hidden = true; el.innerHTML = ""; return; }
    let html;
    const lbls = ids => ids.map(id => esc(branchLabel(res.tree.byId.get(id)))).join(", ");
    if (pop.id === "__start") {
      const rs = res.tree.roots;
      html = `<div class="pop-h">Αρχή βρόχου</div>
        <button data-act="add-root"><b>Νέος κλάδος από εδώ</b><small>${rs.length ? `παράλληλος με ${lbls(rs)}` : "πρώτος κλάδος του βρόχου"}</small></button>
        <button data-act="start-eq"><b>ΔP της αρχής</b><small>${esc(project.start.type)} — αν ο βρόχος περνά από μέσα</small></button>`;
    } else {
      const b = res.cById.get(pop.id).br, c = esc(branchLabel(b)), ks = res.tree.kids.get(b.id) || [];
      html = `<div class="pop-h">Τέλος του ${c}</div>
        <button data-act="add-after" data-id="${esc(b.id)}"><b>Νέος κλάδος από εδώ</b><small>${ks.length ? `παράλληλος με ${lbls(ks)} (ξεκινούν από το ίδιο σημείο)` : `συνέχεια του ${c}`}</small></button>
        <button data-act="add-eq" data-id="${esc(b.id)}"><b>Εξοπλισμός στο τέλος του ${c}</b><small>FCU, στοιχείο, εναλλάκτης — σε σειρά με τον ${c}</small></button>`;
    }
    el.innerHTML = html;
    const wrap = $("#schemWrap"), outer = $("#schemOuter");
    const sx = wrap ? wrap.scrollLeft : 0, ow = outer ? outer.clientWidth : 1000, pw = 290;
    let left = pop.x + 18 - sx;
    if (left + pw > ow) left = Math.max(4, pop.x - sx - pw - 18);   // χωρά μόνο αριστερά από το «+»
    el.style.left = left + "px";
    el.style.top = Math.max(4, pop.y - 16) + "px";
    el.hidden = false;
  }

  function pathsTable(res) {
    if (!res.circuits.length) return `<p class="desc">Κανένας κλάδος ακόμα.</p>`;
    const rows = res.circuits.slice().sort((a, b) => (b.worst - a.worst) || (b.complete - a.complete) || (b.dP - a.dP)).map(ci => {
      const leaf = res.cById.get(ci.leaf).br;
      const parts = ci.ids.map(id => { const x = res.cById.get(id); return `${esc(branchLabel(x.br))} ${x.c.complete ? fmt(x.c.dP) : "<span class='errTxt'>—</span>"}`; }).join(" + ");
      const incIds = ci.ids.filter(id => !res.cById.get(id).c.complete).map(id => branchLabel(res.cById.get(id).br));
      const outc = !ci.complete ? `<span class="errTxt">Ελλιπής — εκτός υπολογισμού (${esc(incIds.join(", "))})</span>`
        : ci.worst ? `<b class="acc">Δυσμενέστερη — δίνει το H</b>`
        : isFinite(ci.excessKPa) ? `Στραγγαλισμός ${fmt(ci.excessKPa, 1)} kPa${isFinite(ci.kvReq) ? ` · βάνα Kv ≈ ${fmt(ci.kvReq, 2)}` : ""}` : "—";
      return `<tr class="${ci.worst && ci.complete ? "worst" : ""} ${ci.complete ? "" : "inc"}" data-act="pick" data-id="${esc(ci.leaf)}">
        <td><b class="mono">${esc(branchLabel(leaf))}</b> ${esc(trunc(descOf(leaf), 28))}</td>
        <td class="mono sum">${parts}</td>
        <td class="r mono"><b>${ci.complete ? fmt(ci.dP) + " m" : "—"}</b></td>
        <td>${outc}</td></tr>`;
    }).join("");
    const common = res.sumExtras > 0 ? `<p class="desc">Σε κάθε διαδρομή προστίθενται μία φορά η αρχή και ο κοινός εξοπλισμός: <b class="num">${fmt(res.sumExtras)} m</b>.</p>` : "";
    return `<div class="tablewrap"><table class="table paths"><thead><tr><th>Ως το τέλος του</th><th>Άθροισμα κλάδων [m]</th><th class="r">ΔP</th><th>Αποτέλεσμα</th></tr></thead><tbody>${rows}</tbody></table></div>${common}`;
  }

  function renderBranchOutputs(entry, res) {
    const { br, c } = entry, p = c.pipe, fp = res.fp, net = project.mode === "network";
    const warns = branchWarns(br, c, res);
    $("#brTitle").innerHTML = `Κλάδος <span class="mono">${esc(branchLabel(br))}</span> <span class="brt-desc">· ${esc(descOf(br))}</span>`;
    const chip = $("#brChip");
    chip.className = "chip " + (!c.complete ? "c-inc" : warns.length ? "c-warn" : "c-ok");
    chip.textContent = !c.complete ? "Λείπει: " + c.missing.join(", ") : warns.length ? `Πλήρης · ${warns.length} παρατηρ.` : "Πλήρης";
    const pi = $("#parInfo");
    if (pi) {
      if (net) {
        const sib = (br.parent ? res.tree.kids.get(br.parent) : res.tree.roots).filter(id => id !== br.id).map(id => branchLabel(res.tree.byId.get(id)));
        const ks = (res.tree.kids.get(br.id) || []).map(id => branchLabel(res.tree.byId.get(id)));
        pi.innerHTML = [sib.length ? `Παράλληλος με: <b>${esc(sib.join(", "))}</b>` : "", ks.length ? `Συνεχίζουν μετά: <b>${esc(ks.join(", "))}</b>` : "Τέλος διαδρομής"].filter(Boolean).join(" · ");
      } else pi.innerHTML = "";
    }
    $("#subQ").textContent = c.Q > 0 ? fmt(c.Q, 2) + " m³/h" : "—";
    const qi = [];
    if (c.Qsrc === "load") qi.push(`Από φορτίο: Q = 3600·P/(ρ·cp·ΔT) = <b class="num">${fmt(c.Q, 3)} m³/h</b> (ΔT ${esc(project.dT)} K)`);
    if (c.Qsrc === "auto") qi.push(c.Q > 0 ? `Αυτόματα: άθροισμα των κλάδων μετά = <b class="num">${fmt(c.Q, 2)} m³/h</b>. Γράψε τιμή μόνο αν υπάρχουν καταναλωτές που δεν σχεδίασες.` : "Αυτόματα από τους κλάδους μετά — δεν έχουν όλοι παροχή ακόμα.");
    if (net && c.Qsrc === "manual" && (res.tree.kids.get(br.id) || []).length) qi.push("Χειροκίνητη τιμή (σβήσ' την για αυτόματο άθροισμα των κλάδων μετά).");
    $("#qInfo").innerHTML = qi.join(" ");
    $("#subPipe").textContent = isFinite(p.dP) ? fmt(p.dP) + " m" : "—";
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
    $("#subFit").textContent = br.fittings.length ? fmt(c.sumFit) + " m" : "";
    $("#authInfo").innerHTML = c.ctrl ? `Βάνα ελέγχου: ΔP <b class="num">${fmt(toKPa(c.ctrl.dPv, fp), 1)} kPa</b> · authority β = <b class="num ${c.ctrl.auth < D.authMin ? "warnTxt" : "ok"}">${fmt(c.ctrl.auth, 2)}</b> (στόχος ≥ ${D.authMin})` : "";
    $("#subEq").textContent = (br.equip || []).length ? fmt(c.sumEquip) + " m" : "";
    $("#brTotLbl").textContent = `ΔP κλάδου ${branchLabel(br)}`;
    $("#brTot").textContent = `${fmt(c.dP)} m · ${fmt(toKPa(c.dP, fp), 1)} kPa`;
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
    const worstLeaf = res.worst ? res.cById.get(res.worst.leaf) : null;
    const rows = [[`Δυσμενέστερη διαδρομή${worstLeaf ? " → " + esc(branchLabel(worstLeaf.br)) : ""}`, fmt(res.sumBranches) + " m"]];
    if (res.startM > 0) rows.push([`Αρχή βρόχου (${esc(project.start.type)})`, fmt(res.startM) + " m"]);
    if (project.extras.length) rows.push(["Κοινός εξοπλισμός", fmt(res.sumExtras - res.startM) + " m"]);
    rows.push([`Προσαύξηση ${fmt(res.margin * 100, 0)} %`, fmt(res.Hfric - res.base) + " m"]);
    if (project.openCircuit) rows.push(["Στατικό ύψος", fmt(res.Hstatic, 2) + " m"]);
    rows.push(["Υδραυλική ισχύς", isFinite(res.Ph) ? fmt(res.Ph, 0) + " W" : "—"]);

    const miss = val.errors.length ? `<div class="mini"><h3>Τι λείπει</h3><ul class="lst err">${val.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    const obs = val.warns.length ? `<div class="mini"><h3>Παρατηρήσεις</h3><ul class="lst warn">${val.warns.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "";
    const good = !val.errors.length && !val.warns.length ? `<div class="mini"><div class="good">Όλα συμπληρωμένα, χωρίς παρατηρήσεις.</div></div>` : "";
    $("#side").innerHTML = `
      <div class="mini" id="result">
        <h3>Αποτέλεσμα</h3>
        <div class="kpi-main ${res.provisional ? "prov" : ""}">
          <span>Μανομετρικό κυκλοφορητή ${res.provisional ? `<em class="pbadge">προσωρινό</em>` : ""}</span>
          <b>${res.H > 0 ? fmt(res.H, 2) + " m" : "—"}</b>
          <span class="kpi-sub">${fmt(toKPa(res.H, fp), 1)} kPa · Q = ${fmt(res.Qd, 2)} m³/h</span>
        </div>
        ${res.provisional ? `<p class="provnote">Λείπουν στοιχεία (δες «Τι λείπει»). Ελλιπείς κλάδοι δεν μετράνε ακόμα — το H μπορεί να αυξηθεί.</p>` : ""}
        ${rows.map(([a, b]) => `<div class="rowline"><span>${a}</span><span>${b}</span></div>`).join("")}
      </div>
      ${miss}${obs}${good}
      <div class="mini actions">
        <button class="primary" data-act="report">Αναφορά PDF</button>
        <button data-act="save">Αποθήκευση .json</button>
        <button data-act="load">Φόρτωση .json</button>
        <button class="danger" data-act="new">Νέο έργο</button>
      </div>
      <details class="mini"><summary>Τύποι υπολογισμού</summary><div class="formulas">${DB.THEORY.map(t => `<div><b>${esc(t[0])}</b><br><code>${esc(t[1])}</code>${t[3] ? `<br><span class="muted">${esc(t[3])}</span>` : ""}</div>`).join("")}</div></details>`;
  }

  function renderMbar(res) {
    const mb = $("#mbar"); if (!mb) return;
    mb.innerHTML = `<div><small>Μανομετρικό${res.provisional ? " · προσωρινό" : ""}</small><b>${res.H > 0 ? fmt(res.H, 2) + " m" : "—"}</b><small>Q ${fmt(res.Qd, 2)} m³/h</small></div><button data-act="to-side">Ανάλυση ↓</button>`;
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
      <text x="${L + 6}" y="${T + 10}">H [m]</text>
    </svg>
    <div class="legend"><span><i class="l-sys"></i>Δίκτυο</span>${fit ? `<span><i class="l-pmp"></i>Αντλία</span>` : ""}<span><i class="l-des"></i>Σχεδιασμός</span>${op ? `<span><i class="l-op"></i>Σημείο λειτουργίας</span>` : ""}</div>`;
  }
  function pumpBlock(res) {
    const op = res.pump.op;
    let txt = "";
    if (!res.pump.fit) txt = `<p class="desc">Χωρίς σημεία αντλίας φαίνεται μόνο η καμπύλη του δικτύου και το σημείο σχεδιασμού.</p>`;
    else if (!op) txt = `<div class="warnbox">Η καμπύλη της αντλίας δεν τέμνει την καμπύλη του δικτύου.</div>`;
    else txt = `<div class="rowline"><span>Σημείο λειτουργίας</span><span>${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} m</span></div>
      <div class="rowline"><span>Απόκλιση από σχεδιασμό</span><span>${op.Q >= res.Qd ? "+" : ""}${fmt(100 * (op.Q / res.Qd - 1), 1)} %</span></div>
      <div class="rowline"><span>Υδραυλική ισχύς</span><span>${fmt(op.Ph, 0)} W</span></div>
      <div class="rowline"><span>Ισχύς άξονα</span><span>${isFinite(op.Pshaft) ? fmt(op.Pshaft, 0) + " W" : "δώσε η"}</span></div>`;
    return pumpChart(res) + txt;
  }

  /* ---------------- FULL RENDER ---------------- */
  function render() {
    const res = calcProject();
    if (selId && !res.cById.has(selId)) selId = null;
    if (!selId && res.tree.order.length) selId = res.tree.order[0];
    renderMain(res);
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
  function curBranch() { return project.branches.find(b => b.id === selId); }
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
    if (ds.br) {
      const br = curBranch(); if (!br) return;
      if (ds.br === "parent") br.parent = t.value || null;
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
    if (pop && !e.target.closest("#pop") && !(t && t.dataset.act === "plus")) { pop = null; const p = $("#pop"); if (p) { p.hidden = true; p.innerHTML = ""; } }
    if (!t) return;
    const a = t.dataset.act, id = t.dataset.id;
    if (a === "mode") {
      const r = setMode(t.dataset.mode);
      if (!r.ok) { alert(r.msg); return; }
      pop = null; render(); return;
    }
    if (a === "pick") { selId = id; pop = null; render(); scrollToEl("#sec-branch"); return; }
    if (a === "plus") {
      pop = pop && pop.id === id ? null : { id, x: +t.dataset.x, y: +t.dataset.y };
      renderPop(calcProject()); return;
    }
    if (a === "add-after") { addBranch(id, project.branches.find(b => b.id === id)); return; }
    if (a === "add-root") { addBranch(null, project.branches[0]); return; }
    if (a === "add-end") { const last = project.branches[project.branches.length - 1]; addBranch(last ? last.id : null, last); return; }
    if (a === "add-eq") {
      const b = project.branches.find(x => x.id === id); if (!b) return;
      b.equip.push({ label: "", dP: "", unit: "kPa" }); selId = id; pop = null;
      render(); scrollToEl("#sec-branch");
      const ins = $$("#sec-branch [data-eq][data-k='label']"); if (ins.length) ins[ins.length - 1].focus({ preventScroll: true });
      return;
    }
    if (a === "start-eq") { pop = null; renderPop(calcProject()); const s = $("#startDP"); if (s) s.focus(); return; }
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
    if (a === "load") { $("#fileInput").click(); return; }
    if (a === "to-side") { const s = $("#side"); if (s) s.scrollIntoView({ behavior: "smooth" }); return; }
    if (a === "new") { if (confirm("Νέο έργο; Τα μη αποθηκευμένα δεδομένα θα χαθούν.")) { project = blankProject(); project.branches.push(blankBranch(null)); selId = null; pop = null; render(); } return; }
  }
  function onKey(e) {
    if (e.key === "Escape" && pop) { pop = null; renderPop(calcProject()); return; }
    const t = e.target;
    if ((e.key === "Delete") && t && t.classList && t.classList.contains("seg") && t.dataset.id) { e.preventDefault(); delBranch(t.dataset.id); return; }
    if ((e.key === "Enter" || e.key === " ") && t && t.getAttribute && t.getAttribute("role") === "button" && t.tagName !== "BUTTON") {
      e.preventDefault(); t.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  }
  function delBranch(id) {
    const b = project.branches.find(x => x.id === id); if (!b) return;
    const kids = project.branches.filter(x => x.parent === id);
    const msg = kids.length
      ? `Διαγραφή του ${branchLabel(b)}; Οι κλάδοι μετά από αυτόν (${kids.map(branchLabel).join(", ")}) θα ξεκινούν από εκεί που ξεκινούσε ο ${branchLabel(b)}.`
      : `Διαγραφή του ${branchLabel(b)};`;
    if (!confirm(msg)) return;
    kids.forEach(k => { k.parent = b.parent; });
    project.branches = project.branches.filter(x => x.id !== id);
    if (selId === id) selId = b.parent || null;
    pop = null;
    render();
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
  }

  /* ---------------- PERSISTENCE ---------------- */
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(project)); } catch (e) { } }
  function load() { try { const s = localStorage.getItem(LS_KEY); if (s) { project = normalize(JSON.parse(s)); } } catch (e) { } }
  function saveFile() {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const safe = (project.meta.code || project.meta.name || "project").replace(/[^\p{L}\p{N}\-]+/gu, "_");
    a.href = URL.createObjectURL(blob); a.download = "kykloforitis_" + safe + ".json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function loadFile(file) {
    const r = new FileReader();
    r.onload = () => {
      try { project = normalize(JSON.parse(r.result)); selId = null; pop = null; render(); }
      catch (e) { alert("Μη έγκυρο αρχείο .json"); }
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
        ${fits || eqs ? `<table><thead><tr><th>Εξάρτημα / εξοπλισμός</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th class="r">ΔP/τεμ [m]</th><th class="r">ΔP [m]</th></tr></thead><tbody>${fits}${eqs}</tbody></table>` : ""}
        ${c.ctrl ? `<div class="params">Βάνα ελέγχου: authority β = ${fmt(c.ctrl.auth, 2)}</div>` : ""}
        <p class="dpline">ΔP κλάδου ${esc(branchLabel(br))} = <b>${fmt(c.dP)} m · ${kp(c.dP)} kPa</b></p>
      </div>`;
    }).join("");

    const theory = DB.THEORY.map(t => `<tr><td>${esc(t[0])}</td><td><code>${esc(t[1])}</code></td><td>${esc(t[2])}</td><td>${esc(t[3])}</td></tr>`).join("");
    const op = res.pump.op;
    const pumpSec = res.Qd > 0 && res.base > 0 ? `<h2>Καμπύλη δικτύου${res.pump.fit ? " και αντλίας" : ""}</h2><div class="cols"><div>${pumpChart(res)}</div><div>
        <table><tbody>
          <tr><td>Σχεδιασμός</td><td class="r num">${fmt(res.Qd, 2)} m³/h · ${fmt(res.H, 2)} m</td></tr>
          ${op ? `<tr><td>Σημείο λειτουργίας</td><td class="r num">${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} m</td></tr>
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
        <div class="kpi main"><div class="l">Μανομετρικό H</div><div class="v">${fmt(res.H, 2)} m</div><div class="s">${kp(res.H)} kPa</div></div>
        <div class="kpi"><div class="l">Παροχή σημείου λειτουργίας</div><div class="v">${fmt(res.Qd, 2)} m³/h</div><div class="s">${fmt(res.Qd / 3.6, 3)} l/s</div></div>
        <div class="kpi"><div class="l">Υδραυλική ισχύς</div><div class="v">${fmt(res.Ph, 0)} W</div><div class="s">ρ·g·Q·H</div></div>
        <div class="kpi"><div class="l">Ρευστό</div><div class="v" style="font-size:10pt">${esc(fp.label)}</div><div class="s">ν ${fmt(fp.nu * 1e6, 3)}e-6 · ρ ${fmt(fp.rho, 0)}${project.aged ? " · παλαιό δίκτυο" : ""}</div></div>
      </div>
      ${schemSec}
      <h2>Σχηματισμός H</h2>
      <table><thead><tr><th></th><th class="r">m</th><th class="r">kPa</th></tr></thead><tbody>${hRows}</tbody></table>
      ${net ? `<h2>Διαδρομές</h2>
      <table><thead><tr><th>Ως το τέλος του</th><th>Περιγραφή</th><th>Άθροισμα κλάδων</th><th class="r">ΔP [m]</th><th class="r">Στραγγαλισμός [kPa]</th><th class="r">Kv εξισ.</th></tr></thead><tbody>${circRows}</tbody></table>` : ""}
      <h2>Κλάδοι</h2>
      <table><thead><tr><th>Κλάδος</th><th>Περιγραφή</th><th>Σωλήνας</th><th class="r">L [m]</th><th class="r">Q [m³/h]</th><th class="r">v [m/s]</th><th class="r">R [Pa/m]</th><th class="r">ΔP [m]</th></tr></thead><tbody>${sumRows}</tbody></table>
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
    setMode, treeOf, schematic,
    setProject(p) { project = p; },
    getProject() { return project; }
  };

  /* ---------------- INIT ---------------- */
  function init() {
    load();
    normalize(project);
    if (!project.branches.length) project.branches.push(blankBranch(null));
    $("#fileInput").addEventListener("change", e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
    render();
    initStickySide();
    let rt = null;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (project.mode === "network") liveRecalc(); }, 150); });
  }
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("DOMContentLoaded", init);
})();
