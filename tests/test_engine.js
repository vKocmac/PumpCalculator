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

const setF = (fluid, concPct, waterTemp) => E.setProject(E.normalize({ meta: {}, fluid, concPct, waterTemp, marginPct: 0, extras: [], branches: [] }));
// Γλυκόλη: πίνακες ανά θερμοκρασία (Melinder/IIR μέσω CoolProp). Τιμές αναφοράς CoolProp 8.0 εκτός κόμβων:
const ref = [
  ["pg", 35, 7, 6.198885e-6, 1034.302, 3.746948],
  ["pg", 35, 45, 1.578813e-6, 1013.729, 3.858703],
  ["eg", 25, 15, 2.137374e-6, 1032.786, 3.798815],
  ["pg", 30, -5, 8.975519e-6, 1033.024, 3.788966]
];
ref.forEach(([f, c, T, nu, rho, cp]) => {
  setF(f, c, T); const p = E.fluidProps();
  truthy(`${f.toUpperCase()} ${c}% ${T}°C: ν εντός +0…+5% του CoolProp (${(100 * (p.nu / nu - 1)).toFixed(1)}%)`, p.nu >= nu * 0.995 && p.nu <= nu * 1.05);
  close(`${f.toUpperCase()} ${c}% ${T}°C: ρ`, p.rho, rho, 5e-3);
  close(`${f.toUpperCase()} ${c}% ${T}°C: cp`, p.cp, cp, 5e-3);
});
setF("pg", 30, 10);
close("PG 30% 10°C κόμβος πίνακα: ν = ν_νερού·3.216", E.fluidProps().nu, E.nuWater(10) * 3.216, 1e-9);
setF("pg", 0, 45);
close("PG 0% = νερό", E.fluidProps().nu, E.nuWater(45), 1e-12);
setF("pg", 99, 45);
close("PG >60% → όριο 60%", E.fluidProps().nu, E.nuWater(45) * (6.016 + 5.293) / 2, 1e-9);
truthy("PG >60% → προειδοποίηση εκτός πίνακα", E.fluidProps().clamped);
setF("pg", 30, -15);
truthy("PG 30% −15°C (πήξη −12.8) → frozen", E.fluidProps().frozen);
truthy("… και σφάλμα validation", E.validate(E.calcProject()).errors.some(e => e.includes("σημείο πήξης")));
setF("water", 0, -2);
truthy("Νερό −2°C → frozen", E.fluidProps().frozen);
setF("water", 0, 45);
close("Νερό 45°C ρ (πίνακας 40…50)", E.fluidProps().rho, (992.3 + 988.1) / 2, 1e-9);

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
close("Σ σταθερών απωλειών", r.sumExtras, 2.09, 1e-12);
truthy("Παλιό αρχείο → ένα κύκλωμα L1…L5 σε σειρά", r.circuits.length === 1 && r.circuits[0].ids.length === 5);
close("Παροχή αντλίας = Q του L1", r.Qd, 4.2, 1e-12);
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

/* =========================== 6. Τριβή: στρωτή / μεταβατική =========================== */
console.log("\n[6] Στρωτή και μεταβατική ροή");
close("Re=1000 → λ=64/Re", E.friction(1000, 0, 32.72), 0.064, 1e-12);
close("Re=2300 συνέχεια με 64/Re", E.friction(2300, 0, 32.72), 64 / 2300, 1e-9);
const sj4000 = 0.25 / Math.pow(Math.log10(0 + 5.74 / Math.pow(4000, 0.9)), 2);
close("Re=4000 = Swamee-Jain", E.friction(4000, 0, 32.72), sj4000, 1e-9);
close("Re=3150 στη μέση της μετάβασης", E.friction(3150, 0, 32.72), (64 / 2300 + sj4000) / 2, 1e-9);

/* =========================== 7. Δίκτυο με παράλληλους κλάδους =========================== */
console.log("\n[7] Δίκτυο: δυσμενέστερο κύκλωμα, Π+Ε, εξισορρόπηση");
const B = (id, parent, kind, Q, size, L, extra = {}) => ({ id, code: id, desc: "", kind, parent, Q, loadKW: "", pipeFamily: fam, pipeSize: size, length: L, fittings: [], equip: [], ...extra });
E.setProject(E.normalize({
  meta: {}, fluid: "water", concPct: 0, waterTemp: 45, marginPct: 10, dT: 5, extras: [{ label: "Εναλλάκτης", dP: 20, unit: "kPa" }],
  branches: [B("A", null, "t", 4, "Φ50", 10), B("B", "A", "pe", 2.5, "Φ40", 20), B("C", "A", "pe", 1.5, "Φ32", 30, { equip: [{ label: "FCU", dP: 15, unit: "kPa" }] })]
}));
const rn = E.calcProject();
const dA = rn.cById.get("A").c.dP, dB = rn.cById.get("B").c.dP, dC = rn.cById.get("C").c.dP;
truthy("2 κυκλώματα (A›B, A›C)", rn.circuits.length === 2);
const worstDP = Math.max(dA + dB, dA + dC);
close("Δυσμενέστερο = max διαδρομής", rn.sumBranches, worstDP, 1e-12);
truthy("Δυσμενέστερο = A›C (μακρύτερο, μικρότερη διατομή, FCU)", rn.worst.leaf === "C");
const fpw = rn.fp, extraM = 20 * 1000 / (fpw.rho * 9.81);
close("kPa → m με ρ του ρευστού", rn.sumExtras, extraM, 1e-12);
close("H = (δυσμ. + εξοπλ.)·1.10", rn.H, (worstDP + extraM) * 1.1, 1e-12);
close("Παροχή αντλίας = Q ρίζας", rn.Qd, 4, 1e-12);
const cB = rn.circuits.find(c => c.leaf === "B");
close("Περίσσεια A›B για εξισορρόπηση", cB.excess, (dA + dC) - (dA + dB), 1e-12);
close("Kv εξισορρόπησης = Q/√ΔP[bar]", cB.kvReq, 2.5 / Math.sqrt(cB.excessKPa / 100), 1e-12);
close("Π+Ε: L διπλάσιο (B 2×20 m)", rn.cById.get("B").c.pipe.Leff, 40, 1e-12);
close("Εξοπλισμός κλάδου σε m", rn.cById.get("C").c.sumEquip, 15 * 1000 / (fpw.rho * 9.81), 1e-12);
truthy("Ισοζύγιο: 2.5+1.5 = Q του A → χωρίς προειδοποίηση", !E.validate(rn).warns.some(w => w.includes("αθροίζουν")));
E.getProject().branches[1].Q = 3;
truthy("Ισοζύγιο: 3+1.5 ≠ 4 → προειδοποίηση", E.validate(E.calcProject()).warns.some(w => w.includes("αθροίζουν")));
E.getProject().openCircuit = true; E.getProject().staticHead = 5; E.getProject().branches[1].Q = 2.5;
close("Ανοιχτό κύκλωμα: + στατικό μετά την προσαύξηση", E.calcProject().H, (worstDP + extraM) * 1.1 + 5, 1e-12);

/* =========================== 8. Παροχή από φορτίο, διατομή εξαρτήματος, παλαιό δίκτυο ====== */
console.log("\n[8] Q από φορτίο, διατομή εξαρτήματος, παλαιό δίκτυο");
E.setProject(E.normalize({ meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, dT: 5, extras: [],
  branches: [B("X", null, "t", "", "Φ40", 10, { loadKW: 20, fittings: [{ type: "Συστολή", size: "Φ25", qty: 1, zeta: 0.5, kv: "" }] })] }));
const rx = E.calcProject(), fx = rx.fp, cx = rx.cById.get("X").c;
close("Q = 3600·P/(ρ·cp·ΔT)", cx.Q, 3600 * 20 / (fx.rho * fx.cp * 5), 1e-12);
const vF = (cx.Q / 3600) / (Math.PI * 0.02046 * 0.02046 / 4);
close("Εξάρτημα σε Φ25: ζ με την ταχύτητα της Φ25", cx.fittings[0].total, 0.5 * vF * vF / (2 * 9.81), 1e-9);
truthy("… και όχι με του σωλήνα Φ40", cx.fittings[0].v > cx.pipe.v * 2);
const newDP = cx.pipe.dP;
E.setProject(E.normalize({ meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, aged: true, extras: [],
  branches: [B("S", null, "t", 3, "DN32", 20, { pipeFamily: "Σιδηροσωλήνας (μαύρος)" })] }));
const agedC = E.calcProject().cById.get("S").c.pipe;
truthy("Παλαιό δίκτυο: k σιδηροσωλήνα 0.2 mm", agedC.k === 0.2);
E.getProject().aged = false;
const newC = E.calcProject().cById.get("S").c.pipe;
truthy("Παλαιό δίκτυο → μεγαλύτερη ΔP (" + (100 * (agedC.dP / newC.dP - 1)).toFixed(0) + "%)", agedC.dP > newC.dP * 1.05);

/* =========================== 9. Μετάβαση παλιού ονόματος & κωδικοί =========================== */
console.log("\n[9] Παλιά αρχεία");
const old = E.normalize({ branches: [{ name: "L1 — Σιδηροσωλήνας λεβητοστασίου", Q: 1, pipeFamily: fam, pipeSize: "Φ40", length: 1 }, { name: "L2", Q: 1, pipeFamily: fam, pipeSize: "Φ40", length: 1 }] });
truthy("«L1 — Σιδηροσωλήνας…» → κωδικός L1", old.branches[0].code === "L1");
truthy("… περιγραφή «Σιδηροσωλήνας λεβητοστασίου»", old.branches[0].desc === "Σιδηροσωλήνας λεβητοστασίου");
truthy("Παλιό αρχείο → αλυσίδα, συνολικό μήκος", old.branches[1].parent === old.branches[0].id && old.branches[1].kind === "t");
E.setProject(E.normalize({ branches: [{ code: "L1", parent: null }, { code: "L3", parent: null }] }));
truthy("Νέος κωδικός μετά από L1, L3 = L4 (όχι διπλός)", E.nextCode() === "L4");

/* =========================== 10. Αντλία, βάνες =========================== */
console.log("\n[10] Αντλία και βάνες");
const pf = E.fitPump([{ Q: 0, H: 16 }, { Q: 4, H: 14 }, { Q: 7, H: 9 }]);
close("Καμπύλη αντλίας περνά από τα σημεία (Q=4)", pf.H(4), 14, 1e-9);
close("Καμπύλη αντλίας περνά από τα σημεία (Q=7)", pf.H(7), 9, 1e-9);
const op = E.opPoint(pf, 0, 12 / 16);   // δίκτυο 12 m στα 4 m³/h
close("Σημείο λειτουργίας: H_αντλίας = H_δικτύου", op.H, 0.75 * op.Q * op.Q, 1e-9);
E.setProject(E.normalize({ meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [],
  branches: [B("V", null, "t", 1.5, "Φ32", 10, { fittings: [
    { type: "Βάνα ελέγχου 2οδη (Kv από φύλλο)", size: "", qty: 1, zeta: "", kv: 10 },
    { type: "Ρυθμιστική / εξισορρόπησης", size: "", qty: 1, zeta: "", kv: 25 }] })] }));
const rv = E.calcProject(), cv = rv.cById.get("V").c, vv = E.validate(rv);
close("Authority = ΔP_βάνας / ΔP_κλάδου", cv.ctrl.auth, cv.fittings[0].total / cv.dP, 1e-12);
truthy("Authority < 0.5 → προειδοποίηση", cv.ctrl.auth < 0.5 && vv.warns.some(w => w.includes("authority")));
truthy("Βάνα εξισορρόπησης < 3 kPa → προειδοποίηση", vv.warns.some(w => w.includes("εξισορρόπησης")));
truthy("v_max ανά διάμετρο: D 26 mm → 1.1 m/s", E.vMaxFor(26.18) === 1.1);
truthy("R > 300 Pa/m → προειδοποίηση", (() => { E.setProject(E.normalize({ meta: {}, fluid: "water", waterTemp: 45, extras: [], branches: [B("R", null, "t", 2.2, "Φ32", 10)] })); return E.validate(E.calcProject()).warns.some(w => w.includes("Pa/m")); })());

/* =========================== Σύνοψη =========================== */
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
