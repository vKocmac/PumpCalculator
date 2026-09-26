/* =============================================================================
   app.js — Λογική & UI Υπολογισμού Κυκλοφορητή
   Τα ΔΕΔΟΜΕΝΑ είναι στο data.js (window.DB). Εδώ μόνο μηχανή & διεπαφή.

   Μοντέλο δικτύου: κάθε κλάδος (τμήμα) έχει «γονέα» = τον κλάδο αμέσως πριν
   από αυτόν (ανάντη). Έτσι σχηματίζεται δέντρο από την αντλία ως τα τερματικά.
   Κύκλωμα = διαδρομή από έναν κλάδο-ρίζα ως έναν κλάδο χωρίς παιδιά.
   H = ΔP του δυσμενέστερου κυκλώματος + σταθερές απώλειες εξοπλισμού.
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
  const kindOf = (id) => DB.KINDS.find(k => k.id === id) || DB.KINDS[DB.KINDS.length - 1];

  /* ---------------- STATE ---------------- */
  let project = blankProject();
  let selId = null;
  let activeSec = null;        // "meta" | "fluid" | "branch" | "extras" | "pump"
  const LS_KEY = "pumpcalc.project.v1";

  function blankProject() {
    return {
      v: 2,
      meta: { name: "Νέο έργο", code: "", engineer: "", date: new Date().toISOString().slice(0, 10), notes: "" },
      fluid: D.fluid, concPct: D.concPct, waterTemp: D.waterTemp, marginPct: D.marginPct, dT: D.dT,
      aged: false, openCircuit: false, staticHead: "",
      extras: [], branches: [],
      pump: { points: [{ Q: "", H: "" }, { Q: "", H: "" }, { Q: "", H: "" }], eta: "" },
      flow: { done: {} }
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
      id: uid(), code: nextCode(), desc: "", kind: like && like.kind !== "t" ? like.kind : "pe",
      parent: parentId || null, Q: "", loadKW: "",
      pipeFamily: f0.family, pipeSize: like && fam ? like.pipeSize : f0.sizes[0][0], length: "",
      fittings: [], equip: []
    };
  }

  /* Συμπληρώνει ό,τι λείπει και μεταφέρει παλιά αρχεία (idempotent).
     Παλιό αρχείο = κανένας κλάδος δεν έχει «parent»: οι κλάδοι ήταν όλοι σε σειρά,
     άρα γίνονται αλυσίδα με «συνολικό μήκος» — δίνει ακριβώς το ίδιο H. */
  function normalize(p) {
    p.meta = p.meta || {};
    p.extras = (p.extras || []).map(e => ({ label: e.label || "", dP: e.dP, unit: e.unit || "m" }));
    p.pump = p.pump || { points: [], eta: "" };
    p.pump.points = p.pump.points || [];
    while (p.pump.points.length < 3) p.pump.points.push({ Q: "", H: "" });
    p.flow = p.flow || { done: {} };
    p.flow.done = p.flow.done || {};
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
      if (!b.kind) b.kind = "t";
      b.fittings = b.fittings || [];
      b.equip = (b.equip || []).map(e => ({ label: e.label || "", dP: e.dP, unit: e.unit || "kPa" }));
      if (b.loadKW === undefined) b.loadKW = "";
    });
    const ids = new Set(brs.map(b => b.id));
    brs.forEach(b => { if (b.parent && (!ids.has(b.parent) || b.parent === b.id)) b.parent = null; });
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
  function bracket(arr, x) { // δείκτης i ώστε arr[i] ≤ x ≤ arr[i+1], και βάρος t
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
  function qOf(br, fp) {
    const P = num(br.loadKW), dT = num(project.dT);
    if (P > 0) { fp = fp || fluidProps(); return dT > 0 ? 3600 * P / (fp.rho * fp.cp * dT) : NaN; }
    return num(br.Q);
  }
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
  function calcBranch(br, nu, fp) {
    fp = fp || fluidProps();
    const Q = qOf(br, fp);
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
    const dP = (isFinite(pipe.dP) ? pipe.dP : 0) + sumFit + sumEquip;
    // Authority βάνας ελέγχου: ΔP βάνας / ΔP όλου του κλάδου όπου βρίσκεται
    let ctrl = null;
    fittings.forEach((r, i) => {
      if (r.role === "control" && isFinite(r.per) && r.per > 0 && dP > 0) {
        const dPv = r.per;
        ctrl = { i, dPv, auth: dPv / dP };
      }
    });
    const bal = fittings.map((r, i) => (r.role === "balancing" && isFinite(r.per) ? { i, kPa: toKPa(r.per, fp) } : null)).filter(Boolean);
    return { Q, pipe, fittings, sumFit, equip, sumEquip, dP, ctrl, bal };
  }

  /* ---------------- ENGINE: δίκτυο ---------------- */
  function treeOf(brs) {
    const byId = new Map(brs.map(b => [b.id, b]));
    const kids = new Map(brs.map(b => [b.id, []]));
    const roots = [];
    brs.forEach(b => { if (b.parent && byId.has(b.parent)) kids.get(b.parent).push(b.id); else roots.push(b.id); });
    // κύκλοι: κλάδοι που δεν είναι προσβάσιμοι από ρίζα
    const seen = new Set();
    const order = [], depth = new Map();
    // βάθος εμφάνισης: αυξάνει μόνο σε διακλάδωση (αλυσίδα σε σειρά μένει στην ίδια στήλη)
    const walk = (id, d) => { if (seen.has(id)) return; seen.add(id); order.push(id); depth.set(id, d); const ks = kids.get(id); ks.forEach(k => walk(k, ks.length > 1 ? d + 1 : d)); };
    roots.forEach(r => walk(r, roots.length > 1 ? 1 : 0));
    const cyclic = brs.filter(b => !seen.has(b.id)).map(b => b.id);
    cyclic.forEach(id => { order.push(id); depth.set(id, 0); });
    return { byId, kids, roots, order, depth, cyclic };
  }
  function descendants(id, tree) {
    const out = new Set(); const st = [id];
    while (st.length) { const x = st.pop(); (tree.kids.get(x) || []).forEach(k => { if (!out.has(k)) { out.add(k); st.push(k); } }); }
    return out;
  }
  function fitPump(points) { // ελάχιστα τετράγωνα H = a + bQ + cQ²
    const pts = (points || []).map(p => [num(p.Q), num(p.H)]).filter(([q, h]) => q >= 0 && h > 0);
    if (pts.length < 3) return null;
    let S = [0, 0, 0, 0, 0], T = [0, 0, 0];
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

  function calcProject() {
    normalize(project);
    const fp = fluidProps();
    const branches = project.branches.map(br => ({ br, c: calcBranch(br, fp.nu, fp) }));
    const cById = new Map(branches.map(x => [x.br.id, x]));
    const tree = treeOf(project.branches);
    // κυκλώματα: από κάθε ρίζα ως κάθε φύλλο
    const circuits = [];
    const walk = (id, path, sum) => {
      const x = cById.get(id); const s = sum + (isFinite(x.c.dP) ? x.c.dP : 0);
      const p = path.concat(id);
      const ks = tree.kids.get(id);
      if (!ks.length) circuits.push({ leaf: id, ids: p, dP: s });
      else ks.forEach(k => walk(k, p, s));
    };
    tree.roots.forEach(r => walk(r, [], 0));
    let worst = null;
    circuits.forEach(c => { if (!worst || c.dP > worst.dP) worst = c; });
    const pathMax = worst ? worst.dP : 0;
    circuits.forEach(c => {
      c.excess = pathMax - c.dP;
      c.excessKPa = toKPa(c.excess, fp);
      const leaf = cById.get(c.leaf);
      const q = leaf ? leaf.c.Q : NaN;
      c.kvReq = c.excess > 1e-6 && q > 0 ? q / Math.sqrt(c.excessKPa / 100) : NaN;
      c.worst = c === worst;
    });
    let sumExtras = 0;
    project.extras.forEach(e => { const d = toM(e.dP, e.unit, fp); if (isFinite(d)) sumExtras += d; });
    const base = pathMax + sumExtras;
    const margin = (num(project.marginPct) || 0) / 100;
    const Hfric = base * (1 + margin);
    const Hstatic = project.openCircuit ? (num(project.staticHead) || 0) : 0;
    const H = Hfric + Hstatic;
    // Παροχή αντλίας = Σ παροχών των κλάδων-ριζών
    let Qd = 0; tree.roots.forEach(id => { const q = cById.get(id).c.Q; if (q > 0) Qd += q; });
    if (!(Qd > 0)) Qd = NaN;
    const Ph = fp.rho * D.g * (Qd / 3600) * H;
    // Αντλία
    const fit = fitPump(project.pump.points);
    const Kq = Qd > 0 ? base / (Qd * Qd) : NaN;
    const op = opPoint(fit, Hstatic, Kq);
    const eta = num(project.pump.eta) / 100;
    const pump = { fit, op, Kq, eta };
    if (op) { op.Ph = fp.rho * D.g * (op.Q / 3600) * op.H; op.Pshaft = eta > 0 ? op.Ph / eta : NaN; op.Hdesign = fit.H(Qd); }
    return { fp, branches, cById, tree, circuits, worst, sumBranches: pathMax, sumExtras, base, Hfric, Hstatic, H, margin, Qd, Ph, pump };
  }

  /* ---------------- VALIDATION ---------------- */
  function vMaxFor(Dint) { for (const [d, v] of D.vMaxByDi) if (Dint <= d) return v; return D.vMaxByDi[D.vMaxByDi.length - 1][1]; }
  function vState(v, Dint) {
    if (!isFinite(v)) return "";
    const vm = vMaxFor(Dint);
    if (v < D.vHardMin || v > vm * D.vHardFactor) return "bad";
    if (v < D.vIdealMin || v > vm) return "warn";
    return "ok";
  }
  function rState(R) { return !isFinite(R) ? "" : R > D.rBad ? "bad" : R > D.rWarn ? "warn" : "ok"; }
  function branchLabel(br) { return br.code || br.name || br.id; }
  function validateBranch(br, c, res) {
    const errors = [], warns = [];
    const nm = branchLabel(br);
    if (!(c.Q > 0)) errors.push(`${nm}: λείπει η παροχή Q.`);
    if (!(num(br.length) > 0)) errors.push(`${nm}: λείπει το μήκος L.`);
    if (!lookupPipe(br.pipeFamily, br.pipeSize)) errors.push(`${nm}: μη έγκυρη διατομή σωλήνα.`);
    br.fittings.forEach((f, i) => {
      const hasZ = isFinite(num(f.zeta)) && num(f.zeta) > 0;
      const hasK = isFinite(num(f.kv)) && num(f.kv) > 0;
      if (!(num(f.qty) > 0)) errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): λείπουν τεμάχια.`);
      if (!hasZ && !hasK) errors.push(`${nm} · εξάρτ. #${i + 1} (${f.type || "?"}): δώσε ζ ή Kv.`);
    });
    (br.equip || []).forEach((e, i) => { if (!isFinite(num(e.dP))) errors.push(`${nm} · εξοπλισμός #${i + 1}: λείπει η ΔP.`); });
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
    if (res && res.tree) {
      const ks = res.tree.kids.get(br.id) || [];
      if (ks.length && c.Q > 0) {
        const qs = ks.map(k => res.cById.get(k).c.Q);
        if (qs.every(q => q > 0)) {
          const sum = qs.reduce((a, b) => a + b, 0);
          if (ks.length > 1 && Math.abs(sum - c.Q) > D.qBalTol * c.Q)
            warns.push(`${nm}: Q=${fmt(c.Q, 2)} m³/h ενώ οι κλάδοι μετά αθροίζουν ${fmt(sum, 2)} m³/h.`);
          if (ks.length === 1 && sum > c.Q * (1 + D.qBalTol))
            warns.push(`${nm}: ο επόμενος κλάδος έχει μεγαλύτερη παροχή (${fmt(sum, 2)} > ${fmt(c.Q, 2)} m³/h).`);
        }
      }
    }
    return { errors, warns };
  }
  function validate(res) {
    const errors = [], warns = [];
    if (project.branches.length === 0) errors.push("Δεν υπάρχει κανένας κλάδος.");
    const fp = res.fp;
    if (fp.frozen) errors.push(`Ρευστό: ${fmt(fp.T, 0)} °C είναι κάτω από το σημείο πήξης (${fmt(fp.tFreeze, 1)} °C).`);
    else if (fp.approx) warns.push(`Ρευστό: κοντά στο σημείο πήξης (${fmt(fp.tFreeze, 1)} °C) — ιδιότητες κατά προσέγγιση.`);
    if (fp.clamped) warns.push("Ρευστό: θερμοκρασία ή συγκέντρωση εκτός πίνακα (−30…90 °C, 0…60%) — χρησιμοποιήθηκε το όριο.");
    if (res.tree && res.tree.cyclic.length) errors.push("Δίκτυο: κύκλος στις συνδέσεις κλάδων — έλεγξε το «Μετά από».");
    const codes = {};
    project.branches.forEach(b => { const k = (b.code || "").trim(); if (k) codes[k] = (codes[k] || 0) + 1; });
    Object.keys(codes).forEach(k => { if (codes[k] > 1) warns.push(`Ο κωδικός ${k} χρησιμοποιείται ${codes[k]} φορές.`); });
    res.branches.forEach(({ br, c }) => { const v = validateBranch(br, c, res); errors.push(...v.errors); warns.push(...v.warns); });
    project.extras.forEach((e, i) => { if (!isFinite(num(e.dP))) errors.push(`Σταθερές απώλειες #${i + 1} (${e.label || "χωρίς περιγραφή"}): λείπει η ΔP.`); });
    const op = res.pump && res.pump.op;
    if (res.pump && res.pump.fit && !op) warns.push("Αντλία: η καμπύλη δεν τέμνει την καμπύλη δικτύου.");
    if (op && op.Q < res.Qd * (1 - D.qBalTol)) warns.push(`Αντλία: στο σημείο λειτουργίας δίνει ${fmt(op.Q, 2)} m³/h, λιγότερο από τα ${fmt(res.Qd, 2)} m³/h του σχεδιασμού.`);
    return { errors, warns };
  }

  /* ---------------- RENDER: βοηθητικά ---------------- */
  const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
  function descOf(br) { return (br.desc || "").trim() || `${br.pipeFamily} ${br.pipeSize}`; }
  function kindTag(br) { const k = kindOf(br.kind); return `<span class="ktag k-${k.id}" title="${esc(k.label)}">${esc(k.tag)}</span>`; }
  function field(label, inner, cls = "") { return `<div class="fld ${cls}"><label>${label}</label>${inner}</div>`; }
  function unitSel(attr, i, unit) {
    return `<select ${attr}="${i}" data-k="unit" aria-label="Μονάδα">${["kPa", "m"].map(u => `<option ${u === unit ? "selected" : ""}>${u}</option>`).join("")}</select>`;
  }
  function sections() {
    const s = ["meta", "fluid"];
    if (project.branches.length) s.push("branch");
    s.push("extras", "pump");
    return s;
  }
  const SEC_TITLES = { meta: "Έργο", fluid: "Ρευστό και συνθήκες", extras: "Σταθερές απώλειες εξοπλισμού", pump: "Αντλία (προαιρετικό)" };

  /* ---------------- RENDER: κύρια φόρμα ---------------- */
  function renderMain(res) {
    const m = project.meta;
    const fl = DB.FLUIDS;
    const fluidOpts = Object.keys(fl).map(k => `<option value="${k}" ${project.fluid === k ? "selected" : ""}>${esc(fl[k].label)}</option>`).join("");
    const hasConc = fl[project.fluid] && fl[project.fluid].hasConc;

    const secMeta = `
      <section class="section" data-sec="meta" id="sec-meta">
        <h2>Έργο</h2>
        <div class="grid cols-4">
          ${field("Όνομα", `<input type="text" data-meta="name" value="${esc(m.name)}">`)}
          ${field("Κωδικός", `<input type="text" data-meta="code" value="${esc(m.code)}">`)}
          ${field("Ημερομηνία", `<input type="date" data-meta="date" value="${esc(m.date)}">`)}
          ${field("Μηχανικός", `<input type="text" data-meta="engineer" value="${esc(m.engineer)}">`)}
        </div>
        ${nextBar("meta")}
      </section>`;

    const secFluid = `
      <section class="section" data-sec="fluid" id="sec-fluid">
        <h2>Ρευστό και συνθήκες</h2>
        <div class="grid cols-4">
          ${field("Ρευστό", `<select data-p="fluid">${fluidOpts}</select>`)}
          ${hasConc ? field("Συγκέντρωση [% κ.β.]", `<input type="number" data-p="concPct" value="${esc(project.concPct)}" min="0" max="60" step="5">`) : ""}
          ${field("Θερμοκρασία ρευστού [°C]", `<input type="number" data-p="waterTemp" value="${esc(project.waterTemp)}" step="1">`)}
          ${field("ΔT σχεδιασμού [K]", `<input type="number" data-p="dT" value="${esc(project.dT)}" min="0" step="0.5">`)}
          ${field("Προσαύξηση ασφαλείας [%]", `<input type="number" data-p="marginPct" value="${esc(project.marginPct)}" min="0" step="5">`)}
          ${field("Κύκλωμα", `<select data-p="openCircuit"><option value="0" ${project.openCircuit ? "" : "selected"}>Κλειστό</option><option value="1" ${project.openCircuit ? "selected" : ""}>Ανοιχτό (π.χ. πύργος ψύξης)</option></select>`)}
          ${project.openCircuit ? field("Στατικό ύψος [m]", `<input type="number" data-p="staticHead" value="${esc(project.staticHead)}" step="0.1">`) : ""}
        </div>
        <label class="check"><input type="checkbox" data-p="aged" ${project.aged ? "checked" : ""}> Παλαιό δίκτυο — αυξημένη τραχύτητα σωλήνων (π.χ. σιδηροσωλήνας 0.046 → 0.2 mm)</label>
        <p class="desc" id="fluidHint"></p>
        ${nextBar("fluid")}
      </section>`;

    const secBranch = project.branches.length ? renderBranchSection(res) : "";

    const extras = project.extras.map((e, i) => `
      <div class="eqrow">
        ${field(i ? "" : "Περιγραφή", `<input type="text" data-ex="${i}" data-k="label" placeholder="π.χ. Εναλλάκτης πλακών" value="${esc(e.label)}">`)}
        ${field(i ? "" : "ΔP", `<input type="number" data-ex="${i}" data-k="dP" step="0.01" value="${esc(e.dP)}">`)}
        ${field(i ? "" : "Μονάδα", unitSel("data-ex", i, e.unit))}
        <button class="icon" data-act="ex-del" data-i="${i}" aria-label="Διαγραφή">✕</button>
      </div>`).join("");
    const secExtras = `
      <section class="section" data-sec="extras" id="sec-extras">
        <h2>Σταθερές απώλειες εξοπλισμού</h2>
        <p class="lead">Πτώση πίεσης από το φύλλο του κατασκευαστή για εξοπλισμό που διαρρέεται από όλη την παροχή (εναλλάκτης, λέβητας, ψύκτης). Προστίθεται αυτούσια στο H. Εξοπλισμός ενός μόνο κυκλώματος (στοιχείο FCU, κύκλωμα ενδοδαπέδιας) μπαίνει στον κλάδο του.</p>
        ${extras}
        <button class="ghost small" data-act="ex-add">+ Γραμμή</button>
        ${nextBar("extras")}
      </section>`;

    const pts = project.pump.points.map((p, i) => `
      <tr><td class="muted">${i + 1}</td>
        <td><input type="number" data-pp="${i}" data-k="Q" value="${esc(p.Q)}" step="0.1" aria-label="Q σημείου ${i + 1}"></td>
        <td><input type="number" data-pp="${i}" data-k="H" value="${esc(p.H)}" step="0.1" aria-label="H σημείου ${i + 1}"></td>
        <td>${project.pump.points.length > 3 ? `<button class="icon" data-act="pp-del" data-i="${i}" aria-label="Διαγραφή">✕</button>` : ""}</td></tr>`).join("");
    const secPump = `
      <section class="section" data-sec="pump" id="sec-pump">
        <h2>Αντλία (προαιρετικό)</h2>
        <p class="lead">Δώσε 3–5 σημεία της καμπύλης από το φύλλο της αντλίας που εξετάζεις. Βγαίνει το σημείο λειτουργίας πάνω στην καμπύλη του δικτύου και η ισχύς.</p>
        <div class="pumpgrid">
          <div>
            <table class="table"><thead><tr><th></th><th>Q [m³/h]</th><th>H [m]</th><th></th></tr></thead><tbody>${pts}</tbody></table>
            <div class="rowbtns">${project.pump.points.length < 5 ? `<button class="ghost small" data-act="pp-add">+ Σημείο</button>` : ""}</div>
            ${field("Βαθμός απόδοσης αντλίας η [%]", `<input type="number" data-pump="eta" value="${esc(project.pump.eta)}" min="1" max="100" step="1">`)}
          </div>
          <div id="pumpOut"></div>
        </div>
        ${nextBar("pump")}
      </section>`;

    $("#flowMain").innerHTML = `<nav class="lc-rail" id="rail" aria-label="Πρόοδος"></nav>` + secMeta + secFluid + secBranch + secExtras + secPump;
  }

  function nextBar(sec) {
    return `<div class="lc-next"><span data-next-lbl="${sec}"></span><button class="primary" data-act="next" data-sec="${sec}" data-next-btn="${sec}">Επόμενο</button></div>`;
  }

  function renderBranchSection(res) {
    const entry = res.cById.get(selId);
    if (!entry) return "";
    const { br } = entry;
    const famOpts = DB.PIPE_FAMILIES.map(f => `<option ${f.family === br.pipeFamily ? "selected" : ""}>${esc(f.family)}</option>`).join("");
    const fam = DB.PIPE_FAMILIES.find(f => f.family === br.pipeFamily) || DB.PIPE_FAMILIES[0];
    const sizeOpts = fam.sizes.map(s => `<option ${s[0] === br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("");
    const kindOpts = DB.KINDS.map(k => `<option value="${k.id}" ${k.id === br.kind ? "selected" : ""}>${esc(k.label)}</option>`).join("");
    const desc = descendants(br.id, res.tree);
    const parentOpts = `<option value="">Αρχή δικτύου (αντλία)</option>` + res.tree.order
      .filter(id => id !== br.id && !desc.has(id))
      .map(id => { const b = res.tree.byId.get(id); return `<option value="${id}" ${br.parent === id ? "selected" : ""}>${esc(branchLabel(b))} · ${esc(descOf(b))}</option>`; }).join("");
    const byLoad = num(br.loadKW) > 0;
    const dbl = kindOf(br.kind).double;

    const fitRows = br.fittings.map((f, i) => {
      const sizeSel = `<select data-fit="${i}" data-k="size" aria-label="Διατομή"><option value="">= σωλήνα</option>${fam.sizes.map(s => `<option ${s[0] === f.size && f.size !== br.pipeSize ? "selected" : ""}>${esc(s[0])}</option>`).join("")}</select>`;
      return `<tr data-fi="${i}">
        <td class="c-type"><select data-fit="${i}" data-k="type" aria-label="Είδος">${fittingSelectHTML(f.type)}</select></td>
        <td class="c-size">${sizeSel}</td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="qty" value="${esc(f.qty)}" min="0" step="1" aria-label="Τεμάχια"></td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="zeta" value="${esc(f.zeta)}" step="0.05" placeholder="ζ" aria-label="ζ"></td>
        <td class="c-n"><input type="number" class="n" data-fit="${i}" data-k="kv" value="${esc(f.kv)}" step="0.1" placeholder="Kv" aria-label="Kv"></td>
        <td class="meth"></td>
        <td class="out r"></td>
        <td class="out r tot"></td>
        <td><button class="icon" data-act="fit-del" data-i="${i}" aria-label="Διαγραφή">✕</button></td>
      </tr>`;
    }).join("");

    const eqRows = (br.equip || []).map((e, i) => `
      <div class="eqrow">
        ${field(i ? "" : "Περιγραφή", `<input type="text" data-eq="${i}" data-k="label" placeholder="π.χ. Στοιχείο FCU" value="${esc(e.label)}">`)}
        ${field(i ? "" : "ΔP", `<input type="number" data-eq="${i}" data-k="dP" step="0.1" value="${esc(e.dP)}">`)}
        ${field(i ? "" : "Μονάδα", unitSel("data-eq", i, e.unit))}
        <button class="icon" data-act="eq-del" data-i="${i}" aria-label="Διαγραφή">✕</button>
      </div>`).join("");

    return `
      <section class="section" data-sec="branch" id="sec-branch">
        <h2 id="brTitle"></h2>
        <div class="grid br-top">
          ${field("Κωδικός", `<input type="text" class="mono" data-br="code" value="${esc(br.code)}">`)}
          ${field("Περιγραφή", `<input type="text" data-br="desc" value="${esc(br.desc)}" placeholder="${esc(br.pipeFamily + " " + br.pipeSize)}">`)}
          ${field("Είδος", `<select data-br="kind">${kindOpts}</select>`)}
        </div>
        <p class="desc">Η περιγραφή φαίνεται στη λίστα κλάδων και στο PDF. Αν μείνει κενή, μπαίνει το υλικό και η διατομή.</p>
        <div class="grid cols-3 mt">
          ${field("Μετά από", `<select data-br="parent">${parentOpts}</select>`)}
          ${field("Παροχή Q [m³/h]", `<input type="number" data-br="Q" value="${esc(byLoad ? "" : br.Q)}" step="0.01" ${byLoad ? "disabled placeholder='από φορτίο'" : ""}>`)}
          ${field("ή Φορτίο [kW]", `<input type="number" data-br="loadKW" value="${esc(br.loadKW)}" step="0.1" placeholder="προαιρετικό">`)}
        </div>
        <p class="desc" id="qInfo"></p>

        <h3 class="sub">Σωλήνωση</h3>
        <div class="grid cols-3">
          ${field("Υλικό", `<select data-br="pipeFamily">${famOpts}</select>`)}
          ${field("Διατομή", `<select data-br="pipeSize">${sizeOpts}</select>`)}
          ${field(dbl ? "Μήκος μίας διαδρομής L [m]" : "Μήκος L [m]", `<input type="number" data-br="length" value="${esc(br.length)}" step="0.1">`)}
        </div>
        <p class="desc" id="lenInfo"></p>
        <div class="kpis6" id="pipeKpis"></div>

        <div class="subhead"><h3 class="sub">Εξαρτήματα</h3><button class="ghost small" data-act="fit-add">+ Εξάρτημα</button></div>
        <div class="tablewrap">
        <table class="table fit">
          <thead><tr><th>Είδος</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th>Με</th><th class="r">ΔP/τεμ [m]</th><th class="r">ΔP [m]</th><th></th></tr></thead>
          <tbody>${fitRows || `<tr class="empty"><td colspan="9">Κανένα εξάρτημα</td></tr>`}</tbody>
        </table>
        </div>
        <p class="desc">Αν δώσεις Kv από το φύλλο του κατασκευαστή, χρησιμοποιείται αυτό αντί για το ζ.${dbl ? " Τα τεμάχια είναι συνολικά για προσαγωγή και επιστροφή." : ""} Σε άλλη διατομή, το ζ υπολογίζεται με την ταχύτητα εκείνης της διατομής.</p>
        <p class="desc" id="authInfo"></p>

        <div class="subhead"><h3 class="sub">Εξοπλισμός σε αυτόν τον κλάδο</h3><button class="ghost small" data-act="eq-add">+ Εξοπλισμός</button></div>
        ${eqRows || `<p class="desc">π.χ. στοιχείο FCU, δυσμενέστερο κύκλωμα ενδοδαπέδιας, εναλλάκτης κλάδου — ΔP από φύλλο.</p>`}

        <div class="brtotal"><span id="brTotLbl"></span><b id="brTot"></b></div>
        ${nextBar("branch")}
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
  function branchStatus(br, c, res) {
    const v = validateBranch(br, c, res);
    return v.errors.length ? "todo" : v.warns.length ? "warn" : "done";
  }
  function secState(sec, res) {
    if (sec === "branch") return "";
    return project.flow.done[sec] ? "done" : "todo";
  }
  function renderOutputs(res, val) {
    const fp = res.fp;
    // Ρευστό
    const fh = $("#fluidHint");
    if (fh) fh.innerHTML = fp.frozen
      ? `<span class="errTxt">Κάτω από το σημείο πήξης (${fmt(fp.tFreeze, 1)} °C).</span>`
      : `ν <b class="num">${fmt(fp.nu * 1e6, 3)}×10⁻⁶ m²/s</b> · ρ <b class="num">${fmt(fp.rho, 1)} kg/m³</b> · cp <b class="num">${fmt(fp.cp, 3)} kJ/kgK</b>` +
        (DB.FLUIDS[project.fluid] && DB.FLUIDS[project.fluid].hasConc ? ` · σημείο πήξης <b class="num">${fmt(fp.tFreeze, 1)} °C</b>` : "");

    // Κλάδος
    const entry = res.cById.get(selId);
    if (entry && $("#sec-branch")) {
      const { br, c } = entry, p = c.pipe;
      $("#brTitle").innerHTML = `<span class="brt-code">Κλάδος <span class="mono">${esc(branchLabel(br))}</span></span><span class="brt-desc">${esc(descOf(br))}</span>`;
      const qi = [];
      if (num(br.loadKW) > 0) qi.push(`Q από φορτίο = <b class="num">${fmt(c.Q, 3)} m³/h</b> (ΔT ${esc(project.dT)} K, ρ·cp του ρευστού)`);
      const ks = res.tree.kids.get(br.id) || [];
      if (ks.length > 1) { const s = ks.reduce((a, k) => a + (res.cById.get(k).c.Q || 0), 0); qi.push(`Σ παροχών των κλάδων μετά: <b class="num">${fmt(s, 2)} m³/h</b>`); }
      $("#qInfo").innerHTML = qi.join(" · ");
      $("#lenInfo").innerHTML = kindOf(br.kind).double && num(br.length) > 0
        ? `Στον υπολογισμό: <b class="num">2 × ${esc(br.length)} = ${fmt(2 * num(br.length), 1)} m</b> (προσαγωγή + επιστροφή)` : "";
      const vs = vState(p.v, p.D_int), rs = rState(p.R);
      $("#pipeKpis").innerHTML = [
        ["Εσωτ. διάμετρος", fmt(p.D_int, 2) + " mm", ""],
        ["Ταχύτητα", fmt(p.v, 3) + " m/s", vs, isFinite(p.D_int) ? "όριο " + fmt(vMaxFor(p.D_int), 1) : ""],
        ["Re", isFinite(p.Re) ? Math.round(p.Re).toLocaleString("el") : "—", p.regime && p.regime !== "τυρβώδης" ? "warn" : "", p.regime || ""],
        ["λ", fmt(p.lambda, 4), "", isFinite(p.k) ? "k " + p.k + " mm" : ""],
        ["Απώλεια ανά m", fmt(p.R, 0) + " Pa/m", rs],
        ["ΔP σωλήνα", fmt(p.dP) + " m", ""]
      ].map(([l, v, s, sub]) => `<div class="kp ${s ? "s-" + s : ""}"><span>${l}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`).join("");
      c.fittings.forEach((r, i) => {
        const row = $(`#sec-branch tr[data-fi="${i}"]`);
        if (!row) return;
        row.querySelector(".meth").textContent = r.method;
        const outs = row.querySelectorAll(".out");
        outs[0].textContent = fmt(r.per); outs[1].textContent = fmt(r.total);
        const z = row.querySelector('[data-k="zeta"]'), k = row.querySelector('[data-k="kv"]');
        z.classList.toggle("dim", r.method === "Kv"); k.classList.toggle("dim", r.method !== "Kv");
      });
      $("#authInfo").innerHTML = c.ctrl ? `Βάνα ελέγχου: ΔP <b class="num">${fmt(toKPa(c.ctrl.dPv, fp), 1)} kPa</b> · authority β = <b class="num ${c.ctrl.auth < D.authMin ? "warnTxt" : "ok"}">${fmt(c.ctrl.auth, 2)}</b> (στόχος ≥ ${D.authMin})` : "";
      $("#brTotLbl").textContent = `ΔP κλάδου ${branchLabel(br)}`;
      $("#brTot").textContent = `${fmt(c.dP)} m · ${fmt(toKPa(c.dP, fp), 1)} kPa`;
      $$("#sec-branch [data-br='Q'], #sec-branch [data-br='length']").forEach(inp => {
        const k = inp.dataset.br; inp.classList.toggle("need", k === "Q" ? !(c.Q > 0) && !inp.disabled : !(num(br.length) > 0));
      });
    }

    // Αντλία
    const po = $("#pumpOut");
    if (po) po.innerHTML = pumpBlock(res);

    // Ενότητες: κατάσταση
    sections().forEach((sec, i) => {
      const el = $("#sec-" + sec); if (!el) return;
      const h = el.querySelector(":scope > h2");
      let st = secState(sec, res);
      if (sec === "branch" && entry) st = branchStatus(entry.br, entry.c, res);
      const act = activeSec === sec;
      el.classList.toggle("lc-active", act);
      el.classList.toggle("lc-done", !act && st === "done");
      el.classList.toggle("lc-warn", !act && st === "warn");
      const chip = act ? "Συμπληρώνεις" : st === "done" ? (sec === "branch" ? "Πλήρης" : "Ελέγχθηκε")
        : st === "warn" ? "Με παρατηρήσεις" : sec === "branch" ? "Λείπουν στοιχεία" : sec === "pump" || sec === "extras" ? "Προαιρετικό" : "Προεπιλογές";
      h.setAttribute("data-chip", chip);
      const lbl = el.querySelector(`[data-next-lbl="${sec}"]`), btn = el.querySelector(`[data-next-btn="${sec}"]`);
      const nx = nextTarget(sec, res);
      if (lbl) lbl.textContent = nx.label;
      if (btn) btn.textContent = nx.btn;
    });

    renderRail(res);
    renderSide(res, val);
    renderMbar(res);
  }

  function nextTarget(sec, res) {
    if (sec === "meta") return { label: "Επόμενο: ρευστό και συνθήκες", btn: "Επόμενο →" };
    if (sec === "fluid") { const f = res.tree.order[0]; return f ? { label: `Επόμενο: κλάδος ${branchLabel(res.tree.byId.get(f))}`, btn: "Επόμενο →" } : { label: "Επόμενο: σταθερές απώλειες", btn: "Επόμενο →" }; }
    if (sec === "branch") {
      const o = res.tree.order, i = o.indexOf(selId);
      if (i >= 0 && i < o.length - 1) { const b = res.tree.byId.get(o[i + 1]); return { label: `Επόμενο: κλάδος ${branchLabel(b)} · ${descOf(b)}`, btn: `Επόμενο: ${branchLabel(b)} →` }; }
      return { label: "Επόμενο: σταθερές απώλειες εξοπλισμού", btn: "Επόμενο →" };
    }
    if (sec === "extras") return { label: "Επόμενο: αντλία (προαιρετικό)", btn: "Επόμενο →" };
    return { label: "Τέλος: άνοιξε την αναφορά", btn: "Αναφορά PDF" };
  }

  function renderRail(res) {
    const rail = $("#rail"); if (!rail) return;
    const steps = [];
    steps.push({ key: "meta", label: "Έργο", st: secState("meta") });
    steps.push({ key: "fluid", label: "Ρευστό", st: secState("fluid") });
    const brSteps = res.tree.order.map(id => { const x = res.cById.get(id); return { key: "br:" + id, label: branchLabel(x.br), st: branchStatus(x.br, x.c, res), br: true }; });
    steps.push(...brSteps);
    steps.push({ key: "extras", label: "Εξοπλισμός", st: secState("extras") });
    steps.push({ key: "pump", label: "Αντλία", st: secState("pump") });
    const isAct = s => s.br ? (activeSec === "branch" && s.key === "br:" + selId) : activeSec === s.key;
    const done = steps.filter(s => s.st === "done" || s.st === "warn").length;
    const act = steps.find(isAct);
    const nowLbl = act ? (act.br ? `Κλάδος ${act.label} · ${descOf(res.cById.get(selId).br)}` : act.label) : "—";
    const n = steps.length;
    const cols = `grid-template-columns: repeat(${n}, minmax(0, 1fr))`;
    const brStart = 3, brN = brSteps.length;
    rail.innerHTML = `
      <div class="lc-rail-top"><div>Πρόοδος <b>${done} από ${n}</b></div><div>Συμπληρώνεις: <b>${esc(nowLbl)}</b></div></div>
      <div class="lc-steps" style="${cols}">
        ${brN ? `<div class="lc-group" style="grid-column: ${brStart} / span ${brN}"><i></i><span>Κλάδοι</span><i></i></div>` : ""}
        ${steps.map((s, i) => {
          const a = isAct(s);
          const cls = a ? "active" : s.st === "done" ? "done" : s.st === "warn" ? "is-warn" : "";
          const mark = a ? "" : s.st === "done" ? "✓ " : s.st === "warn" ? "! " : "";
          return `<button class="lc-step ${cls}" style="grid-row: 2; grid-column: ${i + 1}" data-act="goto" data-key="${esc(s.key)}" title="${esc(s.label)}"><span>${mark}${esc(s.label)}</span></button>`;
        }).join("")}
      </div>`;
  }

  function renderSide(res, val) {
    const fp = res.fp;
    const worstLeaf = res.worst ? res.cById.get(res.worst.leaf) : null;
    const rows = [
      [`Δυσμενέστερο κύκλωμα${worstLeaf ? " → " + esc(branchLabel(worstLeaf.br)) : ""}`, fmt(res.sumBranches) + " m"],
      ["Σταθερές απώλειες εξοπλισμού", fmt(res.sumExtras) + " m"],
      ["Σύνολο χωρίς προσαύξηση", fmt(res.base) + " m"],
      ["Προσαύξηση", fmt(res.margin * 100, 0) + " %"]
    ];
    if (project.openCircuit) rows.push(["Στατικό ύψος", fmt(res.Hstatic, 2) + " m"]);
    rows.push(["Υδραυλική ισχύς", isFinite(res.Ph) ? fmt(res.Ph, 0) + " W" : "—"]);

    const total = res.sumBranches > 0 ? res.sumBranches : 1;
    const onWorst = new Set(res.worst ? res.worst.ids : []);
    const list = res.tree.order.map(id => {
      const { br, c } = res.cById.get(id);
      const st = branchStatus(br, c, res);
      const sel = id === selId;
      const d = res.tree.depth.get(id) || 0;
      const icon = sel ? `<span class="st st-act"><i></i></span>` : st === "done" ? `<span class="st st-ok">${CHECK}</span>` : st === "warn" ? `<span class="st st-warn">!</span>` : `<span class="st st-todo"></span>`;
      const meta = `${esc(br.pipeFamily)} ${esc(br.pipeSize)} · ${isFinite(c.pipe.Leff) ? fmt(c.pipe.Leff, 1) + " m" : "— m"} · ${c.Q > 0 ? fmt(c.Q, 2) : "—"} m³/h`;
      const pct = isFinite(c.dP) ? Math.min(100, 100 * c.dP / total) : 0;
      return `<div class="bitem ${sel ? "sel" : ""} ${st === "warn" && !sel ? "is-warn" : ""}" style="--d:${d}" data-act="pick" data-id="${id}" role="button" tabindex="0">
        ${icon}
        <div class="bmain">
          <div class="btop"><b class="mono">${esc(branchLabel(br))}</b>${kindTag(br)}<span class="bdesc">${esc(descOf(br))}</span></div>
          <div class="bmeta">${meta}</div>
          <div class="bbar ${onWorst.has(id) ? "w" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div>
        </div>
        <b class="bdp">${fmt(c.dP)} m</b>
        <button class="icon sm" data-act="del" data-id="${id}" aria-label="Διαγραφή ${esc(branchLabel(br))}">✕</button>
      </div>`;
    }).join("");

    const circ = res.circuits.length > 1 ? `
      <div class="mini">
        <h3>Κυκλώματα</h3>
        ${res.circuits.slice().sort((a, b) => b.dP - a.dP).map(ci => {
          const leaf = res.cById.get(ci.leaf).br;
          const path = ci.ids.map(id => esc(branchLabel(res.cById.get(id).br))).join(" › ");
          return `<div class="circ ${ci.worst ? "worst" : ""}">
            <div class="ctop"><b>→ ${esc(branchLabel(leaf))}</b><span>${esc(descOf(leaf))}</span><b class="num">${fmt(ci.dP)} m</b></div>
            <div class="cpath">${path}</div>
            <div class="cnote">${ci.worst ? "Δυσμενέστερο — καθορίζει το H" : `Εξισορρόπηση: +${fmt(ci.excessKPa, 1)} kPa${isFinite(ci.kvReq) ? ` · Kv ≈ ${fmt(ci.kvReq, 2)}` : ""}`}</div>
          </div>`;
        }).join("")}
      </div>` : "";

    const checks = (val.errors.length ? `<div class="err"><b>Λείπουν ή είναι λάθος (${val.errors.length})</b><ul>${val.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "")
      + (val.warns.length ? `<div class="warn"><b>Παρατηρήσεις (${val.warns.length})</b><ul>${val.warns.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : "")
      + (!val.errors.length && !val.warns.length ? `<div class="good">Όλα τα πεδία συμπληρωμένα, χωρίς παρατηρήσεις.</div>` : "")
      + (!val.errors.length && val.warns.length ? `<div class="good">Όλα τα πεδία συμπληρωμένα.</div>` : "");

    const sel = res.cById.get(selId);
    $("#side").innerHTML = `
      <div class="mini" id="result">
        <h3>Αποτέλεσμα</h3>
        <div class="kpi kpi-main"><span>Μανομετρικό κυκλοφορητή</span><b>${fmt(res.H, 2)} m</b><span class="kpi-sub">${fmt(toKPa(res.H, fp), 1)} kPa · Q = ${fmt(res.Qd, 2)} m³/h</span></div>
        ${rows.map(([a, b]) => `<div class="rowline"><span>${a}</span><span>${b}</span></div>`).join("")}
      </div>
      <div class="mini">
        <div class="mhead"><h3>Κλάδοι</h3></div>
        <div class="blist">${list || `<p class="desc">Κανένας κλάδος.</p>`}</div>
        <div class="rowbtns">
          <button class="primary small" data-act="add-after">${sel ? `+ Κλάδος μετά τον ${esc(branchLabel(sel.br))}` : "+ Κλάδος"}</button>
          ${sel ? `<button class="ghost small" data-act="add-par">+ Παράλληλος του ${esc(branchLabel(sel.br))}</button>` : ""}
        </div>
        <p class="desc">Η μπλε μπάρα σημαίνει κλάδο του δυσμενέστερου κυκλώματος.</p>
      </div>
      ${circ}
      <div class="mini"><h3>Έλεγχοι</h3>${checks}</div>
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
    mb.innerHTML = `<div><small>Μανομετρικό</small><b>${fmt(res.H, 2)} m</b><small>Q ${fmt(res.Qd, 2)} m³/h</small></div><button data-act="to-side">Ανάλυση ↓</button>`;
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
    const op = res.pump.op, fp = res.fp;
    let txt = "";
    if (!res.pump.fit) txt = `<p class="desc">Χωρίς καμπύλη αντλίας φαίνεται μόνο η καμπύλη του δικτύου και το σημείο σχεδιασμού.</p>`;
    else if (!op) txt = `<div class="warn">Η καμπύλη της αντλίας δεν τέμνει την καμπύλη του δικτύου.</div>`;
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
    if (!activeSec) activeSec = !project.flow.done.meta ? "meta" : !project.flow.done.fluid ? "fluid" : project.branches.length ? "branch" : "extras";
    if (activeSec === "branch" && !project.branches.length) activeSec = "extras";
    renderMain(res);
    const val = validate(res);
    renderOutputs(res, val);
    save();
  }
  function liveRecalc() {
    const res = calcProject();
    renderOutputs(res, validate(res));
    save();
  }
  function scrollToSec(sec) {
    const el = $("#sec-" + sec);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------------- EVENTS ---------------- */
  function curBranch() { return project.branches.find(b => b.id === selId); }
  const STRUCT_BR = ["kind", "parent", "pipeFamily", "pipeSize"];

  function onInput(e) {
    const t = e.target;
    if (t.tagName === "SELECT" || t.type === "checkbox") return;   // στο change
    const ds = t.dataset;
    if (ds.meta) { project.meta[ds.meta] = t.value; liveRecalc(); return; }
    if (ds.p) { project[ds.p] = t.value; liveRecalc(); return; }
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
    if (ds.br && STRUCT_BR.includes(ds.br)) {
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
    if (!t) return;
    const a = t.dataset.act;
    if (a === "del") { e.stopPropagation(); delBranch(t.dataset.id); return; }
    if (a === "pick") { selId = t.dataset.id; activeSec = "branch"; render(); scrollToSec("branch"); return; }
    if (a === "goto") {
      const k = t.dataset.key;
      if (k.startsWith("br:")) { selId = k.slice(3); activeSec = "branch"; } else activeSec = k;
      render(); scrollToSec(activeSec); return;
    }
    if (a === "next") { goNext(t.dataset.sec); return; }
    if (a === "add-after" || a === "add-par") {
      const cur = curBranch();
      const parent = !cur ? null : a === "add-after" ? cur.id : cur.parent;
      const b = blankBranch(parent, cur);
      if (a === "add-par" && cur) b.kind = cur.kind;
      project.branches.push(b); selId = b.id; activeSec = "branch";
      render(); scrollToSec("branch");
      const c = $("#sec-branch [data-br='desc']"); if (c) c.focus();
      return;
    }
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
    if (a === "new") { if (confirm("Νέο έργο; Τα μη αποθηκευμένα δεδομένα θα χαθούν.")) { project = blankProject(); project.branches.push(blankBranch(null)); selId = null; activeSec = null; render(); } return; }
  }
  function onKey(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".bitem")) { e.preventDefault(); e.target.click(); }
  }
  function onFocusIn(e) {
    const sec = e.target.closest && e.target.closest("section.section");
    if (sec && sec.dataset.sec && activeSec !== sec.dataset.sec) { activeSec = sec.dataset.sec; liveRecalc(); }
  }
  function goNext(sec) {
    const res = calcProject();
    if (sec !== "branch") project.flow.done[sec] = true;
    if (sec === "meta") activeSec = "fluid";
    else if (sec === "fluid") { if (res.tree.order.length) { activeSec = "branch"; selId = res.tree.order[0]; } else activeSec = "extras"; }
    else if (sec === "branch") {
      const o = res.tree.order, i = o.indexOf(selId);
      if (i >= 0 && i < o.length - 1) selId = o[i + 1]; else activeSec = "extras";
    }
    else if (sec === "extras") activeSec = "pump";
    else if (sec === "pump") { render(); openReport(); return; }
    render(); scrollToSec(activeSec);
  }
  function delBranch(id) {
    const b = project.branches.find(x => x.id === id); if (!b) return;
    const kids = project.branches.filter(x => x.parent === id);
    const msg = kids.length
      ? `Διαγραφή του ${branchLabel(b)}; Οι κλάδοι μετά από αυτόν (${kids.map(branchLabel).join(", ")}) θα συνδεθούν στον προηγούμενο.`
      : `Διαγραφή του ${branchLabel(b)};`;
    if (!confirm(msg)) return;
    kids.forEach(k => { k.parent = b.parent; });
    project.branches = project.branches.filter(x => x.id !== id);
    if (selId === id) selId = b.parent || null;
    render();
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
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
      try { project = normalize(JSON.parse(r.result)); selId = null; activeSec = null; render(); }
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
    tr.wst td { background: #FFF6E5; }
    .code { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 600; }
    .ktag { display: inline-block; font-size: 7.5pt; font-weight: 600; padding: 0 5px; border-radius: 4px; background: #EEF1F5; color: #26364A; margin-left: 4px; }
    .ktag.k-p { background: #FDECEA; color: #9A3412; } .ktag.k-e { background: #DCEBF8; color: #0B4F86; }
    .bar { height: 7px; background: #E6EBF1; border-radius: 4px; overflow: hidden; min-width: 50px; }
    .bar i { display: block; height: 100%; background: #0B6FB8; }
    .br { break-inside: avoid; margin: 10px 0 6px; }
    .br .bh { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
    .br .badge { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 600; color: #fff; background: #0B6FB8; border-radius: 5px; padding: 1px 8px; font-size: 10.5pt; }
    .br .bt { font-size: 11pt; font-weight: 700; }
    .br .params { font-family: "IBM Plex Mono", Consolas, monospace; font-size: 8.5pt; color: #4A5A6C; margin-bottom: 4px; }
    .dpline { text-align: right; font-size: 9.5pt; }
    .dpline b { background: #EEF5FC; color: #0B4F86; padding: 2px 8px; border-radius: 4px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .warnbox { border: 1px solid #F3D9A4; background: #FFF6E5; color: #6B4A00; border-radius: 6px; padding: 6px 10px; font-size: 9pt; }
    .warnbox ul { margin: 2px 0 0 16px; padding: 0; }
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
    @media screen { body { padding: 24px; max-width: 900px; margin: 0 auto; } }
  `;
  function openReport() {
    const res = calcProject();
    const val = validate(res);
    if (val.errors.length && !confirm(`Υπάρχουν ${val.errors.length} ελλείψεις ή σφάλματα. Συνέχεια στην αναφορά;`)) return;
    const m = project.meta, fp = res.fp;
    const kp = h => fmt(toKPa(h, fp), 1);
    const onWorst = new Set(res.worst ? res.worst.ids : []);
    const total = res.sumBranches > 0 ? res.sumBranches : 1;

    const sumRows = res.tree.order.map(id => {
      const { br, c } = res.cById.get(id), p = c.pipe;
      return `<tr class="${onWorst.has(id) ? "" : ""}"><td class="code">${esc(branchLabel(br))}<span class="ktag k-${esc(br.kind)}">${esc(kindOf(br.kind).tag)}</span></td>
        <td><b>${esc(descOf(br))}</b></td><td>${esc(br.pipeFamily)} ${esc(br.pipeSize)}</td>
        <td class="r num">${fmt(p.Leff, 1)}</td><td class="r num">${fmt(c.Q, 2)}</td><td class="r num">${fmt(p.v, 2)}</td>
        <td class="r num">${fmt(p.R, 0)}</td><td class="r num">${fmt(c.dP)}</td>
        <td style="width:12%">${onWorst.has(id) ? `<div class="bar"><i style="width:${Math.min(100, 100 * c.dP / total).toFixed(1)}%"></i></div>` : ""}</td></tr>`;
    }).join("");

    const circRows = res.circuits.slice().sort((a, b) => b.dP - a.dP).map(ci => {
      const leaf = res.cById.get(ci.leaf).br;
      return `<tr class="${ci.worst ? "wst" : ""}"><td class="code">→ ${esc(branchLabel(leaf))}</td><td>${esc(descOf(leaf))}</td>
        <td class="mono">${ci.ids.map(id => esc(branchLabel(res.cById.get(id).br))).join(" › ")}</td>
        <td class="r num">${fmt(ci.dP)}</td><td class="r num">${kp(ci.dP)}</td>
        <td class="r num">${ci.worst ? "δυσμενέστερο" : fmt(ci.excessKPa, 1)}</td><td class="r num">${ci.worst ? "—" : fmt(ci.kvReq, 2)}</td></tr>`;
    }).join("");

    const hRows = `
      <tr><td>Δυσμενέστερο κύκλωμα${res.worst ? " → " + esc(branchLabel(res.cById.get(res.worst.leaf).br)) : ""}</td><td class="r num">${fmt(res.sumBranches)}</td><td class="r num">${kp(res.sumBranches)}</td></tr>
      ${project.extras.map(e => `<tr><td>${esc(e.label || "Εξοπλισμός")}</td><td class="r num">${fmt(toM(e.dP, e.unit, fp))}</td><td class="r num">${kp(toM(e.dP, e.unit, fp))}</td></tr>`).join("")}
      <tr class="tot"><td>Σύνολο χωρίς προσαύξηση</td><td class="r num">${fmt(res.base)}</td><td class="r num">${kp(res.base)}</td></tr>
      <tr><td>Προσαύξηση ${fmt(res.margin * 100, 0)} %</td><td class="r num">${fmt(res.Hfric - res.base)}</td><td class="r num">${kp(res.Hfric - res.base)}</td></tr>
      ${project.openCircuit ? `<tr><td>Στατικό ύψος</td><td class="r num">${fmt(res.Hstatic)}</td><td class="r num">${kp(res.Hstatic)}</td></tr>` : ""}
      <tr class="H"><td>Μανομετρικό κυκλοφορητή H</td><td class="r num">${fmt(res.H)}</td><td class="r num">${kp(res.H)}</td></tr>`;

    const detail = res.tree.order.map(id => {
      const { br, c } = res.cById.get(id), p = c.pipe;
      const fits = br.fittings.map((f, j) => {
        const r = c.fittings[j];
        return `<tr><td>${esc(f.type)}</td><td>${r.ownSize ? esc(f.size) : "—"}</td><td class="r num">${esc(f.qty)}</td>
          <td class="r num">${r.method === "ζ" ? esc(f.zeta) : "—"}</td><td class="r num">${r.method === "Kv" ? esc(f.kv) : "—"}</td>
          <td class="r num">${fmt(r.per)}</td><td class="r num">${fmt(r.total)}</td></tr>`;
      }).join("");
      const eqs = (br.equip || []).map((e, j) => `<tr><td>${esc(e.label || "Εξοπλισμός")}</td><td>—</td><td></td><td></td><td></td><td class="r num">${esc(e.dP)} ${esc(e.unit)}</td><td class="r num">${fmt(c.equip[j])}</td></tr>`).join("");
      const kind = kindOf(br.kind);
      return `<div class="br">
        <div class="bh"><span class="badge">${esc(branchLabel(br))}</span><span class="bt">${esc(descOf(br))}</span><span class="ktag k-${esc(br.kind)}">${esc(kind.label)}</span></div>
        <div class="params">${esc(br.pipeFamily)} ${esc(br.pipeSize)} · D ${fmt(p.D_int, 2)} mm · k ${fmt(p.k, 3)} mm · L ${kind.double ? `2×${esc(br.length)} = ` : ""}${fmt(p.Leff, 1)} m · Q ${fmt(c.Q, 2)} m³/h${num(br.loadKW) > 0 ? ` (${esc(br.loadKW)} kW)` : ""}<br>v ${fmt(p.v, 3)} m/s · Re ${isFinite(p.Re) ? Math.round(p.Re) : "—"} (${esc(p.regime || "—")}) · λ ${fmt(p.lambda, 4)} · R ${fmt(p.R, 0)} Pa/m · ΔP σωλήνα ${fmt(p.dP)} m${br.parent ? ` · μετά από ${esc(branchLabel(res.tree.byId.get(br.parent)))}` : " · αρχή δικτύου"}</div>
        ${fits || eqs ? `<table><thead><tr><th>Εξάρτημα / εξοπλισμός</th><th>Διατομή</th><th class="r">Τεμ.</th><th class="r">ζ</th><th class="r">Kv</th><th class="r">ΔP/τεμ [m]</th><th class="r">ΔP [m]</th></tr></thead><tbody>${fits}${eqs}</tbody></table>` : ""}
        ${c.ctrl ? `<div class="params">Βάνα ελέγχου: authority β = ${fmt(c.ctrl.auth, 2)}</div>` : ""}
        <p class="dpline">ΔP κλάδου ${esc(branchLabel(br))} = <b>${fmt(c.dP)} m · ${kp(c.dP)} kPa</b></p>
      </div>`;
    }).join("");

    const theory = DB.THEORY.map(t => `<tr><td>${esc(t[0])}</td><td><code>${esc(t[1])}</code></td><td>${esc(t[2])}</td><td>${esc(t[3])}</td></tr>`).join("");
    const op = res.pump.op;
    const pumpSec = res.pump.fit || res.Qd > 0 ? `<h2>Σημείο λειτουργίας</h2><div class="cols"><div>${pumpChart(res)}</div><div>
        <table><tbody>
          <tr><td>Σχεδιασμός</td><td class="r num">${fmt(res.Qd, 2)} m³/h · ${fmt(res.H, 2)} m</td></tr>
          ${op ? `<tr><td>Σημείο λειτουργίας</td><td class="r num">${fmt(op.Q, 2)} m³/h · ${fmt(op.H, 2)} m</td></tr>
          <tr><td>Υδραυλική ισχύς</td><td class="r num">${fmt(op.Ph, 0)} W</td></tr>
          <tr><td>Ισχύς άξονα${isFinite(res.pump.eta) && res.pump.eta > 0 ? ` (η ${fmt(res.pump.eta * 100, 0)} %)` : ""}</td><td class="r num">${isFinite(op.Pshaft) ? fmt(op.Pshaft, 0) + " W" : "—"}</td></tr>`
          : `<tr><td>Υδραυλική ισχύς (σχεδιασμός)</td><td class="r num">${fmt(res.Ph, 0)} W</td></tr>`}
        </tbody></table></div></div>` : "";

    const warnBox = val.warns.length ? `<div class="warnbox"><b>Παρατηρήσεις</b><ul>${val.warns.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : "";
    const date = m.date ? new Date(m.date).toLocaleDateString("el-GR") : "";

    const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>Αναφορά κυκλοφορητή — ${esc(m.name)}</title>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
      <style>${REPORT_CSS}</style></head><body>
      <header class="rep"><div><h1>Υπολογισμός μανομετρικού κυκλοφορητή</h1><div>${esc(m.name)}${m.code ? " · " + esc(m.code) : ""}</div></div>
        <div class="meta">Ημερομηνία: <b>${esc(date)}</b><br>${m.engineer ? `Μηχανικός: <b>${esc(m.engineer)}</b><br>` : ""}Ρευστό: <b>${esc(fp.label)} · ${esc(project.waterTemp)} °C</b></div></header>
      <div class="kpis">
        <div class="kpi main"><div class="l">Μανομετρικό H</div><div class="v">${fmt(res.H, 2)} m</div><div class="s">${kp(res.H)} kPa</div></div>
        <div class="kpi"><div class="l">Παροχή σημείου λειτουργίας</div><div class="v">${fmt(res.Qd, 2)} m³/h</div><div class="s">${fmt(res.Qd / 3.6, 3)} l/s</div></div>
        <div class="kpi"><div class="l">Υδραυλική ισχύς</div><div class="v">${fmt(res.Ph, 0)} W</div><div class="s">ρ·g·Q·H</div></div>
        <div class="kpi"><div class="l">Ρευστό</div><div class="v" style="font-size:10pt">${esc(fp.label)}</div><div class="s">ν ${fmt(fp.nu * 1e6, 3)}e-6 · ρ ${fmt(fp.rho, 0)}${project.aged ? " · παλαιό δίκτυο" : ""}</div></div>
      </div>
      <h2>Σχηματισμός H</h2>
      <table><thead><tr><th></th><th class="r">m</th><th class="r">kPa</th></tr></thead><tbody>${hRows}</tbody></table>
      <h2>Κλάδοι</h2>
      <table><thead><tr><th>Κλάδος</th><th>Περιγραφή</th><th>Σωλήνας</th><th class="r">L [m]</th><th class="r">Q [m³/h]</th><th class="r">v [m/s]</th><th class="r">R [Pa/m]</th><th class="r">ΔP [m]</th><th>Δυσμ.</th></tr></thead><tbody>${sumRows}</tbody></table>
      ${res.circuits.length > 1 ? `<h2>Κυκλώματα και εξισορρόπηση</h2>
      <table><thead><tr><th>Κύκλωμα</th><th>Τερματικό</th><th>Διαδρομή</th><th class="r">ΔP [m]</th><th class="r">ΔP [kPa]</th><th class="r">Περίσσεια [kPa]</th><th class="r">Kv εξισ.</th></tr></thead><tbody>${circRows}</tbody></table>` : ""}
      ${warnBox}
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
  }
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("DOMContentLoaded", init);
})();
