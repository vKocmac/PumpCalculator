/* =============================================================================
   test_engine.js — Regression tests του engine (τρέχει το ΠΡΑΓΜΑΤΙΚΟ app.js)
   Εκτέλεση:  node tests/test_engine.js   (από τον φάκελο PumpCalculator)
   Αναμενόμενες τιμές: ανεξάρτητος υπολογισμός σε Python (ίδιοι τύποι με Excel).
   ========================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---- DOM stubs ώστε να φορτώσει το app.js εκτός browser ---- */
global.window = {};
global.document = { addEventListener() { }, querySelector() { return null; }, querySelectorAll() { return []; } };
global.localStorage = { getItem() { return null; }, setItem() { }, removeItem() { } };

const dir = path.join(__dirname, "..");
eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));
const E = global.window.PumpEngine;
if (!E) { console.error("FAIL: PumpEngine δεν εκτέθηκε"); process.exit(1); }

let pass = 0, fail = 0;
function close(name, got, want, relTol = 1e-5) {
  const ok = isFinite(got) && isFinite(want) &&
    Math.abs(got - want) <= Math.max(Math.abs(want) * relTol, 1e-9);
  if (ok) { pass++; console.log(`  ✓ ${name}: ${got}`); }
  else { fail++; console.error(`  ✗ ${name}: got ${got}, want ${want}`); }
}
function truthy(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

/* =========================== 1. Ρευστά =========================== */
console.log("\n[1] Ιξώδες / ρευστά");
close("ν νερού 45°C", E.nuWater(45), 5.972631353300369e-7, 1e-12);
close("ν νερού 80°C", E.nuWater(80), 1e-6 * Math.exp(0.5842 - 0.030263 * 80 + 0.0001295 * 6400), 1e-12);

E.setProject({ meta: {}, fluid: "pg", concPct: 35, waterTemp: 45, marginPct: 0, extras: [], branches: [] });
close("ν PG 35% (interp 2.4→3.3 ⇒ ×2.85)", E.fluidProps().nu, 1.7021999356906053e-6, 1e-9);
close("SG PG 35% (interp 1.025→1.035)", E.fluidProps().sg, 1.03, 1e-9);

E.setProject({ meta: {}, fluid: "pg", concPct: 0, waterTemp: 45, marginPct: 0, extras: [], branches: [] });
close("PG 0% = νερό", E.fluidProps().nu, E.nuWater(45), 1e-12);
E.setProject({ meta: {}, fluid: "pg", concPct: 99, waterTemp: 45, marginPct: 0, extras: [], branches: [] });
close("PG >50% clamp στο 4.8×", E.fluidProps().nu, E.nuWater(45) * 4.8, 1e-12);
E.setProject({ meta: {}, fluid: "eg", concPct: 40, waterTemp: 45, marginPct: 0, extras: [], branches: [] });
close("EG 40% = ×2.3", E.fluidProps().nu, E.nuWater(45) * 2.3, 1e-12);

/* =========================== 2. Lookup σωλήνων =========================== */
console.log("\n[2] Πίνακας σωλήνων");
truthy("PPR SDR11 Φ40 → D_int 32.72, k=0",
  JSON.stringify(E.lookupPipe("PPR SDR11", "Φ40")) === JSON.stringify({ D_ext: 40, wall: 3.64, D_int: 32.72, k: 0 }));
truthy("Pexal 26×3 → D_int 20", E.lookupPipe("Pexal (πολυστρωματικός)", "26×3").D_int === 20);
truthy("Γαλβανιζέ DN50 → k=0.15", E.lookupPipe("Γαλβανιζέ", "DN50").k === 0.15);
truthy("Άγνωστη διατομή → null", E.lookupPipe("PPR SDR11", "Φ999") === null);
// Συνέπεια D_int = D_ext − 2×τοίχωμα σε ΟΛΗ τη βάση
let badGeom = [];
window.DB.PIPE_FAMILIES.forEach(f => f.sizes.forEach(s => {
  if (Math.abs(s[1] - 2 * s[2] - s[3]) > 0.011) badGeom.push(f.family + " " + s[0]);
}));
truthy("D_int = D_ext − 2t σε όλες τις " + window.DB.PIPE_FAMILIES.reduce((a, f) => a + f.sizes.length, 0) + " εγγραφές", badGeom.length === 0, badGeom.join(", "));

/* =========================== 3. Πλήρες Ιδ.1 (regression vs Excel/Python) ====== */
console.log("\n[3] Πλήρες έργο Ιδ.1 — 5 κλάδοι + worst loop 2.09");
const fam = "PPR SDR11", px = "Pexal (πολυστρωματικός)";
const z = (type, qty, zeta) => ({ type, size: "", qty, zeta, kv: "" });
const kv = (type, qty, kvv) => ({ type, size: "", qty, zeta: "", kv: kvv });
E.setProject({
  meta: { name: "Ιδ.1" }, fluid: "water", concPct: 0, waterTemp: 45, marginPct: 0,
  extras: [{ label: "ΔP_worst_loop UFH", dP: 2.09 }],
  branches: [
    { id: "L1", name: "L1", Q: 4.2, pipeFamily: fam, pipeSize: "Φ40", length: 3, fittings: [
      z("Γωνία 90°", 4, 1.2), z("Ταφ branch", 2, 1.5), z("Raccord", 4, 0.5),
      kv("Βάνα buffer", 2, 123), kv("Βάνα κυκλ.", 2, 123), z("Αντικραδ.", 2, 0.4),
      kv("Φίλτρο", 1, 16), kv("Αντεπίστροφο", 1, 33)] },
    { id: "L2", name: "L2", Q: 3.7, pipeFamily: fam, pipeSize: "Φ40", length: 46, fittings: [
      z("Γωνία 90°", 8, 1.2), z("Ταφ branch", 2, 1.5), z("Γωνία 45°", 2, 1.2)] },
    { id: "L3", name: "L3", Q: 2.82, pipeFamily: fam, pipeSize: "Φ40", length: 8, fittings: [
      z("Ταφ branch", 2, 1.5)] },
    { id: "L4", name: "L4", Q: 1.32, pipeFamily: fam, pipeSize: "Φ40", length: 8, fittings: [
      z("Γωνία 90°", 2, 1.2), z("Συστολή", 2, 0.5)] },
    { id: "L5", name: "L5", Q: 1.32, pipeFamily: px, pipeSize: "26×3", length: 16, fittings: [
      z("Μετατροπή", 2, 0.5), z("Raccord Pexal", 2, 0.3), z("Γωνία ορειχ.", 1, 1.2),
      kv("Βάνα συλλ. γων.", 1, 19), kv("Βάνα συλλ.", 1, 68)] }
  ]
});
const r = E.calcProject();
const wantV = [1.387491, 1.222314, 0.931601, 0.436069, 1.167136];
const wantL = [2.125772, 3.225454, 0.356202, 0.091482, 1.467339];
r.branches.forEach((b, i) => {
  close(`v ${b.br.name}`, b.c.pipe.v, wantV[i], 1e-5);
  close(`ΔP_${b.br.name}`, b.c.dP, wantL[i], 1e-5);
});
close("Σ καρφωτά", r.sumExtras, 2.09, 1e-12);
close("H (margin 0%)", r.H, 9.356249, 1e-5);
E.getProject().marginPct = 10;
close("H (margin 10%)", E.calcProject().H, 10.291874, 1e-5);

/* =========================== 4. ζ/Kv εναλλαγή & edge cases =================== */
console.log("\n[4] Εναλλαγή ζ/Kv & edge cases");
const v = 1.0, Q = 2.0;
truthy("Kv κενό → μέθοδος ζ", E.calcFitting({ qty: 1, zeta: 1.2, kv: "" }, v, Q).method === "ζ");
truthy("Kv=0 → μέθοδος ζ (όχι διαίρεση με 0)", E.calcFitting({ qty: 1, zeta: 1.2, kv: 0 }, v, Q).method === "ζ");
truthy("Kv>0 → μέθοδος Kv (υπερισχύει του ζ)", E.calcFitting({ qty: 2, zeta: 9, kv: 50 }, v, Q).method === "Kv");
close("ΔP_Kv = (Q/Kv)²×10.197×τεμ", E.calcFitting({ qty: 2, zeta: 9, kv: 50 }, v, Q).total, Math.pow(2 / 50, 2) * 10.197 * 2, 1e-12);
close("ΔP_ζ = ζ·v²/2g·τεμ", E.calcFitting({ qty: 3, zeta: 1.5, kv: "" }, 1.2, Q).total, 1.5 * 1.44 / (2 * 9.81) * 3, 1e-12);
close("qty 0 → ΔP 0", E.calcFitting({ qty: 0, zeta: 1.2, kv: "" }, v, Q).total, 0, 1e-12);
truthy("Q λείπει → ΔP κλάδου όχι ψεύτικος αριθμός από σωλήνα",
  !isFinite(E.calcPipe({ Q: NaN, pipeFamily: fam, pipeSize: "Φ40", length: 5 }, 6e-7).dP));

/* =========================== 5. Validation =========================== */
console.log("\n[5] Validation");
E.setProject({
  meta: {}, fluid: "water", concPct: 0, waterTemp: 45, marginPct: 0, extras: [],
  branches: [{ id: "x", name: "Lx", Q: "", pipeFamily: fam, pipeSize: "Φ40", length: "", fittings: [{ type: "T", size: "", qty: "", zeta: "", kv: "" }] }]
});
const val = E.validate(E.calcProject());
truthy("Λείπει Q → error", val.errors.some(e => e.includes("παροχή Q")));
truthy("Λείπει L → error", val.errors.some(e => e.includes("μήκος L")));
truthy("Λείπουν τεμ → error", val.errors.some(e => e.includes("τεμάχια")));
truthy("Λείπει ζ/Kv → error", val.errors.some(e => e.includes("ζ ή Kv")));
// ταχύτητα εκτός ορίων
E.setProject({
  meta: {}, fluid: "water", concPct: 0, waterTemp: 45, marginPct: 0, extras: [],
  branches: [{ id: "y", name: "Ly", Q: 20, pipeFamily: fam, pipeSize: "Φ25", length: 5, fittings: [] }]
});
truthy("v>2 m/s → warning", E.validate(E.calcProject()).warns.some(w => w.includes("υψηλή ταχύτητα")));

/* =========================== Σύνοψη =========================== */
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
