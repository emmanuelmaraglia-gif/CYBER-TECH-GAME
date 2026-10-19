const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
initializeApp();
const db = getFirestore();

exports.refreshHallSnapshot = onSchedule({ schedule: "30 7 * * *", timeZone: "America/Sao_Paulo", region: "southamerica-east1" }, async () => {
  const meta = db.collection("meta").doc("leaderboard");
  const current = await meta.get();
  // O primeiro ciclo só nasce depois da primeira pontuação válida.
  if (!current.exists) return;
  const [easySnap, hardSnap, bossSnap] = await Promise.all([
    db.collection("players").where("easyBest", ">", 0).orderBy("easyBest", "desc").limit(10).get(),
    db.collection("players").where("hardBest", ">", 0).orderBy("hardBest", "desc").limit(10).get(),
    db.collection("players").where("bossBestMs", ">", 0).orderBy("bossBestMs", "asc").limit(10).get()
  ]);
  const map = (snap, field) => snap.docs.map(doc => ({ name: doc.get("name") || "Jogador", value: Number(doc.get(field) || 0) }));
  await meta.set({ easy: map(easySnap, "easyBest"), hard: map(hardSnap, "hardBest"), boss: map(bossSnap, "bossBestMs"), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
});
