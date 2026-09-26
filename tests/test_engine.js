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

/* =========================== 7. Παλιό «δίκτυο» (δέντρο) → σημεία και σωλήνες =========================== */
console.log("\n[7] Παλιό δίκτυο κλάδων → νέο δίκτυο, ίδιο H");
const B = (id, parent, kind, Q, size, L, extra = {}) => ({ id, code: id, desc: "", kind, parent, Q, loadKW: "", pipeFamily: fam, pipeSize: size, length: L, fittings: [], equip: [], ...extra });
E.setProject(E.normalize({
  meta: {}, fluid: "water", concPct: 0, waterTemp: 45, marginPct: 10, dT: 5, extras: [{ label: "Εναλλάκτης", dP: 20, unit: "kPa" }],
  branches: [B("A", null, "t", 4, "Φ50", 10), B("B", "A", "pe", 2.5, "Φ40", 20), B("C", "A", "pe", 1.5, "Φ32", 30, { equip: [{ label: "FCU", dP: 15, unit: "kPa" }] })]
}));
const rn = E.calcProject();
truthy("Παλιό αρχείο με διακλάδωση → τρόπος δικτύου, κλειστό", rn.mode === "network" && rn.topoErr.length === 0);
const dA = rn.ecById.get("A").c.dP, dB = rn.ecById.get("B").c.dP, dC = rn.ecById.get("C").c.dP;
const worstDP = Math.max(dA + dB, dA + dC);
const fpw = rn.fp, extraM = 20 * 1000 / (fpw.rho * 9.81);
close("H = (δυσμ. + εναλλάκτης)·1.10 — όπως πριν", rn.H, (worstDP + extraM) * 1.1, 1e-12);
truthy("2 διαδρομές, δυσμενέστερη μέσω C", rn.paths.length === 2 && rn.worst.edges.includes("C"));
close("Παροχή αντλίας = 4", rn.Qd, 4, 1e-12);
const pB = rn.paths.find(p => p.edges.includes("B"));
close("Στραγγαλισμός διαδρομής B", pB.excess, (dA + dC) - (dA + dB), 1e-12);
close("Kv εξισορρόπησης = Q·√(SG/ΔP[bar]) (Q του κλάδου 2.5, SG = ρ/1000)", pB.kvReq, 2.5 * Math.sqrt((E.fluidProps().rho / 1000) / (pB.excessKPa / 100)), 1e-9);
close("Π+Ε: L διπλάσιο (B 2×20 m)", rn.ecById.get("B").c.pipe.Leff, 40, 1e-12);
close("Εξοπλισμός σωλήνα σε m", rn.ecById.get("C").c.sumEquip, 15 * 1000 / (fpw.rho * 9.81), 1e-12);
truthy("Ισοζύγιο 2.5+1.5 = 4 → χωρίς σφάλμα", !E.validate(rn).errors.length);
E.getProject().net.edges.find(e => e.id === "B").Q = 3;
truthy("B = 3 → σφάλμα ισοζυγίου «μπαίνουν 4, βγαίνουν 4.5»", E.validate(E.calcProject()).errors.some(w => w.includes("μπαίνουν 4.00") && w.includes("βγαίνουν 4.50")));
truthy("… και H προσωρινό", E.calcProject().provisional);
E.getProject().net.edges.find(e => e.id === "B").Q = 2.5;
E.getProject().openCircuit = true; E.getProject().staticHead = 5;
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

/* =========================== 11. Δίκτυο: ανεξάρτητος έλεγχος =========================== */
console.log("\n[11] Δίκτυο — 300 τυχαία κλειστά δίκτυα (προσαγωγή + επιστροφή), ανεξάρτητος έλεγχος");
const Nd = (id, type, extra = {}) => ({ id, type, label: id, dP: "", unit: "kPa", Q: "", loadKW: "", ...extra });
const Pp = (id, from, to, size, L, extra = {}) => ({ id, code: id, desc: "", from, to, pipeFamily: fam, pipeSize: size, length: L, fittings: [], equip: [], Q: "", loadKW: "", kind: "t", direct: false, ...extra });
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const sizes = ["Φ25", "Φ32", "Φ40", "Φ50", "Φ63"];
let okNets = 0; const badNets = [];
for (let n = 0; n < 300; n++) {
  // Δέντρο προσαγωγής από τον κόμβο S0, καθρέφτης στην επιστροφή R0, τερματικά με Q
  const nodes = [Nd("P", "pump")], edges = [], term = [], parentOf = {};
  let k = 1; const nid = p => p + (k++);
  if (rnd() < 0.5) nodes.push(Nd("CH", "chiller", { dP: +(10 + rnd() * 40).toFixed(1) }));
  const first = nodes.length > 1 ? "CH" : "P";
  nodes.push(Nd("S0", "junction"), Nd("R0", "junction"));
  if (first === "CH") edges.push(Pp("eP", "P", "CH", pick(sizes), 3));
  edges.push(Pp("eS0", first, "S0", "Φ63", +(2 + rnd() * 20).toFixed(1)));
  edges.push(Pp("eR0", "R0", "P", "Φ63", +(2 + rnd() * 20).toFixed(1)));
  const grow = (s, r, depth) => {
    const nk = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < nk; i++) {
      if (depth < 2 && rnd() < 0.4) {
        const s2 = nid("S"), r2 = nid("R");
        nodes.push(Nd(s2, "junction"), Nd(r2, "junction"));
        edges.push(Pp("e" + s2, s, s2, pick(sizes), +(1 + rnd() * 25).toFixed(1)), Pp("e" + r2, r2, r, pick(sizes), +(1 + rnd() * 25).toFixed(1)));
        parentOf[r2] = s2; grow(s2, r2, depth + 1);
      } else {
        const t2 = nid("T"), q = +(0.3 + rnd() * 2.5).toFixed(2);
        nodes.push(Nd(t2, "fcu", { Q: q, dP: rnd() < 0.7 ? +(5 + rnd() * 30).toFixed(1) : "" }));
        edges.push(Pp("s" + t2, s, t2, pick(sizes), +(1 + rnd() * 25).toFixed(1), rnd() < 0.5 ? { fittings: [{ type: "Γωνία", size: "", qty: 1 + Math.floor(rnd() * 6), zeta: 1.2, kv: "" }] } : {}));
        edges.push(Pp("r" + t2, t2, r, pick(sizes), +(1 + rnd() * 25).toFixed(1)));
        term.push({ id: t2, q });
      }
    }
  };
  grow("S0", "R0", 0);
  const marg = Math.floor(rnd() * 20);
  E.setProject(E.normalize({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: marg, extras: [], branches: [], net: { nodes, edges } }));
  const rr = E.calcProject();
  // (α) παροχές: κάθε σωλήνας = Σ τερματικών «από κάτω» — υπολογισμός από τη δομή του γεννήτορα
  const sub = {}; // παροχή υποδέντρου κάθε κόμβου S/R
  const edgeQ = {};
  const tot = term.reduce((a, t2) => a + t2.q, 0);
  // σωλήνες τερματικών
  term.forEach(t2 => { edgeQ["s" + t2.id] = t2.q; edgeQ["r" + t2.id] = t2.q; });
  // σωλήνες διακλαδώσεων: άθροισμα των τερματικών που κρέμονται από κάτω (μέσω ονομάτων)
  const qSub = s => { let q = 0; edges.filter(e => e.from === s).forEach(e => { if (e.id.startsWith("s")) q += edgeQ[e.id]; else q += qSub(e.to); }); return q; };
  edges.forEach(e => { if (e.id.startsWith("eS") && e.id !== "eS0") edgeQ[e.id] = qSub(e.to); });
  edges.forEach(e => { if (e.id.startsWith("eR") && e.id !== "eR0") edgeQ[e.id] = qSub(parentOf[e.id.slice(1)]); });
  edgeQ.eS0 = tot; edgeQ.eR0 = tot; if (edgeQ.eP === undefined) edgeQ.eP = tot;
  const qOk = edges.every(e => Math.abs(rr.ecById.get(e.id).c.Q - edgeQ[e.id]) < 1e-9);
  // (β) H: απαρίθμηση διαδρομών με αναδρομή πάνω στη λίστα σωλήνων (όχι του προγράμματος)
  const nodeM = id => { const nd = nodes.find(x => x.id === id); return nd.dP === "" ? 0 : nd.dP * 1000 / (rr.fp.rho * 9.81); };
  let best = -1, cnt = 0;
  const dfs = (u, s) => edges.filter(e => e.from === u).forEach(e => { const s2 = s + rr.ecById.get(e.id).c.dP; if (e.to === "P") { cnt++; best = Math.max(best, s2); } else dfs(e.to, s2 + nodeM(e.to)); });
  dfs("P", 0);
  const ok = qOk && Math.abs(rr.sumBranches - best) < 1e-9 && Math.abs(rr.H - best * (1 + marg / 100)) < 1e-9 && cnt === term.length
    && rr.paths.length === term.length && !rr.provisional && Math.abs(rr.Qd - tot) < 1e-9 && !E.validate(rr).errors.length;
  if (ok) okNets++; else badNets.push(n);
  const svg = E.schematicNet(rr, true, 900).svg;
  if (!edges.every(e => svg.includes(`>${e.id}<`)) || svg.includes("NaN")) badNets.push("svg" + n);
  const svgL = (E.getProject().draw = "line", E.schematicNet(rr, true, 900).svg); E.getProject().draw = "u";
  if (svgL.includes("NaN")) badNets.push("svgL" + n);
}
truthy(`300/300 δίκτυα: παροχές από ισοζύγιο, H, δυσμενέστερη, Q αντλίας (${okNets} σωστά)`, badNets.length === 0, badNets.slice(0, 5).join(","));

console.log("\n[12] Αντίστροφη επιστροφή, ανοιχτό κύκλωμα, σφάλματα σύνδεσης");
// Tichelmann: συλλέκτης προσαγωγής s1→s2→s3, επιστροφής r1→r2→r3→αντλία
{
  const nodes = [Nd("P", "pump"), Nd("s1", "junction"), Nd("s2", "junction"), Nd("s3", "junction"), Nd("r1", "junction"), Nd("r2", "junction"), Nd("r3", "junction"),
    Nd("T1", "fcu", { Q: 1, dP: 20 }), Nd("T2", "fcu", { Q: 1.5, dP: 20 }), Nd("T3", "fcu", { Q: 2, dP: 20 })];
  const edges = [Pp("a", "P", "s1", "Φ50", 5), Pp("b", "s1", "s2", "Φ40", 10), Pp("c", "s2", "s3", "Φ32", 10),
    Pp("t1", "s1", "T1", "Φ25", 3), Pp("u1", "T1", "r1", "Φ25", 3), Pp("t2", "s2", "T2", "Φ25", 3), Pp("u2", "T2", "r2", "Φ25", 3), Pp("t3", "s3", "T3", "Φ25", 3), Pp("u3", "T3", "r3", "Φ32", 3),
    Pp("d", "r1", "r2", "Φ32", 10), Pp("e", "r2", "r3", "Φ40", 10), Pp("f", "r3", "P", "Φ50", 25)];
  E.setProject(E.normalize({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [], net: { nodes, edges } }));
  const rt = E.calcProject(), q = id => rt.ecById.get(id).c.Q;
  truthy("Tichelmann: παροχές από ισοζύγιο (b 3.5, c 2, d 1, e 2.5, f 4.5)", [["b", 3.5], ["c", 2], ["d", 1], ["e", 2.5], ["f", 4.5]].every(([k2, v]) => Math.abs(q(k2) - v) < 1e-12));
  const dp = id => rt.ecById.get(id).c.dP, fm = 20 * 1000 / (rt.fp.rho * 9.81);
  const p1 = dp("a") + dp("t1") + fm + dp("u1") + dp("d") + dp("e") + dp("f"), p2 = dp("a") + dp("b") + dp("t2") + fm + dp("u2") + dp("e") + dp("f"), p3 = dp("a") + dp("b") + dp("c") + dp("t3") + fm + dp("u3") + dp("f");
  close("Tichelmann: H = max των 3 διαδρομών", rt.H, Math.max(p1, p2, p3), 1e-12);
}
// Ανοιχτό κύκλωμα: δεξαμενή → αναρρόφηση → αντλία → πύργος (ανοιχτό άκρο)
{
  const nodes = [Nd("TK", "tank"), Nd("P", "pump"), Nd("CT", "other", { dP: 15 })];
  const edges = [Pp("s", "TK", "P", "Φ63", 4, { Q: 10 }), Pp("d", "P", "CT", "Φ50", 40)];
  E.setProject(E.normalize({ mode: "network", openCircuit: true, staticHead: 8, meta: {}, fluid: "water", waterTemp: 30, marginPct: 0, extras: [], branches: [], net: { nodes, edges } }));
  const ro = E.calcProject(), fm = 15 * 1000 / (ro.fp.rho * 9.81);
  truthy("Ανοιχτό: πύργος = ανοιχτό άκρο, χωρίς σφάλμα «δεν επιστρέφει»", ro.nodes.find(x => x.n.id === "CT").openEnd && !E.validate(ro).errors.length);
  close("Ανοιχτό: Q κατάθλιψης από ισοζύγιο αντλίας = 10", ro.ecById.get("d").c.Q, 10, 1e-12);
  close("Ανοιχτό: H = κατάθλιψη + πύργος + αναρρόφηση + στατικό", ro.H, ro.ecById.get("d").c.dP + fm + ro.ecById.get("s").c.dP + 8, 1e-12);
  E.getProject().openCircuit = false;
  truthy("Ίδιο δίκτυο ως κλειστό → «δεν επιστρέφει στην αντλία»", E.validate(E.calcProject()).errors.some(x => x.includes("δεν επιστρέφει")));
}
// Σφάλματα
{
  const base = () => ({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [] });
  E.setProject(E.normalize({ ...base(), net: { nodes: [Nd("A", "junction"), Nd("B", "fcu", { Q: 1 })], edges: [Pp("x", "A", "B", "Φ25", 5)] } }));
  truthy("Χωρίς αντλία → σφάλμα", E.validate(E.calcProject()).errors.some(x => x.includes("Δεν υπάρχει αντλία")));
  E.setProject(E.normalize({ ...base(), net: { nodes: [Nd("P", "pump"), Nd("P2", "pump"), Nd("A", "junction")], edges: [Pp("x", "P", "A", "Φ25", 5, { Q: 1 }), Pp("y", "A", "P", "Φ25", 5)] } }));
  truthy("Δεύτερη αντλία χωρίς σωλήνες → σφάλμα στην αντλία", E.validate(E.calcProject()).errors.some(x => x.includes("P2: δεν έχει σωλήνα εξόδου")));
  E.setProject(E.normalize({ ...base(), net: { nodes: [Nd("P", "pump"), Nd("A", "junction"), Nd("B", "junction")],
    edges: [Pp("x", "P", "A", "Φ25", 5, { Q: 1 }), Pp("y", "A", "B", "Φ25", 5), Pp("z", "B", "A", "Φ25", 5), Pp("w", "B", "P", "Φ25", 5)] } }));
  truthy("Κυκλική ροή εκτός αντλίας → σφάλμα", E.validate(E.calcProject()).errors.some(x => x.includes("Κυκλική ροή")));
  E.setProject(E.normalize({ ...base(), net: { nodes: [Nd("P", "pump"), Nd("A", "junction")], edges: [Pp("x", "P", "A", "Φ25", 5), Pp("y", "A", "P", "Φ25", 5)] } }));
  truthy("Κανένα Q πουθενά → «λείπει η παροχή», H προσωρινό", E.validate(E.calcProject()).errors.some(x => x.includes("παροχή Q")) && E.calcProject().provisional);
  E.setProject(E.normalize({ ...base(), net: { nodes: [Nd("P", "pump"), Nd("B", "buffer", { dP: 1 }), Nd("A", "junction")],
    edges: [Pp("x", "P", "B", "Φ25", 5, { Q: 1 }), Pp("y", "B", "A", "Φ25", 5), Pp("y2", "B", "A", "Φ25", 5, { Q: 0.5 }), Pp("w", "A", "P", "Φ25", 5)] } }));
  truthy("Buffer μέσα σε μία ζώνη (μία αντλία) → κανονικό σημείο, ισοζύγιο 1 = 0.5 + 0.5", (() => { const r = E.calcProject(); return !E.validate(r).errors.length && Math.abs(r.ecById.get("y").c.Q - 0.5) < 1e-12; })());
}
// Ελλιπής σωλήνας: εκτός δυσμενέστερης
{
  const nodes = [Nd("P", "pump"), Nd("S", "junction"), Nd("R", "junction"), Nd("T1", "fcu", { Q: 1 }), Nd("T2", "fcu", { Q: 1 })];
  const edges = [Pp("a", "P", "S", "Φ40", 5), Pp("t1", "S", "T1", "Φ25", 5), Pp("u1", "T1", "R", "Φ25", 5), Pp("t2", "S", "T2", "Φ20", "", { fittings: [{ type: "Γωνία", size: "", qty: 40, zeta: 1.2, kv: "" }] }), Pp("u2", "T2", "R", "Φ25", 5), Pp("b", "R", "P", "Φ40", 5)];
  E.setProject(E.normalize({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [], net: { nodes, edges } }));
  const ri = E.calcProject();
  truthy("Ελλιπής t2 (χωρίς μήκος) → εκτός δυσμενέστερης, παρότι μεγαλύτερη", ri.worst.edges.includes("t1") && ri.paths.find(p => p.edges.includes("t2")).dP > ri.worst.dP);
  truthy("… H προσωρινό", ri.provisional);
}

console.log("\n[13] Μετατροπές απλή ↔ δίκτυο (ίδιο H)");
{
  const chain = () => [B("c1", null, "t", 3, "Φ50", 6, { fittings: [{ type: "Γωνία", size: "", qty: 4, zeta: 1.2, kv: "" }] }), B("c2", "c1", "pe", 3, "Φ40", 20), B("c3", "c2", "pe", 3, "Φ32", 12, { equip: [{ label: "FCU", dP: 20, unit: "kPa" }] })];
  E.setProject(E.normalize({ mode: "simple", meta: {}, fluid: "water", waterTemp: 45, marginPct: 10, extras: [{ label: "Ψύκτης", dP: 30, unit: "kPa" }], start: { type: "Εναλλάκτης", label: "", dP: 12, unit: "kPa" }, branches: chain() }));
  const h0 = E.calcProject().H;
  truthy("Απλή → δίκτυο επιτρέπεται", E.setMode("network").ok && E.getProject().mode === "network");
  const rN = E.calcProject();
  close("… ίδιο H (αρχή και ψύκτης έγιναν εξοπλισμός)", rN.H, h0, 1e-12);
  truthy("… κλειστό, χωρίς σφάλματα", !E.validate(rN).errors.length);
  truthy("Δίκτυο → απλή επιτρέπεται (ένας βρόχος)", E.setMode("simple").ok && E.getProject().mode === "simple");
  close("… ίδιο H", E.calcProject().H, h0, 1e-12);
  // Ιδ.1 (παροχές που μειώνονται χωρίς να σχεδιάζονται οι απορροές) → στο δίκτυο φαίνεται το ισοζύγιο
  E.setProject(E.normalize({ mode: "simple", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [B("i1", null, "t", 4.2, "Φ40", 3), B("i2", "i1", "t", 3.7, "Φ40", 46)] }));
  E.setMode("network");
  truthy("Αλυσίδα 4.2 → 3.7 στο δίκτυο → σφάλμα ισοζυγίου (λείπει απορροή 0.5)", E.validate(E.calcProject()).errors.some(x => x.includes("μπαίνουν 4.20") && x.includes("βγαίνουν 3.70")));
  E.setProject(E.normalize({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [],
    net: { nodes: [Nd("P", "pump"), Nd("S", "junction"), Nd("R", "junction")], edges: [Pp("a", "P", "S", "Φ40", 5, { Q: 2 }), Pp("b", "S", "R", "Φ25", 5, { Q: 1 }), Pp("c", "S", "R", "Φ25", 5), Pp("d", "R", "P", "Φ40", 5)] } }));
  truthy("Δίκτυο με παράλληλους → απλή απορρίπτεται, δεδομένα ίδια", !E.setMode("simple").ok && E.getProject().mode === "network" && E.getProject().net.edges.length === 4);
  truthy("Κενό έργο → δίκτυο: μόνο η αντλία", (() => { E.setProject(E.normalize({ mode: "simple", meta: {}, branches: [], extras: [] })); E.setMode("network"); const n2 = E.getProject().net; return n2.nodes.length === 1 && n2.nodes[0].type === "pump" && !n2.edges.length; })());
}

/* =========================== 15. Επεξεργασία δικτύου =========================== */
console.log("\n[15] Παρεμβολή, διαγραφή ενδιάμεσου, αναίρεση");
{
  const base = () => ({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [],
    net: { nodes: [Nd("P", "pump"), Nd("A", "chiller", { dP: 30 }), Nd("F", "fcu", { dP: 20, Q: 2 })],
      edges: [Pp("a", "P", "A", "Φ40", 10, { fittings: [{ type: "Γωνία", size: "", qty: 2, zeta: 1.2, kv: "" }] }), Pp("b", "A", "F", "Φ40", 6), Pp("c", "F", "P", "Φ32", 12)] } });
  E.setProject(E.normalize(base()));
  const h0 = E.calcProject().H;
  // Παρεμβολή κόμβου στον a, μετά μοίρασμα του μήκους 10 → 4 + 6: ίδιο H
  E.insertOnEdge("a", "junction");
  let pr = E.getProject(), a = pr.net.edges.find(e => e.id === "a"), a2 = pr.net.edges[pr.net.edges.indexOf(a) + 1];
  truthy("Παρεμβολή: 4 σημεία, 4 σωλήνες, a → νέο → A", pr.net.nodes.length === 4 && pr.net.edges.length === 4 && a2.from === a.to && a2.to === "A" && a2.pipeSize === "Φ40" && a2.length === "");
  truthy("… ο νέος σωλήνας χωρίς μήκος → H προσωρινό", E.calcProject().provisional === true);
  a.length = 4; a2.length = 6;
  close("… μήκος 4 + 6 = 10 → ίδιο H", E.calcProject().H, h0, 1e-12);
  // Διαγραφή του ενδιάμεσου κόμβου → οι δύο σωλήνες ενώνονται, ίδιο H
  E.delNode(a.to);
  pr = E.getProject();
  truthy("Διαγραφή κόμβου: 3 σωλήνες, ο a ξανά P → A με L 10 και τα εξαρτήματά του", pr.net.edges.length === 3 && pr.net.edges.find(e => e.id === "a").to === "A" && +pr.net.edges.find(e => e.id === "a").length === 10 && pr.net.edges.find(e => e.id === "a").fittings.length === 1);
  close("… ίδιο H", E.calcProject().H, h0, 1e-12);
  // Διαγραφή εξοπλισμού ανάμεσα σε ίδιους σωλήνες (ψύκτης Φ40/Φ40) → ένας σωλήνας 16 m, H − 30 kPa
  const fp = E.fluidProps();
  E.delNode("A");
  pr = E.getProject();
  truthy("Διαγραφή ψύκτη: a (Φ40) + b (Φ40) → ένας σωλήνας 16 m", pr.net.edges.length === 2 && +pr.net.edges.find(e => e.id === "a").length === 16 && pr.net.edges.find(e => e.id === "a").to === "F");
  close("… H μειώνεται ακριβώς κατά τα 30 kPa του ψύκτη", E.calcProject().H, h0 - E.toM(30, "kPa", fp), 1e-9);
  // Αναίρεση ×3 → αρχικό δίκτυο
  E.undo(); E.undo(); E.undo();
  pr = E.getProject();
  truthy("Αναίρεση ×3 → αρχικό δίκτυο", pr.net.nodes.length === 3 && pr.net.edges.length === 3 && pr.net.edges.find(e => e.id === "a").to === "A");
  close("… αρχικό H", E.calcProject().H, h0, 1e-12);
  // Διαγραφή εξοπλισμού ανάμεσα σε διαφορετικούς σωλήνες (FCU Φ40 / Φ32) → μένει κόμβος, σωλήνες ίδιοι
  E.delNode("F");
  pr = E.getProject();
  truthy("Διαγραφή FCU ανάμεσα σε Φ40 και Φ32 → γίνεται κόμβος, οι 2 σωλήνες μένουν", pr.net.nodes.find(n => n.id === "F").type === "junction" && pr.net.edges.length === 3);
  truthy("… το κύκλωμα μένει κλειστό", !E.validate(E.calcProject()).errors.length);
  close("… H μειώνεται ακριβώς κατά τα 20 kPa του FCU", E.calcProject().H, h0 - E.toM(20, "kPa", fp), 1e-9);
  E.undo();
  pr = E.getProject();
  // Διαγραφή σωλήνα → τα υπόλοιπα μένουν· σύνδεση ξανά από το + → ίδιο H (με ίδια στοιχεία)
  const b = JSON.parse(JSON.stringify(pr.net.edges.find(e => e.id === "b")));
  E.delEdge("b");
  truthy("Διαγραφή σωλήνα b → ο FCU δεν τροφοδοτείται (σφάλμα, όχι κατάρρευση)", E.validate(E.calcProject()).errors.some(x => x.includes("τροφοδοτείται")));
  E.netAdd("A", null, "F");
  const nb = E.getProject().net.edges[E.getProject().net.edges.length - 1];
  Object.assign(nb, { pipeFamily: b.pipeFamily, pipeSize: b.pipeSize, length: b.length, kind: b.kind });
  truthy("… σύνδεση A → F από το +", nb.from === "A" && nb.to === "F");
  close("… ίδιο H", E.calcProject().H, h0, 1e-12);
}

/* =========================== 16. Πολλές αντλίες =========================== */
console.log("\n[16] Πολλές αντλίες: διαχωριστής, αντλία ανά αναχώρηση, παράλληλες, πιέσεις");
{
  const base = extra => ({ mode: "network", meta: {}, fluid: "water", waterTemp: 45, marginPct: 0, extras: [], branches: [], ...extra });
  // Πρωτεύον: P1 → a → Ψύκτης → b → SEP → c → P1.  Δευτερεύον: SEP → d → S → (P2 | P3) → FCU → R → h → SEP
  const nodes = [Nd("P1", "pump", { Q: 10 }), Nd("CH", "chiller", { dP: 30 }), Nd("SEP", "sep"), Nd("S", "header"), Nd("R", "header"),
    Nd("P2", "pump"), Nd("P3", "pump"), Nd("F1", "fcu", { Q: 5, dP: 20 }), Nd("F2", "fcu", { Q: 4, dP: 25 })];
  const edges = [Pp("a", "P1", "CH", "Φ50", 10), Pp("b", "CH", "SEP", "Φ50", 5), Pp("c", "SEP", "P1", "Φ50", 5),
    Pp("d", "SEP", "S", "Φ63", 4), Pp("e1", "S", "P2", "Φ40", 1), Pp("f1", "P2", "F1", "Φ40", 20), Pp("g1", "F1", "R", "Φ40", 20),
    Pp("e2", "S", "P3", "Φ32", 1), Pp("f2", "P3", "F2", "Φ32", 30), Pp("g2", "F2", "R", "Φ32", 30), Pp("h", "R", "SEP", "Φ63", 4)];
  const sizes = E.lookupPipe ? null : null;
  E.setProject(E.normalize(base({ net: { nodes, edges } })));
  let r = E.calcProject(), v = E.validate(r);
  truthy("Διαχωριστής: 2 ζώνες, 3 κυκλώματα αντλιών, χωρίς σφάλματα", r.zones.filter(z => z.pumps.length).length === 2 && r.circuits.length === 3 && !v.errors.length, JSON.stringify(v.errors));
  const dp = id => r.ecById.get(id).c.dP, fp = E.fluidProps(), kPa = x => E.toM(x, "kPa", fp);
  const C = id => r.circuits.find(c => c.pumpId === id);
  truthy("Παροχές ζώνης 2 από το ισοζύγιο (d = h = 9, e1 = 5, e2 = 4)", [["d", 9], ["h", 9], ["e1", 5], ["e2", 4]].every(([k, q]) => Math.abs(r.ecById.get(k).c.Q - q) < 1e-12));
  close("H P1 = a + ψύκτης + b + c", C("P1").H, dp("a") + kPa(30) + dp("b") + dp("c"), 1e-12);
  const common = dp("h") + dp("d");
  close("H P2 = f1 + FCU1 + g1 + κοινά (h, d) + e1", C("P2").H, dp("f1") + kPa(20) + dp("g1") + common + dp("e1"), 1e-12);
  close("H P3 = f2 + FCU2 + g2 + κοινά (h, d) + e2", C("P3").H, dp("f2") + kPa(25) + dp("g2") + common + dp("e2"), 1e-12);
  truthy("Q αντλιών: P1 10, P2 5, P3 4", Math.abs(C("P1").Qd - 10) < 1e-12 && Math.abs(C("P2").Qd - 5) < 1e-12 && Math.abs(C("P3").Qd - 4) < 1e-12);
  truthy("Η P2 «βλέπει» τα κοινά (d, h) αλλά όχι τον κλάδο της P3", C("P2").eset.has("d") && C("P2").eset.has("h") && !C("P2").eset.has("f2") && !C("P2").eset.has("a"));
  // Δοχείο διαστολής στον διαχωριστή → αναρρόφηση P1 = −c, αναρρόφηση P2/P3 = −(d + max(e1, e2))
  E.getProject().net.nodes.find(n => n.id === "SEP").vessel = true;
  r = E.calcProject();
  close("Δοχείο στον διαχωριστή: αναρρόφηση P1 = −ΔP(c)", r.press.pump.get("P1").pin, -dp("c"), 1e-12);
  close("… αναρρόφηση P2 = −(ΔP d + max ΔP e1, e2)", r.press.pump.get("P2").pin, -(dp("d") + Math.max(dp("e1"), dp("e2"))), 1e-12);
  close("… κατάθλιψη P1 = αναρρόφηση + H", r.press.pump.get("P1").pout, -dp("c") + C("P1").base, 1e-12);
  truthy("… αναρρόφηση λίγα kPa κάτω από την πλήρωση → χωρίς παρατήρηση (όριο 20 kPa)", !E.validate(r).warns.some(x => x.includes("αναρρόφηση")));
  global.window.DB.DEFAULTS.suctionWarnKPa = 0.1;
  truthy("… με όριο 0.1 kPa → παρατήρηση για την P1", E.validate(r).warns.some(x => x.includes("αναρρόφηση") && x.includes("P1")));
  global.window.DB.DEFAULTS.suctionWarnKPa = 20;
  E.getProject().net.nodes.find(n => n.id === "SEP").vessel = false;
  E.getProject().net.nodes.find(n => n.id === "P1").vessel = true;
  r = E.calcProject();
  close("Δοχείο στην αναρρόφηση P1 → P1 στο 0, διαχωριστής +ΔP(c)", r.press.node.get("SEP"), dp("c"), 1e-12);
  close("… αναρρόφηση P2 = ΔP(c) − (d + max e)", r.press.pump.get("P2").pin, dp("c") - (dp("d") + Math.max(dp("e1"), dp("e2"))), 1e-12);
  // Δευτερεύον μεγαλύτερο από πρωτεύον → ανάμιξη
  E.getProject().net.nodes.find(n => n.id === "P1").Q = 8;
  truthy("Δευτερεύον 9 > πρωτεύον 8 → παρατήρηση ανάμιξης", E.validate(E.calcProject()).warns.some(x => x.includes("αναμιγνύεται")));
  // Δευτερεύον χωρίς αντλία
  E.setProject(E.normalize(base({ net: { nodes: [Nd("P1", "pump", { Q: 10 }), Nd("SEP", "sep"), Nd("F", "fcu", { Q: 5 })],
    edges: [Pp("a", "P1", "SEP", "Φ50", 5), Pp("c", "SEP", "P1", "Φ50", 5), Pp("x", "SEP", "F", "Φ40", 5), Pp("y", "F", "SEP", "Φ40", 5)] } })));
  truthy("Δευτερεύον χωρίς αντλία → «χρειάζεται δική του αντλία»", E.validate(E.calcProject()).errors.some(x => x.includes("F: δεν κυκλοφορείται")));
  // Παράλληλες αντλίες J1 → (Pa | Pb) → J2 → FCU → J1
  const par = qa => base({ net: { nodes: [Nd("J1", "junction"), Nd("J2", "junction"), Nd("Pa", "pump", qa ? { Q: qa } : {}), Nd("Pb", "pump"), Nd("F", "fcu", { Q: 10, dP: 20 })],
    edges: [Pp("a1", "J1", "Pa", "Φ50", 1), Pp("a2", "Pa", "J2", "Φ50", 1), Pp("b1", "J1", "Pb", "Φ40", 1), Pp("b2", "Pb", "J2", "Φ40", 1), Pp("s", "J2", "F", "Φ63", 10), Pp("t", "F", "J1", "Φ63", 10)] } });
  E.setProject(E.normalize(par(0)));
  truthy("Παράλληλες χωρίς παροχή αντλίας → ζητά την παροχή κάθε αντλίας", E.validate(E.calcProject()).errors.some(x => x.includes("παροχή κάθε αντλίας")));
  E.setProject(E.normalize(par(6)));
  r = E.calcProject();
  truthy("Pa 6 → Pb 4 από το ισοζύγιο, χωρίς σφάλματα", Math.abs(r.ecById.get("b2").c.Q - 4) < 1e-12 && !E.validate(r).errors.length);
  const dq = id => r.ecById.get(id).c.dP;
  close("H Pa = a2 + s + FCU + t + a1", r.circuits.find(c => c.pumpId === "Pa").H, dq("a2") + dq("s") + kPa(20) + dq("t") + dq("a1"), 1e-12);
  close("H Pb = b2 + s + FCU + t + b1", r.circuits.find(c => c.pumpId === "Pb").H, dq("b2") + dq("s") + kPa(20) + dq("t") + dq("b1"), 1e-12);
  // Αντλίες σε σειρά
  E.setProject(E.normalize(base({ net: { nodes: [Nd("P1", "pump", { Q: 2 }), Nd("P2", "pump"), Nd("A", "fcu")],
    edges: [Pp("x", "P1", "P2", "Φ32", 5), Pp("y", "P2", "A", "Φ32", 5), Pp("z", "A", "P1", "Φ32", 5)] } })));
  truthy("Αντλίες σε σειρά → σφάλμα", E.validate(E.calcProject()).errors.some(x => x.includes("σε σειρά")));
  // Buffer και διαχωριστής στη σειρά (1 είσοδος / 1 έξοδος) = απλός εξοπλισμός, όχι ζώνη χωρίς αντλία
  E.setProject(E.normalize(base({ net: { nodes: [Nd("P", "pump"), Nd("B", "buffer", { dP: 2 }), Nd("S", "sep", { dP: 1 }), Nd("F", "fcu", { Q: 3, dP: 10 })],
    edges: [Pp("a", "P", "F", "Φ40", 10), Pp("b", "F", "B", "Φ40", 10), Pp("c", "B", "S", "Φ40", 3), Pp("d", "S", "P", "Φ40", 3)] } })));
  r = E.calcProject();
  truthy("Buffer → διαχωριστής στη σειρά: μία ζώνη, χωρίς σφάλματα", r.zones.length === 1 && !E.validate(r).errors.length);
  close("… H = όλοι οι σωλήνες + FCU + buffer + διαχωριστής", r.H, ["a", "b", "c", "d"].reduce((x, k) => x + r.ecById.get(k).c.dP, 0) + kPa(10) + kPa(2) + kPa(1), 1e-12);
  // Όπως στο σχέδιο του χρήστη: συλλέκτης με αντλία σε κάθε αναχώρηση, υποσυλλέκτης, κοινή επιστροφή → buffer → διαχωριστής, πρωτεύον με ψύκτη
  {
    const n2 = [Nd("S1", "header", { dP: 5 }), Nd("A2", "pump"), Nd("A3", "pump"), Nd("S2", "header", { dP: 5 }), Nd("T1", "coil", { Q: 3, dP: 30 }), Nd("T2", "fcu", { Q: 2, dP: 25 }),
      Nd("T3", "coil", { Q: 4, dP: 35 }), Nd("J", "junction"), Nd("BUF", "buffer", { dP: 2 }), Nd("SEP", "sep", { dP: 1 }), Nd("A5", "pump", { Q: 10 }), Nd("CH", "chiller", { dP: 40 })];
    const e2 = [Pp("l1", "SEP", "S1", "Φ63", 5), Pp("l2", "S1", "A2", "Φ50", 2), Pp("l3", "S1", "A3", "Φ40", 2), Pp("l5", "A2", "S2", "Φ50", 10), Pp("l6", "S2", "T1", "Φ40", 20), Pp("l7", "S2", "T2", "Φ32", 15),
      Pp("l8", "T1", "J", "Φ40", 20), Pp("l9", "T2", "J", "Φ32", 15), Pp("l12", "A3", "T3", "Φ40", 30), Pp("l14", "T3", "J", "Φ40", 30), Pp("l10", "J", "BUF", "Φ63", 10), Pp("l11", "BUF", "SEP", "Φ63", 3),
      Pp("l16", "SEP", "A5", "Φ63", 3), Pp("l17", "A5", "CH", "Φ63", 5), Pp("l18", "CH", "SEP", "Φ63", 5)];
    E.setProject(E.normalize(base({ net: { nodes: n2, edges: e2 } })));
    r = E.calcProject();
    const d = k => r.ecById.get(k).c.dP, com = d("l10") + kPa(2) + d("l11") + kPa(1) + d("l1") + kPa(5);
    truthy("Σχέδιο χρήστη: 2 ζώνες, χωρίς σφάλματα", r.zones.filter(z => z.pumps.length).length === 2 && !E.validate(r).errors.length, JSON.stringify(E.validate(r).errors));
    close("… H A2 = l5 + Σ2 + max(κλάδοι Σ2) + κοινά + l2", r.circuits.find(c => c.pumpId === "A2").H, d("l5") + kPa(5) + Math.max(d("l6") + kPa(30) + d("l8"), d("l7") + kPa(25) + d("l9")) + com + d("l2"), 1e-12);
    close("… H A3 = l12 + T3 + l14 + κοινά + l3", r.circuits.find(c => c.pumpId === "A3").H, d("l12") + kPa(35) + d("l14") + com + d("l3"), 1e-12);
    close("… H A5 (πρωτεύον) = l17 + ψύκτης + l18 + διαχ. + l16", r.circuits.find(c => c.pumpId === "A5").H, d("l17") + kPa(40) + d("l18") + kPa(1) + d("l16"), 1e-12);
    truthy("… παροχές: l1 = l10 = 9, l2 = 5", [["l1", 9], ["l10", 9], ["l2", 5]].every(([k, q]) => Math.abs(r.ecById.get(k).c.Q - q) < 1e-12));
    // Χωρίς διαχωριστή ανάμεσα: αντλία πριν από τον συλλέκτη με τις αντλίες → σειρά
    const n3 = n2.filter(n => n.id !== "SEP").concat([Nd("A1", "pump")]);
    const e3 = e2.filter(e => !["l1", "l11", "l16", "l18"].includes(e.id)).concat([Pp("m1", "A1", "S1", "Φ63", 5), Pp("m2", "BUF", "A5", "Φ63", 3), Pp("m3", "CH", "A1", "Φ63", 5)]);
    E.setProject(E.normalize(base({ net: { nodes: n3, edges: e3 } })));
    truthy("Αντλία πριν από συλλέκτη με αντλίες, χωρίς διαχωριστή → «σε σειρά»", E.validate(E.calcProject()).errors.some(x => x.includes("A1") && x.includes("σε σειρά")));
  }
  // Το ενσωματωμένο παράδειγμα: χωρίς σφάλματα και παρατηρήσεις, 4 αντλίες, authority ≥ 0.5 με τη μονάδα στον παρονομαστή
  E.setProject(E.normalize(JSON.parse(JSON.stringify(global.window.DB.EXAMPLE))));
  r = E.calcProject();
  const vx = E.validate(r);
  truthy("Παράδειγμα: 4 αντλίες, 0 σφάλματα, 0 παρατηρήσεις", r.circuits.length === 4 && !vx.errors.length && !vx.warns.length, JSON.stringify(vx));
  const l6 = r.ecById.get("e9").c, k1 = r.ncById.get("k1").m, l7 = r.ecById.get("e10").c.dP;
  close("… authority L6 = ΔPβάνας / (L6 + ΚΚΜ-1 + L7)", l6.ctrl.auth, l6.ctrl.dPv / (l6.dP + k1 + l7), 1e-12);
  truthy("… παροχή πρωτεύοντος (ψύκτης 250 kW) > δευτερεύοντος (235 kW)", r.ecById.get("e1").c.Q > r.ecById.get("e4").c.Q);
  // Θέση από σύρσιμο: υπερισχύει της αυτόματης, οι υπολογισμοί ίδιοι, το σχέδιο χωρίς NaN
  {
    E.setProject(E.normalize(JSON.parse(JSON.stringify(global.window.DB.EXAMPLE))));
    const h0 = E.calcProject().circuits.map(c => c.H).join(",");
    E.getProject().net.nodes.find(n => n.id === "k1").grid = { u: { c: 9, r: 0 } };
    const rg = E.calcProject(), svg = E.schematicNet(rg, true, 900).svg;
    truthy("Σύρσιμο: ίδια H, σχέδιο χωρίς NaN, το ΚΚΜ-1 στη στήλη 9", rg.circuits.map(c => c.H).join(",") === h0 && !svg.includes("NaN") && svg.includes(`x="${60 + 9 * 290}" y="`) && E.normalize(E.getProject()).net.nodes.find(n => n.id === "k1").grid.u.c === 9);
  }
  // Ελεύθερη θέση (px), διαδρομή σωλήνα, μέγεθος, φορά αντλίας: μόνο εμφάνιση
  {
    E.setProject(E.normalize(JSON.parse(JSON.stringify(global.window.DB.EXAMPLE))));
    const h0 = E.calcProject().circuits.map(c => c.H).join(",");
    const pr = E.getProject();
    pr.net.nodes.find(n => n.id === "k1").grid = { u: { x: 1900, y: 90 } };
    pr.net.nodes.find(n => n.id === "buf").size = { w: 200, h: 80 };
    pr.net.nodes.find(n => n.id === "p3").face = "left";
    pr.net.edges.find(e => e.id === "e12").route = { u: { y: 700 } };
    const rg = E.calcProject(), svg = E.schematicNet(rg, true, 900).svg, pn = E.normalize(E.getProject()).net;
    truthy("Θέση/διαδρομή/μέγεθος/φορά: ίδια H, χωρίς NaN, διαδρομή L9 στο y=700, όλα αποθηκεύονται",
      rg.circuits.map(c => c.H).join(",") === h0 && !svg.includes("NaN") && /L-?[\d.]+ 700 L/.test(svg) && svg.includes('width="200" height="80"')
      && pn.nodes.find(n => n.id === "buf").size.w === 200 && pn.nodes.find(n => n.id === "p3").face === "left" && pn.edges.find(e => e.id === "e12").route.u.y === 700);
  }
  // Διαδρομή με ελεύθερα ενδιάμεσα σημεία: τα άκρα μένουν στα σημεία, όλα τα τμήματα οριζόντια/κατακόρυφα
  {
    const pr = E.getProject();
    pr.net.edges.find(e => e.id === "e12").route = { u: { pts: [[1500, 460], [1500, 760], [1100, 760], [1100, 700]] } };
    const svg = E.schematicNet(E.calcProject(), true, 900).svg;
    const m = svg.match(/<g class="seg[^"]*"[^>]*data-id="e12"[\s\S]*?<path d="(M[^"]+)" class="ln/);
    const pts = m ? m[1].replace(/^M/, "").split(" L").map(q => q.split(" ").map(Number)) : [];
    const orth = pts.length > 2 && pts.every((q, i) => i === 0 || q[0] === pts[i - 1][0] || q[1] === pts[i - 1][1]);
    truthy("Διαδρομή με ενδιάμεσα σημεία: ορθογώνια, περνά από (1500, 760) και (1100, 760)", orth && pts.some(q => q[0] === 1500 && q[1] === 760) && pts.some(q => q[0] === 1100 && q[1] === 760), JSON.stringify(pts));
  }
  // Μία αντλία: τίποτα δεν αλλάζει (ίδιο αποτέλεσμα με πριν) — καλύπτεται από [11] (300 τυχαία δίκτυα)
}

/* =========================== 14. Έκδοση =========================== */
console.log("\n[14] Ίδια έκδοση παντού (αλλιώς ο browser κρατά παλιά αρχεία)");
const ver = fs.readFileSync(path.join(dir, "version.txt"), "utf8").trim();
const idx = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const appV = (/APP_VERSION = "([^"]+)"/.exec(idx) || [])[1];
const qs = [...idx.matchAll(/(styles\.css|data\.js|app\.js)\?v=([^"]+)"/g)].map(m => m[2]);
truthy(`version.txt ${ver} = APP_VERSION ${appV} = data.js ${window.DB.VERSION}`, ver === appV && ver === window.DB.VERSION);
truthy(`?v= στα 3 αρχεία = ${ver}`, qs.length === 3 && qs.every(v => v === ver), qs.join(","));
const pj = E.parseProjectText(JSON.stringify({ meta: { name: "x" }, branches: [] }));
truthy("Άνοιγμα αρχείου: δέχεται JSON", pj.meta.name === "x");

/* =========================== Σύνοψη =========================== */
console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail ? 1 : 0);
