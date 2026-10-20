const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

/** Monta o Top 10 consolidado a partir dos documentos individuais de /players. */
async function buildLeaderboardSnapshot() {
  const [easySnap, hardSnap, bossSnap] = await Promise.all([
    db.collection("players").where("easyBest", ">", 0).orderBy("easyBest", "desc").limit(10).get(),
    db.collection("players").where("hardBest", ">", 0).orderBy("hardBest", "desc").limit(10).get(),
    db.collection("players").where("bossBestMs", ">", 0).orderBy("bossBestMs", "asc").limit(10).get()
  ]);
  const map = (snap, field) =>
    snap.docs.map(doc => ({
      name: doc.get("name") || "Jogador",
      value: Number(doc.get(field) || 0)
    }));
  return {
    easy: map(easySnap, "easyBest"),
    hard: map(hardSnap, "hardBest"),
    boss: map(bossSnap, "bossBestMs"),
    updatedAt: FieldValue.serverTimestamp()
  };
}

/**
 * Cria o PRIMEIRO snapshot quando aparece a primeira pontuação válida.
 * Depois disso o ranking consolidado só muda pela função agendada (07h30).
 */
exports.initializeHallSnapshotOnFirstValidScore = onDocumentWritten(
  { document: "players/{playerId}", region: "southamerica-east1" },
  async event => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;

    const data = after.data() || {};
    const hasValidScore =
      (Number(data.easyBest) || 0) > 0 ||
      (Number(data.hardBest) || 0) > 0 ||
      (Number(data.bossBestMs) || 0) > 0;
    if (!hasValidScore) return;

    const meta = db.collection("meta").doc("leaderboard");
    const current = await meta.get();
    // Já existe ciclo consolidado → não recria aqui (só o agendador atualiza).
    if (current.exists) return;

    const snapshot = await buildLeaderboardSnapshot();
    await meta.set(snapshot);
  }
);

/**
 * Atualiza (ou cria, se ainda não existir) o ranking consolidado todos os dias às 07h30 (Brasília).
 * Usa Admin SDK → ignora a trava de 24h das regras do cliente.
 */
exports.refreshHallSnapshot = onSchedule(
  {
    schedule: "30 7 * * *",
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1"
  },
  async () => {
    const meta = db.collection("meta").doc("leaderboard");
    const snapshot = await buildLeaderboardSnapshot();
    // Sempre grava: cria o primeiro ciclo se faltar, ou renova o ranking do dia.
    await meta.set(snapshot);
  }
);
