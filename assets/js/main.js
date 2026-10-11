// ################################################################
// PARTE 1 — CONFIGURAÇÃO DO FIREBASE (a única parte que você precisa editar)
// ################################################################
// ============================================================
// CONFIGURAÇÃO DO FIREBASE (HALL DA FAMA)
// Cole aqui a configuração do SEU projeto:
// Console do Firebase → Configurações do projeto (engrenagem) → "Seus apps" → app Web (</>) → "Configuração do SDK"
// Enquanto estiver "COLE_AQUI", o jogo roda em MODO DE TESTE (dados só neste aparelho, com jogadores de exemplo).
// ============================================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBuxxFYEWfOZK6TVY2j0OPLFQnU2V-LPdU",
  authDomain: "cyber-tech-game.firebaseapp.com",
  projectId: "cyber-tech-game"
};

// ################################################################
// PARTE 2 — BANCO DE DADOS DO HALL DA FAMA (Firebase ou modo de teste)
// ################################################################
// ============================================================
// db.js — camada de dados do HALL DA FAMA
// - Com firebase-config.js preenchido: usa Firebase (Firestore + login anônimo).
// - Sem configuração (ou sem o SDK): usa o MODO DE TESTE (localStorage + jogadores de exemplo).
// O jogo só conversa com o objeto DB abaixo, então trocar de modo não muda o resto do código.
// ============================================================
const DB = (() => {
  const DAY = 24 * 60 * 60 * 1000;   // o placar atualiza de 24h em 24h
  const useFirebase = typeof firebase !== "undefined" && typeof FIREBASE_CONFIG !== "undefined" &&
                      FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "COLE_AQUI";

  // Chave única do nome: sem acentos, minúsculo, espaços normalizados ("João" e "joao" são o mesmo nome)
  const keyOf = name => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const pick = d => ({ easyBest: d.easyBest || 0, hardBest: d.hardBest || 0, bossBestMs: d.bossBestMs || 0 });
  const top = (players, field, desc) => Object.values(players)
    .filter(p => p[field] > 0)
    .sort((a, b) => desc ? b[field] - a[field] : a[field] - b[field])
    .slice(0, 10)
    .map(p => ({ name: p.name, value: p[field] }));

  // ---------------- FIREBASE (Firestore sem Authentication/Cloud Functions) ----------------
  if (useFirebase) {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const fs = firebase.firestore();
    const ready = Promise.resolve();
    const players = () => fs.collection("players");
    const metaRef = fs.collection("meta").doc("leaderboard");

    const readTop = async (field, dir) => {
      const snap = await players().where(field, ">", 0).orderBy(field, dir).limit(10).get();
      return snap.docs.map(d => ({ name: d.data().name, value: d.data()[field] }));
    };

    // Cria a fotografia apenas depois de uma pontuação válida. updatedAt marca o início
    // do ciclo atual; após 24h, a primeira visita/processo do jogo recalcula e reinicia o ciclo.
    const rebuildIfDue = async (forceFirst = false) => {
      const snap = await metaRef.get();
      const updatedAt = snap.exists && snap.data().updatedAt ? snap.data().updatedAt.toMillis() : 0;
      if (snap.exists && Date.now() - updatedAt < DAY) return snap;
      if (!snap.exists && !forceFirst) return snap;

      const [easy, hard, boss] = await Promise.all([
        readTop("easyBest", "desc"), readTop("hardBest", "desc"), readTop("bossBestMs", "asc")
      ]);
      const data = { easy, hard, boss, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      try {
        await metaRef.set(data);
      } catch (e) {
        // Outro jogador pode ter criado/atualizado o documento entre a leitura e a escrita.
        const latest = await metaRef.get();
        if (!latest.exists) throw e;
        const latestAt = latest.data().updatedAt ? latest.data().updatedAt.toMillis() : 0;
        if (Date.now() - latestAt >= DAY) throw e;
      }
      return metaRef.get();
    };

    return {
      mode: "firebase", keyOf, ready,

      async isNameTaken(name) {
        const d = await players().doc(keyOf(name)).get();
        return d.exists && d.data().name !== name;
      },

      // Nome normalizado como ID: o mesmo nome não pode ser cadastrado duas vezes.
      async claimName(name) {
        const ref = players().doc(keyOf(name));
        return fs.runTransaction(async t => {
          const d = await t.get(ref);
          if (d.exists) {
            return keyOf(d.data().name) === keyOf(name)
              ? { ok: true, record: pick(d.data()) }
              : { ok: false, reason: "taken" };
          }
          t.set(ref, { name, createdAt: firebase.firestore.FieldValue.serverTimestamp(), easyBest: 0, hardBest: 0, bossBestMs: 0 });
          return { ok: true, record: pick({}) };
        });
      },

      async submit(me, field, value) {
        if (!["easyBest", "hardBest", "bossBestMs"].includes(field) || !(value > 0)) return;
        const ref = players().doc(keyOf(me.name));
        await fs.runTransaction(async t => {
          const d = await t.get(ref);
          if (!d.exists) throw new Error("Jogador não encontrado no Hall da Fama.");
          const old = d.data()[field] || 0;
          const better = field === "bossBestMs" ? (!old || value < old) : value > old;
          if (better) t.update(ref, { [field]: value });
        });
        // A primeira pontuação válida inicia o ciclo; depois, o ranking só é refeito
        // quando completadas 24h. O ciclo seguinte começa imediatamente na atualização.
        await rebuildIfDue(true);
      },

      async getLeaderboards() {
        let snap = await metaRef.get();
        if (snap.exists && snap.data().updatedAt && Date.now() - snap.data().updatedAt.toMillis() >= DAY) {
          try { snap = await rebuildIfDue(false); } catch (e) { snap = await metaRef.get(); }
        }
        if (!snap.exists) {
          return { easy: [], hard: [], boss: [], updatedAt: Date.now() };
        }
        const d = snap.data();
        return { easy: d.easy || [], hard: d.hard || [], boss: d.boss || [], updatedAt: d.updatedAt ? d.updatedAt.toMillis() : Date.now() };
      }
    };
  }

  // ---------------- MODO DE TESTE (local) ----------------
  const PK = "cybertech_players", SK = "cybertech_snapshot", UK = "cybertech_user";
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const demo = () => {   // jogadores de exemplo, só para ver o Hall da Fama funcionando
    const p = {};
    ["NEO_X", "TRINITY", "GHOST_99", "CIPHER", "NOVA", "ZERO_COOL", "BYTE", "ECHO", "VOLT", "RAZOR", "PIXEL", "KAIRO"]
      .forEach((n, i) => { p[keyOf(n)] = { name: n, easyBest: 42 - i * 3, hardBest: 30 - i * 2, bossBestMs: 250000 + i * 17000 }; });
    return p;
  };
  const players = () => { let p = read(PK, null); if (!p) { p = demo(); write(PK, p); } return p; };
  const mine = name => { const u = read(UK, null); return !!u && keyOf(u.name) === keyOf(name); };

  return {
    mode: "local", keyOf, ready: Promise.resolve(),

    async isNameTaken(name) { return !!players()[keyOf(name)] && !mine(name); },

    async claimName(name) {
      const p = players(), k = keyOf(name);
      if (p[k]) return mine(name) ? { ok: true, record: pick(p[k]) } : { ok: false, reason: "taken" };
      p[k] = { name, easyBest: 0, hardBest: 0 };
      write(PK, p);
      return { ok: true, record: pick({}) };
    },

    async submit(me, field, value) {
      const p = players(), k = keyOf(me.name);
      p[k] = p[k] || { name: me.name, easyBest: 0, hardBest: 0 };
      const better = field === "bossBestMs" ? (!p[k][field] || value < p[k][field]) : value > (p[k][field] || 0);
      if (better) { p[k][field] = value; write(PK, p); }
    },

    async getLeaderboards() {
      let snap = read(SK, null);
      if (!snap || Date.now() - snap.updatedAt >= DAY) {
        const p = players();
        snap = { updatedAt: Date.now(), easy: top(p, "easyBest", true), hard: top(p, "hardBest", true), boss: top(p, "bossBestMs", false) };
        write(SK, snap);
      }
      return snap;
    }
  };
})();

// ################################################################
// PARTE 3 — O JOGO
// ################################################################
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// CONFIGURAÇÕES
const TOTAL_OBSTACLES = 50;
const SPEED = 420;
const GAME_TIME = 120;
const STICK_MAX = 55;
const OBSTACLE_GAP = 55;
const DOUBLE_TAP_MS = 300;
const SLOW_FACTOR = 0.5;
const ITEMS_PER_SHUFFLE = 5;
const SHUFFLE_SAFE_DISTANCE = 70;
const SPIKE_DAMAGE = 2;     // dano dos blocos com espinho (modo difícil)
const INVULN_TIME = 1;      // segundos de invulnerabilidade após tomar dano de espinho
const FADE_TIME = 2.5;      // segundos que o jogador leva para voltar a 100% visível após o dano
const MAGNET_RADIUS = 110;  // alcance do ímã (azul/vermelho), só para blocos vermelhos
const MAGNET_TIME = 5;      // duração do ímã
const SHIELD_TIME = 3;      // duração da invencibilidade (bloco verde)
const POWERUP_LIFE = 8;     // quanto tempo um power-up fica no mapa
const DEBUFF_EVERY = 15;    // modo difícil: um debuff a cada 15 s
const DEBUFF_TIME = 10;     // duração de cada debuff
const HARD_ITEM_POINTS = 2; // pontos por bloco vermelho no difícil
const STAMINA_MAX = 100;    // stamina total
const STAMINA_DRAIN = 25;   // gasto por segundo ao correr (≈4 s de corrida)
const STAMINA_REGEN = 15;   // recuperação por segundo ao não correr
const STAMINA_RESUME = 30;  // depois de zerar, só volta a correr ao recuperar isso

// ESTADO
let screen = "menu";        // "menu" | "difficulty" | "playing"
let mode = "easy";          // "easy" | "hard"
let player = { x: 0, y: 0, size: 40 };
let item = { x: 0, y: 0, size: 20 };
let obstacles = [];
let floats = [];
let score = 0, collected = 0, timeLeft = GAME_TIME, elapsed = 0, invuln = 0, fade = 0;
let gameOver = false;
let flash = 0, flashColor = "#fff";
let last = 0, running = false, stick = null, audio = null;
let paused = false;
let stamina = STAMINA_MAX, exhausted = false, staminaDelay = 0;
let powerups = [], puTimer = 6, magnetTime = 0, shield = 0;
let debuff = null, debuffTime = 0, nextDebuffAt = DEBUFF_EVERY, fake = null;
const keys = new Set();
const lastPress = {};

// SOM
function initAudio() {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
}
function beep(freq, dur) {
  try {
    if (!audio) return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; o.type = "square";
    g.gain.setValueAtTime(0.06, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch (e) {}
}

// UTILIDADES
const W = () => canvas.width, H = () => canvas.height;

function overlap(a, b, m = 0) {
  return a.x < b.x + b.size + m && a.x + a.size > b.x - m &&
         a.y < b.y + b.size + m && a.y + a.size > b.y - m;
}

function safePosition(size, avoid, margin) {
  let pos;
  for (const scale of [1, 0.8, 0.6, 0.4]) {
    for (let i = 0; i < 150; i++) {
      pos = {
        x: Math.floor(Math.random() * Math.max(1, W() - size)),
        y: Math.floor(Math.random() * Math.max(1, H() - size))
      };
      const box = { x: pos.x, y: pos.y, size };
      if (!avoid.some(o => overlap(box, o, (o.gap ?? margin) * (o.fixed ? 1 : scale)))) return pos;
    }
  }
  return pos;
}

function clampEntity(e) {
  e.x = Math.max(0, Math.min(e.x, W() - e.size));
  e.y = Math.max(0, Math.min(e.y, H() - e.size));
}

// No modo boss, mantém o jogador fora da faixa superior reservada às estatísticas.
const BOSS_HUD_SAFE_Y = 110;
function keepPlayerBelowBossHud() {
  if (mode === "boss" && screen === "playing") {
    player.y = Math.max(BOSS_HUD_SAFE_Y, Math.min(player.y, H() - player.size));
  }
}

function resizeCanvas() {
  canvas.width = Math.max(100, window.innerWidth - 10);
  canvas.height = Math.max(100, window.innerHeight - 10);
  [player, item, ...obstacles].forEach(clampEntity);
  obstacles.forEach(o => {
    if (o.ax !== undefined) { o.ax = Math.max(0, Math.min(o.ax, W() - o.size)); o.ay = Math.max(0, Math.min(o.ay, H() - o.size)); }
  });
}
window.addEventListener("resize", resizeCanvas);

// Modo fácil: reposiciona os brancos longe do jogador
function shuffleObstacles() {
  const safe = Math.min(SHUFFLE_SAFE_DISTANCE, Math.min(W(), H()) / 4);
  const zone = { x: player.x, y: player.y, size: player.size, gap: safe, fixed: true };
  const placed = [];
  obstacles.forEach(obs => {
    const pos = safePosition(obs.size, [zone, item, ...powerupZones(), ...placed], 40);
    obs.x = pos.x; obs.y = pos.y;
    placed.push(obs);
  });
  floats.push({ x: W() / 2 - 90, y: H() / 2, text: "BLOCOS MUDARAM!", color: "#00ACFF", life: 0.8 });
  beep(520, 0.25);
}

// Quantidade e espaçamento dos blocos brancos conforme o tamanho da tela
function obstacleSettings() {
  const area = W() * H();
  const count = Math.max(10, Math.min(TOTAL_OBSTACLES, Math.round(TOTAL_OBSTACLES * area / 800000)));
  const small = area < 600000;   // tela pequena (celular)
  // Em telas pequenas: menos blocos e mais folga entre eles (entre 55 e 80 px)
  const gap = small
    ? Math.min(80, Math.max(OBSTACLE_GAP, Math.floor(Math.sqrt(area * 0.55 / count)) - 25))
    : OBSTACLE_GAP;
  return { count, gap, small };
}

// INICIAR / REINICIAR PARTIDA
function startGame() {
  screen = "playing";
  player.x = W() / 2 - player.size / 2;
  player.y = H() / 2 - player.size / 2;
  score = 0; collected = 0; elapsed = 0; invuln = 0; fade = 0;
  timeLeft = GAME_TIME; gameOver = false;
  floats = []; flash = 0; stick = null; running = false; keys.clear(); paused = false;
  stamina = STAMINA_MAX; exhausted = false; staminaDelay = 0;
  shake = 0; furyFlash = 0; kb.x = 0; kb.y = 0;   // zera o tremor de tela
  powerups = []; puTimer = 6; magnetTime = 0; shield = 0;
  debuff = null; debuffTime = 0; nextDebuffAt = DEBUFF_EVERY; fake = null;

  endTitle = "TEMPO ESGOTADO!"; endSub = ""; endColor = "yellow";
  if (mode === "boss") {   // sem obstáculos e sem blocos de pontuação
    obstacles = []; item.x = -200; item.y = -200;
    playerHP = PLAYER_MAX_HP; boss = null; drop = null; wave = null;
    shake = 0; furyFlash = 0; kb.x = 0; kb.y = 0; bossStage = "intro"; stageT = 0;
    bossIdx = 0; firstOpportunityShown.clear(); clearHazards(); runTime = 0;
    return;
  }

  const hard = mode === "hard";
  const p = safePosition(item.size, [player], 80);
  item.x = p.x; item.y = p.y;

  const cfg = obstacleSettings();
  const playerMargin = Math.min(hard ? 130 : 70, Math.min(W(), H()) / 3);
  obstacles = [];
  for (let i = 0; i < cfg.count; i++) {
    const o = { size: 25, gap: cfg.gap };
    if (hard) {   // movimento de vai-e-vem contínuo
      o.axis = Math.random() < 0.5 ? 0 : 1;
      o.amp = (30 + Math.random() * 50) * (cfg.small ? 0.6 : 1);   // vai-e-vem menor em tela pequena
      o.spd = 1 + Math.random() * 1.5;
      o.phase = Math.random() * Math.PI * 2;
    }
    const pos = safePosition(o.size, [player, item, ...obstacles], playerMargin);
    o.x = pos.x; o.y = pos.y;
    if (hard) { o.ax = pos.x; o.ay = pos.y; }
    obstacles.push(o);
  }
}

// RECOMPENSAS
const REWARDS = [
  { pts: 6,  balas: 1,  wait: "10m" },
  { pts: 10, balas: 2,  wait: "15m" },
  { pts: 16, balas: 4,  wait: "25m" },
  { pts: 24, balas: 6,  wait: "40m" },
  { pts: 40, balas: 9,  wait: "1h" },
  { pts: 60, balas: 12, wait: "1h e 30m" }
];
const BEST_KEY = "cybertech_best_score";
const WAIT_MS = [10, 15, 25, 40, 60, 90].map(m => m * 60000);   // espera de cada faixa (mesma ordem de REWARDS)
const COOL_KEY = "cybertech_cooldown";
const CONFIRM_MS = 5000;    // tempo para dar o 2º clique de confirmação
let cooldownUntil = 0, lastClaim = null, confirmArmedAt = 0;
const cooldownLeft = () => Math.max(0, cooldownUntil - Date.now());
const canClaimNow = pts => !!tierFor(pts) && cooldownLeft() === 0;
const isArmed = () => confirmArmedAt > 0 && performance.now() - confirmArmedAt < CONFIRM_MS;

function fmtTime(ms) {
  const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  const p = n => String(n).padStart(2, "0");
  return (h > 0 ? h + ":" : "") + p(m) + ":" + p(s);
}
function loadCooldown() {
  try {
    const d = JSON.parse(localStorage.getItem(COOL_KEY) || "null");
    if (d && d.until > Date.now()) { cooldownUntil = d.until; lastClaim = { balas: d.balas, wait: d.wait }; }
  } catch (e) {}
}
function saveCooldown() {
  try { localStorage.setItem(COOL_KEY, JSON.stringify({ until: cooldownUntil, balas: lastClaim.balas, wait: lastClaim.wait })); } catch (e) {}
}
let bestScore = 0;          // melhor pontuação em uma única partida
let claim = null;           // dados da tela de parabéns

const balasText = n => n + (n === 1 ? " bala" : " balas");
function tierFor(points) {
  let t = null;
  REWARDS.forEach(r => { if (points >= r.pts) t = r; });
  return t;
}
function loadBest() { try { bestScore = parseInt(localStorage.getItem(BEST_KEY)) || 0; } catch (e) {} }
function saveBest() { try { localStorage.setItem(BEST_KEY, String(bestScore)); } catch (e) {} }
function recordBest() { if (score > bestScore) { bestScore = score; saveBest(); } }

function openClaim(points) {
  const t = tierFor(points);
  if (!t || cooldownLeft() > 0) return;
  claim = { points, balas: t.balas, waitMs: WAIT_MS[REWARDS.indexOf(t)], waitLabel: t.wait,
            time: new Date().toLocaleTimeString("pt-BR") };
  confirmArmedAt = 0;
  screen = "congrats";
  beep(880, 0.2);
}

function wrapText(text, maxW) {
  const lines = []; let cur = "";
  text.split(" ").forEach(w => {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  });
  if (cur) lines.push(cur);
  return lines;
}

function rewardsLayout() {
  const pw = Math.min(W() - 30, 560), px = W() / 2 - pw / 2;
  const rh = Math.max(34, Math.min(50, (H() - 300) / 6));
  const ty = 62, hh = 26, tb = ty + hh + 6 * rh;
  const cooling = cooldownLeft() > 0, extra = cooling ? 18 : 0;
  const canClaim = bestScore >= REWARDS[0].pts && !cooling;
  const bw = Math.min(300, W() - 40);
  return {
    pw, px, rh, ty, hh, tb,
    buttons: [
      { id: "claim", label: "RESGATAR RECOMPENSA", font: 20, color: canClaim ? "#4dff88" : "#555", x: W() / 2 - bw / 2, y: tb + 72 + extra, w: bw, h: 50 },
      { id: "back", label: "VOLTAR", font: 18, outline: true, x: W() / 2 - 70, y: tb + 130 + extra, w: 140, h: 40 }
    ]
  };
}

function drawRewards() {
  const L = rewardsLayout();
  drawTitle("RECOMPENSAS", 34, 42, "yellow");

  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(L.px, L.ty, L.pw, L.hh + 6 * L.rh);
  ctx.strokeStyle = "yellow"; ctx.lineWidth = 2;
  ctx.strokeRect(L.px, L.ty, L.pw, L.hh + 6 * L.rh);

  const c2 = L.px + L.pw * 0.36, full = L.pw >= 480;
  ctx.fillStyle = "yellow"; ctx.font = "bold 14px Arial";
  ctx.fillText("Pontos", L.px + 16, L.ty + 18);
  ctx.fillText("Recompensa", c2, L.ty + 18);

  const got = tierFor(bestScore);
  REWARDS.forEach((r, i) => {
    const y = L.ty + L.hh + i * L.rh;
    ctx.strokeStyle = "rgba(255,255,255,0.18)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L.px, y); ctx.lineTo(L.px + L.pw, y); ctx.stroke();
    ctx.fillStyle = r === got ? "yellow" : "white";
    ctx.font = "bold 16px Arial";
    ctx.fillText(r.pts + " pontos", L.px + 16, y + L.rh / 2 + 5);
    ctx.fillText("= " + balasText(r.balas), c2, y + L.rh / 2 - 2);
    ctx.font = "12px Arial";
    ctx.fillText(full ? "(aguarde " + r.wait + " para receber qualquer recompensa)" : "(aguarde " + r.wait + ")", c2, y + L.rh / 2 + 14);
  });

  ctx.textAlign = "center"; ctx.fillStyle = "white"; ctx.font = "bold 14px Arial";
  const left = cooldownLeft();
  ctx.fillText(left > 0 && lastClaim
    ? "Você resgatou " + balasText(lastClaim.balas) + " (espera de " + lastClaim.wait + ")."
    : "Bata a meta em uma única partida e ganhe balas!", W() / 2, L.tb + 22);
  ctx.fillText("Sua melhor pontuação: " + bestScore, W() / 2, L.tb + 42);
  if (left > 0) {
    ctx.fillStyle = "#ffb703"; ctx.font = "bold 17px Arial";
    ctx.fillText("⏳ Aguarde " + fmtTime(left), W() / 2, L.tb + 64);
    ctx.font = "bold 13px Arial";
    ctx.fillText("para receber qualquer recompensa novamente", W() / 2, L.tb + 82);
  } else {
    ctx.fillStyle = got ? "#4dff88" : "#ff5a5a";
    ctx.fillText(got ? "Você vai receber " + balasText(got.balas) + "." : "Faça pelo menos " + REWARDS[0].pts + " pontos para ganhar balas.", W() / 2, L.tb + 62);
  }
  ctx.textAlign = "left";
  L.buttons.forEach(drawButton);
}

function congratsLayout() {
  const w = Math.min(W() - 40, 460), one = claim.balas === 1;
  ctx.font = "bold 18px Arial";
  const msg = wrapText("Parabéns, você ganhou " + balasText(claim.balas) + "! Vá para a mesa de onde você escaneou o QR code e receba " +
    (one ? "sua bala" : "suas balas") + " conversando com a gente.", w);
  ctx.font = "bold 16px Arial";
  const warn = wrapText("⚠ NÃO feche esta tela! Se fechar, não será possível comprovar que você bateu a meta de pontos para receber " +
    (one ? "a bala." : "as balas."), w - 30);
  const boxH = warn.length * 22 + 20;
  const titleO = 36, msgO = titleO + 38, boxO = msgO + (msg.length - 1) * 25 + 24;
  const infoO = boxO + boxH + 28, btnO = infoO + 20, total = btnO + 46;
  const y0 = Math.max(10, (H() - total) / 2);
  const bw = Math.min(300, W() - 40);
  return {
    w, bx: W() / 2 - w / 2, msg, warn, boxH,
    titleY: y0 + titleO, msgY: y0 + msgO, boxY: y0 + boxO, infoY: y0 + infoO,
    buttons: [{ id: "received", label: isArmed() ? "CLIQUE DE NOVO PARA CONFIRMAR" : "JÁ RECEBI MINHAS BALAS",
      font: isArmed() ? 15 : 18, outline: !isArmed(), x: W() / 2 - bw / 2, y: y0 + btnO, w: bw, h: 46 }]
  };
}

function drawCongrats() {
  const L = congratsLayout();
  drawTitle("PARABÉNS! 🎉", 40, L.titleY, "yellow");
  ctx.textAlign = "center"; ctx.fillStyle = "white"; ctx.font = "bold 18px Arial";
  L.msg.forEach((s, i) => ctx.fillText(s, W() / 2, L.msgY + i * 25));
  ctx.fillStyle = "#d6213a"; ctx.fillRect(L.bx, L.boxY, L.w, L.boxH);
  ctx.strokeStyle = "white"; ctx.lineWidth = 3; ctx.strokeRect(L.bx, L.boxY, L.w, L.boxH);
  ctx.fillStyle = "white"; ctx.font = "bold 16px Arial";
  L.warn.forEach((s, i) => ctx.fillText(s, W() / 2, L.boxY + 26 + i * 22));
  ctx.font = "bold 15px Arial";
  ctx.fillText(claim.points + " pontos · " + new Date().toLocaleTimeString("pt-BR"), W() / 2, L.infoY);
  ctx.textAlign = "left";
  L.buttons.forEach(drawButton);
  const b = L.buttons[0];
  ctx.textAlign = "center"; ctx.fillStyle = "white"; ctx.font = "13px Arial";
  ctx.fillText("Mostre esta tela para a equipe antes de confirmar.", W() / 2, b.y + b.h + 24);
  ctx.textAlign = "left";
}

// ===== LOGIN E HALL DA FAMA =====
const USER_KEY = "cybertech_user";
let me = null;                                       // { name, easyBest, hardBest, bossBestMs }
let loginMsg = "", loginMsgOk = false, loginArmed = false, loginBusy = false;
let hall = null, hallState = "idle", hallTab = 0;    // hallState: idle | loading | ok | error
let runTime = 0;                                     // tempo da run no modo boss (segundos)
const nameInput = document.getElementById("nameInput");

function loadMe() { try { me = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) { me = null; } }
function saveMe() { try { localStorage.setItem(USER_KEY, JSON.stringify(me)); } catch (e) {} }

const fmtRun = ms => { const m = Math.floor(ms / 60000), sec = (ms % 60000) / 1000; return m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(1); };
const fmtDate = ms => new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function fitText(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

// ----- recordes: envia ao banco só quando bate o recorde pessoal -----
function submitIf(field, value) {
  if (!me || !(value > 0)) return;
  const better = field === "bossBestMs" ? (!me[field] || value < me[field]) : value > (me[field] || 0);
  if (!better) return;
  me[field] = value; saveMe();
  DB.submit(me, field, value).catch(() => {});       // sem internet: o recorde fica salvo aqui e é reenviado depois
}
function submitRecord() {
  if (mode === "easy") submitIf("easyBest", score);
  else if (mode === "hard") submitIf("hardBest", score);
}
function syncMe() {                                  // reenvia recordes guardados (ex.: se estava sem internet)
  if (!me) return;
  DB.ready.then(() => ["easyBest", "hardBest", "bossBestMs"].forEach(f => { if (me[f]) DB.submit(me, f, me[f]).catch(() => {}); })).catch(() => {});
}

// ----- LOGIN -----
const sanitizeName = v => v.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s{2,}/g, " ").slice(0, 20);
const validName = n => n.length >= 3 && n.length <= 20;
function setLoginMsg(text, ok) { loginMsg = text; loginMsgOk = !!ok; }

nameInput.addEventListener("input", () => {
  const clean = sanitizeName(nameInput.value);
  if (clean !== nameInput.value) nameInput.value = clean;
  loginArmed = false; setLoginMsg("", false);        // mudou o nome: a confirmação recomeça
});
nameInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); loginClick(); } });

async function loginClick() {
  if (loginBusy || screen !== "login") return;
  const name = nameInput.value.trim().replace(/\s+/g, " ");
  if (!validName(name)) { loginArmed = false; setLoginMsg("Use de 3 a 20 caracteres (letras, números, espaço, _ ou -).", false); return; }
  loginBusy = true;
  try {
    if (!loginArmed) {                               // 1º clique: confere se o nome está livre e mostra o aviso
      setLoginMsg("Verificando...", true);
      if (await DB.isNameTaken(name)) setLoginMsg("Esse nome já está em uso. Escolha outro.", false);
      else { loginArmed = true; setLoginMsg("", true); }
    } else {                                         // 2º clique: confirma e cria o nome
      const r = await DB.claimName(name);
      if (!r.ok) { loginArmed = false; setLoginMsg("Esse nome já está em uso. Escolha outro.", false); }
      else { me = { name, ...r.record }; saveMe(); loginArmed = false; setLoginMsg("", true); screen = "menu"; }
    }
  } catch (e) {
    loginArmed = false; setLoginMsg("Sem conexão com o servidor. Tente novamente.", false);
  }
  loginBusy = false;
}

let nameInputShown = false;
function syncNameInput() {
  const show = screen === "login";
  if (show) nameInput.style.top = (canvas.getBoundingClientRect().top + loginLayout().inputC) + "px";
  if (show === nameInputShown) return;
  nameInputShown = show;
  nameInput.classList.toggle("input-on", show);
  if (show) setTimeout(() => nameInput.focus(), 50); else nameInput.blur();
}

function loginLayout() {
  const compact = H() < 480;
  const t = compact ? 6 : Math.max(10, H() / 2 - 185);
  const inputC = compact ? t + 62 : t + 140;
  const bw = Math.min(300, W() - 40), bh = compact ? 50 : 58;
  const btnY = inputC + 52, w = Math.min(W() - 40, 460);
  ctx.font = "bold 15px Arial";
  const warn = loginArmed ? wrapText("⚠ ATENÇÃO! Você NÃO poderá trocar de nome depois. Confira se está certo e clique de novo para confirmar.", w - 24) : [];
  return {
    compact, inputC, w, warn, titleY: t + 40, labelY: compact ? t + 20 : t + 96, msgY: inputC + 44,
    warnY: btnY + bh + 12, warnH: warn.length * 20 + 16,
    buttons: [{ id: "loginOk", label: loginBusy ? "AGUARDE..." : (loginArmed ? "CLIQUE DE NOVO PARA CONFIRMAR" : "CONFIRMAR"),
                font: loginArmed ? 15 : 22, color: loginBusy ? "#555" : "yellow", x: W() / 2 - bw / 2, y: btnY, w: bw, h: bh }]
  };
}

function drawLogin() {
  const L = loginLayout();
  if (!L.compact) drawTitle("CYBER TECH GAME", 44, L.titleY, "yellow");
  ctx.textAlign = "center"; ctx.fillStyle = "white"; ctx.font = "bold 18px Arial";
  ctx.fillText("Escolha seu nome de jogador", W() / 2, L.labelY);
  ctx.font = "bold 13px Arial";
  if (loginMsg) { ctx.fillStyle = loginMsgOk ? "#4dff88" : "#ff5a5a"; ctx.fillText(loginMsg, W() / 2, L.msgY); }
  else { ctx.fillStyle = "rgba(255,255,255,0.55)"; ctx.fillText(nameInput.value.length + "/20", W() / 2, L.msgY); }
  L.buttons.forEach(drawButton);
  if (loginArmed) {                                  // aviso: o nome não poderá ser trocado
    const x = W() / 2 - L.w / 2;
    ctx.fillStyle = "#d6213a"; ctx.fillRect(x, L.warnY, L.w, L.warnH);
    ctx.strokeStyle = "white"; ctx.lineWidth = 3; ctx.strokeRect(x, L.warnY, L.w, L.warnH);
    ctx.fillStyle = "white"; ctx.font = "bold 15px Arial"; ctx.textAlign = "center";
    L.warn.forEach((ln, i) => ctx.fillText(ln, W() / 2, L.warnY + 24 + i * 20));
  }
  ctx.textAlign = "left";
}

// ----- MENU -----
function menuLayout() {
  const cy = H() / 2, bh = H() < 450 ? 50 : 62, gap = 10, total = 3 * bh + 2 * gap, top = cy - total / 2 + 24, x = W() / 2 - 120;
  return { top, buttons: [
    { id: "play", label: "JOGAR", x, y: top, w: 240, h: bh },
    { id: "hall", label: "HALL DA FAMA", font: 22, color: "#ffd700", x, y: top + bh + gap, w: 240, h: bh },
    { id: "rewards", label: "RECOMPENSAS", font: 22, color: "#00ACFF", x, y: top + 2 * (bh + gap), w: 240, h: bh }
  ] };
}

// ----- HALL DA FAMA -----
function openHall() {
  screen = "hall"; hallTab = 0; hallState = "loading";
  DB.getLeaderboards().then(d => { hall = d; hallState = "ok"; }).catch(() => { hallState = "error"; });
}

function hallLayout() {
  const compact = H() < 480, pw = Math.min(W() - 24, 560), px = W() / 2 - pw / 2;
  const titleSize = compact ? 26 : 34, titleY = compact ? 28 : 42;
  const tabY = compact ? 40 : 60, tabH = compact ? 30 : 38;
  const subY = tabY + tabH + (compact ? 18 : 22), listTop = subY + 12;
  const cols = compact ? 2 : 1, perCol = 10 / cols;
  const rh = compact ? 24 : Math.max(22, Math.min(32, (H() - listTop - 130) / 10));
  const footY = listTop + perCol * rh + 18;
  const backH = compact ? 34 : 44, backY = footY + (compact ? 34 : 42);
  const tw = (pw - 16) / 3, labels = ["FÁCIL", "DIFÍCIL", "BOSS"];
  const buttons = labels.map((l, i) => ({ id: "tab" + i, label: l, font: compact ? 14 : 16, outline: i !== hallTab,
                                          color: "#ffd700", x: px + i * (tw + 8), y: tabY, w: tw, h: tabH }));
  buttons.push({ id: "back", label: "VOLTAR", font: 18, outline: true, x: W() / 2 - 80, y: backY, w: 160, h: backH });
  return { compact, pw, px, titleSize, titleY, subY, listTop, cols, perCol, rh, footY, buttons };
}

function drawHall() {
  const L = hallLayout();
  drawTitle("HALL DA FAMA", L.titleSize, L.titleY, "#ffd700");
  L.buttons.forEach(drawButton);
  ctx.textAlign = "center"; ctx.fillStyle = "#00e5ff"; ctx.font = "bold 14px Arial";
  ctx.fillText(["Mais pontos · Clássico Fácil", "Mais pontos · Clássico Difícil", "Menor tempo para vencer os 3 bosses"][hallTab], W() / 2, L.subY);

  if (hallState !== "ok") {
    ctx.fillStyle = hallState === "error" ? "#ff5a5a" : "white"; ctx.font = "bold 16px Arial";
    ctx.fillText(hallState === "error" ? "Não foi possível carregar o placar. Tente de novo mais tarde." : "Carregando...", W() / 2, L.listTop + 60);
    ctx.textAlign = "left";
    return;
  }

  const list = hall[["easy", "hard", "boss"][hallTab]] || [], colW = L.pw / L.cols;
  for (let i = 0; i < 10; i++) {
    const col = Math.floor(i / L.perCol), row = i % L.perCol;
    const x = L.px + col * colW, y = L.listTop + row * L.rh, w = colW - (L.cols > 1 && col === 0 ? 6 : 0), cyRow = y + L.rh / 2 + 5;
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.09)"; ctx.fillRect(x, y, w, L.rh - 2);
    const e = list[i];
    ctx.textAlign = "left"; ctx.font = "bold 15px Arial";
    ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.fillText((i + 1) + "º", x + 8, cyRow);
    ctx.fillStyle = e ? (["#ffd700", "#c0c0c0", "#cd7f32"][i] || "white") : "rgba(255,255,255,0.3)";   // ouro, prata, bronze, resto branco
    ctx.fillText(e ? fitText(e.name, w - 44 - 86) : "---", x + 42, cyRow);
    if (e) { ctx.fillStyle = "#dddddd"; ctx.textAlign = "right"; ctx.fillText(hallTab === 2 ? fmtRun(e.value) : e.value + " pts", x + w - 10, cyRow); }
  }

  ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.font = "12px Arial";
  ctx.fillText(DB.mode === "local" ? "MODO DE TESTE · dados de exemplo salvos só neste aparelho"
                                   : "O placar atualiza a cada 24h · última: " + fmtDate(hall.updatedAt), W() / 2, L.footY);
  if (me) ctx.fillText("Seus recordes: Fácil " + (me.easyBest || 0) + " · Difícil " + (me.hardBest || 0) +
                       " · Boss " + (me.bossBestMs ? fmtRun(me.bossBestMs) : "--"), W() / 2, L.footY + 16);
  ctx.textAlign = "left";
}

// TELAS / BOTÕES
function getButtons() {
  const cx = W() / 2, cy = H() / 2;
  if (screen === "login") return loginLayout().buttons;
  if (screen === "hall") return hallLayout().buttons;
  if (screen === "rewards") return rewardsLayout().buttons;
  if (screen === "congrats") return congratsLayout().buttons;
  if (screen === "menu") return menuLayout().buttons;
  if (screen === "modes")
    return [
      { id: "classic", label: "CLÁSSICO", sub: "Blocos, power-ups e dificuldades", color: "#4dff88", x: cx - 190, y: cy - 60, w: 380, h: 75 },
      { id: "boss", label: "BOSS", sub: "Enfrente os chefes da CYBERÓPOLIS", color: "#ff5a5a", x: cx - 190, y: cy + 35, w: 380, h: 75 },
      { id: "back", label: "VOLTAR AO MENU", font: 18, outline: true, x: cx - 120, y: cy + 128, w: 240, h: 46 }
    ];
  if (screen === "difficulty")
    return [
      { id: "easy", label: "FÁCIL", sub: "Blocos trocam de lugar a cada 5 vermelhos", color: "#4dff88", x: cx - 190, y: cy - 60, w: 380, h: 75 },
      { id: "hard", label: "DIFÍCIL", sub: "Espinhos (-2) que se movem sem parar", color: "#ff5a5a", x: cx - 190, y: cy + 35, w: 380, h: 75 },
      { id: "back", label: "VOLTAR", font: 18, outline: true, x: cx - 120, y: cy + 128, w: 240, h: 46 }
    ];
  if (screen === "playing" && gameOver) {
    const reached = canClaimNow(score), y0 = cy + 20, dy = reached ? 72 : 0, list = [];
    const bw = Math.min(310, W() - 30), bx = cx - bw / 2;   // largura única para os 3 botões
    if (reached) list.push({ id: "claimNow", label: "RESGATAR RECOMPENSA", font: 19, color: "#4dff88", x: bx, y: y0, w: bw, h: 60 });
    list.push(
      { id: "again", label: "JOGAR NOVAMENTE", font: 20, x: bx, y: y0 + dy, w: bw, h: 60 },
      { id: "menu", label: "MENU INICIAL", font: 18, color: "#00ACFF", x: bx, y: y0 + dy + 72, w: bw, h: 46 }
    );
    return list;
  }
  if (screen === "playing" && paused)
    return [
      { id: "resume", label: "CONTINUAR", font: 22, x: cx - 115, y: cy - 20, w: 230, h: 60 },
      { id: "menu", label: "MENU INICIAL", font: 18, color: "#00ACFF", x: cx - 115, y: cy + 52, w: 230, h: 46 }
    ];
  if (screen === "playing" && !(mode === "boss" && bossStage === "cutscene"))
    return [{ id: "pause", label: "II", font: 20, color: "#00ACFF", x: cx - 22, y: 8, w: 44, h: 36 }];
  return [];
}

function press(id) {
  if (id === "play") screen = "modes";
  else if (id === "hall") openHall();
  else if (id.startsWith("tab")) hallTab = +id.slice(3);
  else if (id === "loginOk") loginClick();
  else if (id === "classic") screen = "difficulty";
  else if (id === "boss") { mode = "boss"; startGame(); }
  else if (id === "rewards") screen = "rewards";
  else if (id === "back") screen = "menu";
  else if (id === "claim") { if (bestScore >= REWARDS[0].pts) openClaim(bestScore); }
  else if (id === "claimNow") openClaim(score);
  else if (id === "received") {
    if (!isArmed()) { confirmArmedAt = performance.now(); return; }   // 1º clique: só arma a confirmação
    confirmArmedAt = 0;
    if (claim) {
      cooldownUntil = Date.now() + claim.waitMs;                      // espera para QUALQUER recompensa
      lastClaim = { balas: claim.balas, wait: claim.waitLabel };
      saveCooldown();
      if (bestScore <= claim.points) { bestScore = 0; saveBest(); }   // meta já resgatada
    }
    claim = null; screen = "rewards";
  }
  else if (id === "easy" || id === "hard") { mode = id; startGame(); }
  else if (id === "again") startGame();
  else if (id === "pause") pauseGame();
  else if (id === "resume") paused = false;
  else if (id === "menu") { screen = "menu"; paused = false; }
}

function pauseGame() {
  paused = true; keys.clear(); running = false; stick = null;
}

// Pressionar / soltar uma direção (teclado e botões de toque usam o mesmo código)
function holdKey(k, repeat) {
  if (screen !== "playing" || gameOver || paused) return;
  if (!repeat) {   // ignora o auto-repeat de segurar a tecla
    const now = performance.now();
    if (now - (lastPress[k] ?? -1e9) < DOUBLE_TAP_MS) running = true;   // toque duplo: corre
    else if (keys.size === 0) running = false;                         // toque simples sem outra tecla: devagar
    lastPress[k] = now;
  }
  keys.add(k);
}
function releaseKey(k) {
  keys.delete(k);
  if (keys.size === 0) running = false;   // só para de correr sem nenhuma tecla pressionada
}

// CONTROLES DE TOQUE (esquerda: cima/baixo | direita: esquerda/direita)
const touchControls = document.getElementById("touchControls");
let touchShown = false;

touchControls.querySelectorAll(".ctrl-btn").forEach(btn => {
  const k = btn.dataset.key;
  const down = e => {
    e.preventDefault();
    initAudio();
    btn.setPointerCapture(e.pointerId);
    btn.classList.add("active");
    holdKey(k, false);
  };
  const up = () => { btn.classList.remove("active"); releaseKey(k); };
  btn.addEventListener("pointerdown", down);
  btn.addEventListener("pointerup", up);
  btn.addEventListener("pointercancel", up);
  btn.addEventListener("lostpointercapture", up);
  btn.addEventListener("contextmenu", e => e.preventDefault());
});

// Mostra os botões só em celular/tela estreita e só durante a partida
function updateTouchControls() {
  const isCellphone = /Android.*Mobile|iPhone|iPod|Windows Phone|Mobile/i.test(navigator.userAgent) &&
                      matchMedia("(pointer: coarse)").matches;
  const show = screen === "playing" && !gameOver && !paused && isCellphone;
  if (show === touchShown) return;
  touchShown = show;
  touchControls.classList.toggle("controls-on", show);
  if (!show) touchControls.querySelectorAll(".ctrl-btn").forEach(b => b.classList.remove("active"));
}

// ENTRADA: TECLADO
document.addEventListener("keydown", e => {
  initAudio();
  const k = e.key.toLowerCase();
  const confirm = k === "enter" || k === " ";

  // Pausar / continuar com P ou Esc (Enter/Espaço também continuam)
  if (screen === "playing" && !gameOver) {
    if (!paused && (k === "p" || k === "escape")) { pauseGame(); e.preventDefault(); return; }
    if (paused && (k === "p" || k === "escape" || confirm)) { paused = false; e.preventDefault(); return; }
  }

  if ((screen === "rewards" || screen === "modes" || screen === "difficulty" || screen === "hall") && k === "escape") { screen = "menu"; return; }
  if (screen === "menu" && confirm) { screen = "modes"; e.preventDefault(); return; }
  if (screen === "modes" && (k === "1" || k === "2")) { press(k === "1" ? "classic" : "boss"); return; }
  if (screen === "difficulty" && (k === "1" || k === "2")) { press(k === "1" ? "easy" : "hard"); return; }
  if (screen === "playing" && gameOver && confirm) { startGame(); e.preventDefault(); return; }

  if (screen === "playing" && !gameOver && !paused &&
      ["w","a","s","d","arrowup","arrowdown","arrowleft","arrowright"].includes(k)) {
    e.preventDefault();
    holdKey(k, e.repeat);
  }
});
document.addEventListener("keyup", e => releaseKey(e.key.toLowerCase()));
window.addEventListener("blur", () => { keys.clear(); running = false; });

// ENTRADA: TOQUE / CLIQUE
canvas.addEventListener("pointerdown", e => {
  initAudio();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  const b = getButtons().find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (b) { press(b.id); return; }

  if (screen === "playing" && !gameOver && !paused && e.pointerType !== "mouse") {
    canvas.setPointerCapture(e.pointerId);
    stick = { id: e.pointerId, ox: x, oy: y, x, y };
  }
});
canvas.addEventListener("pointermove", e => {
  if (!stick || e.pointerId !== stick.id) return;
  const r = canvas.getBoundingClientRect();
  stick.x = e.clientX - r.left; stick.y = e.clientY - r.top;
});
const endStick = e => { if (stick && e.pointerId === stick.id) stick = null; };
canvas.addEventListener("pointerup", endStick);
canvas.addEventListener("pointercancel", endStick);

// FEEDBACK
function hit(good, x, y, pts = 1) {
  score = good ? score + pts : Math.max(0, score - pts);
  floats.push({ x, y, text: good ? "+" + pts : "-" + pts, color: good ? "#4dff88" : "#ff5a5a", life: 0.8 });
  flash = 0.2; flashColor = good ? "#4dff88" : "#ff5a5a";
  beep(good ? 880 : 180, good ? 0.08 : 0.15);
}

// Lista de áreas a evitar ao sortear itens (não nascem sobre brancos; encostar pode)
const proxyZone = o => ({ x: o.x, y: o.y, size: o.size, gap: 0, fixed: true });

// Zonas dos power-ups (gap 0: brancos não nascem em cima, mas podem ficar ao lado)
function powerupZones() { return powerups.map(proxyZone); }

function freeAvoid(skip) {
  return [
    { x: player.x, y: player.y, size: player.size, gap: 20, fixed: true },
    ...obstacles.map(proxyZone), ...powerupZones(), proxyZone(item),
    ...(fake && fake !== skip ? [proxyZone(fake)] : [])
  ];
}
function placeItem(o) {
  const p = safePosition(o.size, freeAvoid(o), 0);
  o.x = p.x; o.y = p.y;
}

// Mímico: nasce perto do bloco verdadeiro (40 a 90 px de distância entre os centros)
function placeNear(o, target) {
  const avoid = freeAvoid(o);
  for (let i = 0; i < 200; i++) {
    const ang = Math.random() * Math.PI * 2, d = 40 + Math.random() * 50;
    const box = { x: target.x + Math.cos(ang) * d, y: target.y + Math.sin(ang) * d, size: o.size };
    if (box.x < 0 || box.y < 0 || box.x + o.size > W() || box.y + o.size > H()) continue;
    if (!avoid.some(a => overlap(box, a, a.gap))) { o.x = box.x; o.y = box.y; return; }
  }
  placeItem(o);   // sem espaço perto: sorteia em qualquer lugar livre
}

// MODO FÁCIL: power-ups
function updatePowerups(dt) {
  magnetTime = Math.max(0, magnetTime - dt);
  shield = Math.max(0, shield - dt);
  powerups.forEach(p => p.life -= dt);
  powerups = powerups.filter(p => p.life > 0);

  puTimer -= dt;
  if (puTimer <= 0) {
    puTimer = 8 + Math.random() * 4;
    if (powerups.length < 2) {
      const p = { type: Math.random() < 0.5 ? "magnet" : "shield", size: 20, life: POWERUP_LIFE, x: 0, y: 0 };
      placeItem(p); powerups.push(p);
    }
  }

  powerups = powerups.filter(p => {
    if (!overlap(player, p)) return true;
    if (p.type === "magnet") { magnetTime = MAGNET_TIME; floats.push({ x: p.x, y: p.y, text: "ÍMÃ!", color: "#00ACFF", life: 0.8 }); }
    else { shield = SHIELD_TIME; floats.push({ x: p.x, y: p.y, text: "INVENCÍVEL!", color: "#4dff88", life: 0.8 }); }
    beep(660, 0.12);
    return false;
  });
}

// MODO DIFÍCIL: debuffs
const DEBUFFS = { invert: "TECLAS INVERSAS", slow: "LENTIDÃO (sem correr)", mimic: "BLOCOS MÍMICOS" };

function startDebuff(name) {
  debuff = name; debuffTime = DEBUFF_TIME;
  floats.push({ x: W() / 2 - 110, y: H() / 2 - 40, text: "DEBUFF: " + DEBUFFS[name], color: "#ff5a5a", life: 0.8 });
  beep(140, 0.3);
  if (name === "mimic") { fake = { x: 0, y: 0, size: 20 }; placeNear(fake, item); }
}
function endDebuff() { debuff = null; debuffTime = 0; fake = null; }

function updateDebuffs(dt) {
  if (debuff) { debuffTime -= dt; if (debuffTime <= 0) endDebuff(); }
  if (elapsed >= nextDebuffAt) {
    nextDebuffAt += DEBUFF_EVERY;
    const names = Object.keys(DEBUFFS);
    startDebuff(names[Math.floor(Math.random() * names.length)]);
  }
}

// Parede cyberpunk do KNIGHT: o chefe fica apoiado na borda superior.
const KNIGHT_WALL_H = 22;
function knightWallRect() {
  if (mode !== "boss" || bossIdx !== 2 || !boss || bossStage === "between" || bossStage === "dying") return null;
  return { x: 0, y: Math.min(H() - KNIGHT_WALL_H - 8, boss.y + boss.size), w: W(), h: KNIGHT_WALL_H };
}
function resolveKnightWall(oldY) {
  const wall = knightWallRect();
  if (!wall) return;
  if (player.x < wall.x + wall.w && player.x + player.size > wall.x &&
      player.y < wall.y + wall.h && player.y + player.size > wall.y) {
    // Impede atravessar a parede, mantendo o jogador no lado de onde veio.
    if (oldY + player.size <= wall.y + 2) player.y = wall.y - player.size;
    else if (oldY >= wall.y + wall.h - 2) player.y = wall.y + wall.h;
    else player.y = oldY < wall.y ? wall.y - player.size : wall.y + wall.h;
  }
}

// Movimento do jogador (teclado, botões de toque e joystick)
function movePlayer(dt) {
  // Stamina: correr gasta, descansar recupera; zerada, só volta a correr ao recuperar um pouco
  if (exhausted) running = false;
  if (running && keys.size > 0) { stamina = Math.max(0, stamina - STAMINA_DRAIN * dt); staminaDelay = 0.6; }
  else { staminaDelay -= dt; if (staminaDelay <= 0) stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * dt); }
  if (stamina <= 0) { exhausted = true; running = false; }
  else if (exhausted && stamina >= STAMINA_RESUME) exhausted = false;

  let dx = 0, dy = 0;
  const dirs = {
    a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0],
    w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1]
  };
  keys.forEach(k => {
    const f = running ? 1 : SLOW_FACTOR;
    dx += dirs[k][0] * f; dy += dirs[k][1] * f;
  });

  if (stick) {
    const vx = stick.x - stick.ox, vy = stick.y - stick.oy;
    const len = Math.hypot(vx, vy);
    if (len > 8) { dx += vx / Math.max(len, STICK_MAX); dy += vy / Math.max(len, STICK_MAX); }
  }

  if (debuff === "invert") { dx = -dx; dy = -dy; }   // teclas (e joystick) inversos

  const mag = Math.hypot(dx, dy);
  if (mag > 1) { dx /= mag; dy /= mag; }

  const oldY = player.y;
  player.x += dx * SPEED * dt;
  player.y += dy * SPEED * dt;
  clampEntity(player);
  keepPlayerBelowBossHud();
  resolveKnightWall(oldY);
  lastMove.x = dx; lastMove.y = dy;
}

// ===== MODO BOSS =====
const PLAYER_MAX_HP = 100;
let playerHP = PLAYER_MAX_HP;
let boss = null, drop = null, wave = null;
let bossStage = "intro", stageT = 0, shake = 0, furyFlash = 0;
let bossIdx = 0;                          // 0 = BULL, 1 = PEEP, 2 = KNIGHT
const firstOpportunityShown = new Set();   // aviso aparece apenas na primeira oportunidade de cada boss
let bolts = [], bands = [], horses = [], crate = null;   // PEEP (lasers, caixa) e KNIGHT (ondas, cavalos)
let endTitle = "TEMPO ESGOTADO!", endSub = "", endColor = "yellow";
const kb = { x: 0, y: 0 };         // empurrão da onda magnética
const lastMove = { x: 0, y: 0 };   // última direção de movimento do jogador

function bossSet(st) { boss.state = st; boss.t = 0; }

function spawnBoss() {
  const names = ["BULL", "PEEP", "KNIGHT"], i = bossIdx;
  const size = i === 1 ? 70 : 80;
  const homeY = (i === 0 || i === 1) ? H() / 2 - size / 2 : 110;
  boss = { idx: i, name: names[i], size, x: W() / 2 - size / 2, y: -size, startY: i === 1 ? homeY : -size, homeY,
           maxHp: 6, hp: 6, hpShown: 0, alpha: 0, state: i === 0 ? "aim" : "idle", t: 0, ang: Math.PI / 2, fury: false };
  if (i === 1) boss.y = homeY;   // PEEP aparece aos poucos no centro do mapa
}

function clearHazards() { wave = null; drop = null; bolts = []; bands = []; horses = []; crate = null; }


function endBossGame(title, sub, color) {
  gameOver = true; endTitle = title; endSub = sub; endColor = color || "yellow";
  shake = 0; furyFlash = 0;
  keys.clear(); running = false; stick = null;
  recordBest();
}

function damagePlayer(n) {
  playerHP -= n; invuln = 1.2; fade = FADE_TIME;
  floats.push({ x: player.x, y: player.y - 10, text: "-" + n, color: "#ff5a5a", life: 0.8 });
  flash = 0.2; flashColor = "#ff5a5a"; shake = Math.max(shake, 0.25);
  beep(150, 0.2);
  if (playerHP <= 0) { playerHP = 0; beep(300, 0.4); endBossGame("VOCÊ FOI DERROTADO!", "O " + (boss ? boss.name : "boss") + " venceu desta vez..."); }
}

function bossLaugh() {
  floats.push({ x: boss.x, y: boss.y - 12, text: "HA HA HA!", color: "#ff5a5a", life: 1.2 });
  [0, 130, 260].forEach((d, i) => setTimeout(() => beep(220 - i * 40, 0.12), d));
}

function startFury() {
  boss.fury = true; furyFlash = 1;
  floats.push({ x: W() / 2 - 70, y: H() / 2 - 40, text: "MODO FÚRIA!", color: "#ff6a00", life: 1.2 });
  beep(90, 0.5);
}

// Boss bate na parede: fica atordoado e larga o bloquinho branco
function showFirstOpportunity(message, aura) {
  if (!boss || firstOpportunityShown.has(boss.idx)) return;
  firstOpportunityShown.add(boss.idx);
  floats.push({ x: W() / 2, y: H() - 70, text: message, color: "#ffffff", life: 2.4, maxLife: 2.4, opacity: 0.5, centered: true });
  if (aura && drop) drop.aura = true;
}

function stunBoss() {
  bossSet("stun");
  const cx = boss.x + boss.size / 2, cy = boss.y + boss.size / 2;
  const dx = Math.max(0, Math.min(W() - 20, cx - Math.cos(boss.ang) * (boss.size / 2 + 30) - 10));
  const dy = Math.max(0, Math.min(H() - 20, cy - Math.sin(boss.ang) * (boss.size / 2 + 30) - 10));
  drop = { x: dx, y: dy, size: 20 };
  showFirstOpportunity("AGORA É SUA CHANCE!", boss.idx !== 1);
  if (boss.fury) { wave = { x: cx, y: cy, r: 10, hit: false }; shake = 0.5; beep(90, 0.3); }   // tremor + onda magnética
  else { shake = 0.15; beep(120, 0.15); }
}

function collectDrop() {
  hit(true, drop.x, drop.y, 2);   // +2 pontos
  drop = null;
  boss.hp -= 1;
  if (boss.hp <= 0) {
    score += 8;
    floats.push({ x: boss.x, y: boss.y - 12, text: "+8", color: "#4dff88", life: 1.2 });
    boss.hp = 0; boss.hpShown = 0; bossSet("dead"); bossStage = "dying"; stageT = 0; clearHazards();
  } else if (!boss.fury && boss.hp <= boss.maxHp / 2) startFury();
}

function updateBossFight(dt) {
  const b = boss, f = b.fury;
  b.hpShown += (b.hp - b.hpShown) * Math.min(1, dt * 8);
  b.t += dt;
  const bcx = b.x + b.size / 2, bcy = b.y + b.size / 2;
  const pcx = player.x + player.size / 2, pcy = player.y + player.size / 2;

  if (b.state === "aim") {                       // trava a mira no jogador
    b.ang = Math.atan2(pcy - bcy, pcx - bcx);
    if (b.t >= (f ? 0.5 : 1.1)) bossSet("windup");
  } else if (b.state === "windup") {             // pisca em vermelho (mira travada)
    if (b.t >= (f ? 0.35 : 0.7)) bossSet("dash");
  } else if (b.state === "dash") {               // arrancada
    const sp = f ? 1050 : 700;
    b.x += Math.cos(b.ang) * sp * dt; b.y += Math.sin(b.ang) * sp * dt;
    // A barreira invisível da HUD também bloqueia o BULL.
    const hudBarrierY = BOSS_HUD_SAFE_Y;
    if (b.y < hudBarrierY) {
      b.y = hudBarrierY;
      stunBoss();
    }
    if (b.state !== "stun" && invuln <= 0 && overlap(player, b)) {
      damagePlayer(f ? 30 : 15);
      if (!gameOver) { bossLaugh(); bossSet("recover"); }
    } else if (b.x < 0 || b.y < 0 || b.x + b.size > W() || b.y + b.size > H()) {
      b.x = Math.max(0, Math.min(b.x, W() - b.size));
      b.y = Math.max(0, Math.min(b.y, H() - b.size));
      stunBoss();
    }
  } else if (b.state === "recover") {
    if (b.t >= (f ? 0.4 : 1.0)) bossSet("aim");
  } else if (b.state === "stun") {
    if (b.t >= (f ? 2 : 4)) { drop = null; bossSet("aim"); }   // na fúria o atordoamento dura metade
  }
}

// ----- PEEP -----
function spawnCrate() {
  const size = 36, top = 110;   // a faixa do topo (vida, stamina, nome e barra do boss) fica sempre livre
  const avoid = [
    { x: boss.x, y: boss.y, size: boss.size, gap: 50, fixed: true },
    { x: player.x, y: player.y, size: player.size, gap: 80, fixed: true }
  ];
  const rand = () => ({ x: Math.random() * Math.max(1, W() - size), y: top + Math.random() * Math.max(1, H() - top - size) });
  let p = null;
  for (let i = 0; i < 200 && !p; i++) {
    const c = rand();
    if (!avoid.some(o => overlap({ x: c.x, y: c.y, size }, o, o.gap))) p = c;
  }
  if (!p) p = rand();
  crate = { x: Math.floor(p.x), y: Math.floor(p.y), size };
  showFirstOpportunity("Se algo acertasse essa caixa...", false);
}

function fireBolt(x, y, ang, f) {
  const sp = f ? 650 : 430;
  bolts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, bounces: 0, fury: f });
  beep(700, 0.05);
}

function updatePeepFight(dt) {
  const b = boss, f = b.fury;
  b.hpShown += (b.hp - b.hpShown) * Math.min(1, dt * 8);
  b.t += dt;
  const bcx = b.x + b.size / 2, bcy = b.y + b.size / 2;
  const pcx = player.x + player.size / 2, pcy = player.y + player.size / 2;
  if (b.state !== "spin") b.ang = Math.atan2(pcy - bcy, pcx - bcx);   // o olho segue o jogador

  if (b.state === "idle") {
    if (b.t >= 1.2) { bossSet("spin"); b.spinA = 0; b.dir = Math.random() < 0.5 ? 1 : -1; b.flipT = 0; }
  } else if (b.state === "spin") {                    // 2 lasers giratórios
    if (b.t > 0.9) {                                  // 0,9 s de aviso antes de ficarem ativos
      b.spinA += b.dir * (f ? 1.35 : 0.85) * dt;
      b.flipT += dt;
      if (b.flipT >= (f ? 1.8 : 2.5)) {               // troca o sentido de giro
        b.flipT = 0; b.dir *= -1;
        floats.push({ x: bcx - 10, y: bcy - b.size, text: b.dir > 0 ? "↻" : "↺", color: "#ff2bd6", life: 0.8 });
      }
      if (invuln <= 0) {
        for (const off of [0, Math.PI]) {
          const dx = Math.cos(b.spinA + off), dy = Math.sin(b.spinA + off);
          const rx = pcx - bcx, ry = pcy - bcy;
          if (rx * dx + ry * dy > 0 && Math.abs(rx * dy - ry * dx) < player.size / 2 + 5) { damagePlayer(f ? 16 : 8); break; }
        }
      }
    }
    if (b.t >= (f ? 6 : 7)) bossSet("draw");
  } else if (b.state === "draw") {                    // saca a arma laser
    if (b.t >= 0.8) { bossSet("gun"); b.shots = 0; b.shotT = 0; if (!crate) spawnCrate(); }
  } else if (b.state === "gun") {                     // 5 lasers em direção ao jogador (na fúria: mais rápidos e com ricochete)
    const total = 5, gap = f ? 0.28 : 0.5;
    b.shotT -= dt;
    if (b.shots < total && b.shotT <= 0) { fireBolt(bcx, bcy, b.ang, f); b.shots++; b.shotT = gap; }
    if (b.shots >= total && b.t > total * gap + 1.2) bossSet("rest");
  } else if (b.state === "rest") {
    if (b.t >= 1.0) bossSet("idle");
  }
}

// ----- KNIGHT -----
function pickGap() {
  const gw = boss.fury ? 80 : 100;
  return 40 + Math.random() * Math.max(1, W() - gw - 80);
}

function spawnHorse(dir, f) {
  const wall = knightWallRect();
  // Na fúria, os cavalos verticais descem a partir da parede do KNIGHT,
  // sem ficarem escondidos atrás da faixa de estatísticas.
  const verticalFuryFromWall = dir === "v" && f && !!wall;
  const side = verticalFuryFromWall ? 1 : (Math.random() < 0.5 ? 1 : -1), max = dir === "h" ? W() : H();
  const bossZone = boss ? { x: boss.x - 90, y: boss.y - 70, w: boss.size + 180, h: boss.size + 100 } : null;
  // Sorteia uma faixa fora da região inacessível ocupada pelo KNIGHT e sua parede.
  let lane = dir === "h" ? 60 + Math.random() * Math.max(1, H() - 120) : 40 + Math.random() * Math.max(1, W() - 80);
  for (let i = 0; i < 30; i++) {
    const candidate = dir === "h" ? 60 + Math.random() * Math.max(1, H() - 120) : 40 + Math.random() * Math.max(1, W() - 80);
    const intersectsBoss = bossZone && (dir === "h"
      ? candidate + 38 >= bossZone.y && candidate - 38 <= bossZone.y + bossZone.h
      : candidate + 38 >= bossZone.x && candidate - 38 <= bossZone.x + bossZone.w);
    const intersectsWall = wall && dir === "h" && candidate + 38 >= wall.y - 25 && candidate - 38 <= wall.y + wall.h + 25;
    if (!intersectsBoss && !intersectsWall) { lane = candidate; break; }
  }
  const startPos = verticalFuryFromWall
    ? wall.y + wall.h
    : (side > 0 ? -80 : max + 80);
  horses.push({ dir, side, lane,
                pos: startPos, speed: f ? 1000 : 750, warn: f ? 1.2 : 1.0, t: 0, dmg: f ? 30 : 15, fury: f, hit: false });
}

function updateKnightFight(dt) {
  const b = boss, f = b.fury;
  b.hpShown += (b.hp - b.hpShown) * Math.min(1, dt * 8);
  b.t += dt;
  const bcx = b.x + b.size / 2;

  if (b.state === "idle") {
    if (b.t >= 1.2) { b.waveN = 0; b.gapX = pickGap(); bossSet("swing"); }
  } else if (b.state === "swing") {                   // balança a espada e solta a onda de aura
    if (b.t >= (f ? 0.45 : 0.75)) {
      bands.push({ y: b.y + b.size, h: 24, gapX: b.gapX, gapW: f ? 80 : 100, speed: f ? 520 : 380, dmg: f ? 24 : 12, hit: false });
      beep(200, 0.15); shake = Math.max(shake, 0.12);
      b.waveN++;
      bossSet(b.waveN >= 3 ? "afterWaves" : "swingRest");
    }
  } else if (b.state === "swingRest") {
    if (b.t >= (f ? 0.8 : 1.3)) { b.gapX = pickGap(); bossSet("swing"); }
  } else if (b.state === "afterWaves") {
    if (b.t >= (f ? 1.2 : 1.8)) { bossSet("trumpet"); b.horseN = 0; b.spawnT = 0.8; beep(330, 0.4); }
  } else if (b.state === "trumpet") {                 // cavalos cibernéticos (6 vezes)
    b.spawnT -= dt;
    if (b.horseN < 6 && b.spawnT <= 0) {
      spawnHorse("h", f);
      if (f) spawnHorse("v", f);                      // na fúria vêm na vertical ao mesmo tempo
      b.horseN++; b.spawnT = f ? 0.65 : 1.0;
    }
    if (b.horseN >= 6 && horses.length === 0) {       // sem fôlego: larga o bloquinho branco
      bossSet("tired");
      drop = { x: bcx - 10, y: b.y + b.size + 25, size: 20, life: f ? 2.5 : 5 };
      // KNIGHT usa o estado "tired" como atordoamento: mostra o mesmo aviso
      // branco, centralizado na parte inferior e 50% transparente do BULL,
      // além de revelar o bloco com aura branca apenas na primeira vez.
      showFirstOpportunity("AGORA É SUA CHANCE!", true);
    }
  } else if (b.state === "tired") {
    if (b.t >= (f ? 2.5 : 5)) { drop = null; bossSet("idle"); }   // na fúria o cansaço dura metade
  }
}

// ----- Perigos compartilhados (lasers, ondas e cavalos) -----
function updateHazards(dt) {
  const pcx = player.x + player.size / 2, pcy = player.y + player.size / 2;

  bolts = bolts.filter(bo => {
    bo.x += bo.vx * dt; bo.y += bo.vy * dt;
    if (crate && bo.x > crate.x && bo.x < crate.x + crate.size && bo.y > crate.y && bo.y < crate.y + crate.size) {
      drop = { x: crate.x + 8, y: crate.y + 8, size: 20, life: 8, collectDelay: (boss && boss.idx === 1 && boss.fury) ? 1 : 0 };   // no modo fúria do PEEP, só pode pegar 1 s após a caixa quebrar
      floats.push({ x: crate.x, y: crate.y - 10, text: "CAIXA QUEBROU!", color: "#ffb703", life: 0.8 });
      crate = null; beep(300, 0.12);
      return false;
    }
    if (invuln <= 0 && Math.hypot(bo.x - pcx, bo.y - pcy) < player.size / 2 + 4) { damagePlayer(bo.fury ? 20 : 10); return false; }
    if (bo.x < 0 || bo.x > W() || bo.y < 0 || bo.y > H()) {
      if (bo.fury && bo.bounces < 3) {                // na fúria ricocheteia até 3 vezes
        bo.bounces++;
        if (bo.x < 0 || bo.x > W()) { bo.vx = -bo.vx; bo.x = Math.max(0, Math.min(W(), bo.x)); }
        if (bo.y < 0 || bo.y > H()) { bo.vy = -bo.vy; bo.y = Math.max(0, Math.min(H(), bo.y)); }
        return true;
      }
      return false;
    }
    return true;
  });

  bands.forEach(bd => {
    bd.y += bd.speed * dt;
    if (!bd.hit && invuln <= 0 && player.y < bd.y + bd.h && player.y + player.size > bd.y &&
        (player.x < bd.gapX || player.x + player.size > bd.gapX + bd.gapW)) { bd.hit = true; damagePlayer(bd.dmg); }
  });
  bands = bands.filter(bd => bd.y < H() + 10);

  horses.forEach(h => {
    h.t += dt;
    if (h.t < h.warn) return;
    h.pos += h.side * h.speed * dt;
    const collisionScale = h.fury ? 1.5 : 1.25; // aumento em relação à área atual: +25% normal, +50% fúria
    const crossSize = 76.5 * collisionScale;
    const r = h.dir === "h" ? { x: h.pos - 90, y: h.lane - crossSize / 2, w: 180, h: crossSize } : { x: h.lane - crossSize / 2, y: h.pos - 90, w: crossSize, h: 180 };
    if (!h.hit && invuln <= 0 && player.x < r.x + r.w && player.x + player.size > r.x &&
        player.y < r.y + r.h && player.y + player.size > r.y) { h.hit = true; damagePlayer(h.dmg); }
  });
  horses = horses.filter(h => h.side > 0 ? h.pos < (h.dir === "h" ? W() : H()) + 100 : h.pos > -100);

  if (drop && drop.collectDelay > 0) drop.collectDelay = Math.max(0, drop.collectDelay - dt);
  if (drop && drop.life !== undefined) { drop.life -= dt; if (drop.life <= 0) drop = null; }
}

// ===== VISUAL CYBERPUNK DOS BOSSES =====
const NEON = { cyan: "#00e5ff", magenta: "#ff2bd6", yellow: "#ffe600", red: "#ff2a4d", orange: "#ff6a00", dark: "#12081f" };
function neon(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
function noNeon() { ctx.shadowBlur = 0; }

// Corpo: aberração cromática, base escura, circuitos, scanlines e contorno neon
function cyberBody(x, y, w, h, base, edge, circuit) {
  ctx.fillStyle = "rgba(255,43,214,0.45)"; ctx.fillRect(x - 3, y, w, h);
  ctx.fillStyle = "rgba(0,229,255,0.45)"; ctx.fillRect(x + 3, y, w, h);
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = circuit; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 6, y + h * 0.3); ctx.lineTo(x + w * 0.35, y + h * 0.3); ctx.lineTo(x + w * 0.45, y + h * 0.45); ctx.lineTo(x + w - 8, y + h * 0.45);
  ctx.moveTo(x + 8, y + h * 0.78); ctx.lineTo(x + w * 0.5, y + h * 0.78); ctx.lineTo(x + w * 0.58, y + h * 0.64); ctx.lineTo(x + w - 6, y + h * 0.64);
  ctx.stroke();
  ctx.fillStyle = circuit; ctx.fillRect(x + w * 0.35 - 2, y + h * 0.3 - 2, 4, 4); ctx.fillRect(x + w * 0.5 - 2, y + h * 0.78 - 2, 4, 4);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  for (let yy = y + 2; yy < y + h; yy += 4) ctx.fillRect(x, yy, w, 1);
  neon(edge, 14); ctx.strokeStyle = edge; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h); noNeon();
}

function drawKnightWall() {
  const wall = knightWallRect();
  if (!wall) return;
  const { x, y, w, h } = wall;
  ctx.fillStyle = "#111629"; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#25233d"; ctx.fillRect(x, y + 3, w, h - 6);
  ctx.fillStyle = "rgba(0,229,255,0.18)";
  for (let xx = 0; xx < w; xx += 48) ctx.fillRect(xx + 4, y + 4, 24, h - 8);
  ctx.strokeStyle = NEON.magenta; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let xx = 0; xx < w; xx += 96) {
    ctx.moveTo(xx, y + h - 3); ctx.lineTo(xx + 16, y + h - 3);
    ctx.lineTo(xx + 27, y + 5); ctx.lineTo(xx + 48, y + 5);
  }
  ctx.stroke();
  ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  ctx.strokeStyle = "rgba(255,230,0,0.9)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, y + h); ctx.lineTo(w, y + h); ctx.stroke();
  for (let xx = 12; xx < w; xx += 64) {
    ctx.fillStyle = xx % 128 === 12 ? NEON.cyan : NEON.magenta;
    ctx.fillRect(xx, y + 7, 4, 4);
  }
  neon(NEON.cyan, 10); ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 1;
  ctx.strokeRect(0, y, w, h); noNeon();
}

function drawHazards() {
  if (crate) {                                         // caixa de metal quebrada, com rachaduras neon
    const x = crate.x, y = crate.y, s = crate.size;
    ctx.fillStyle = "#23233a"; ctx.fillRect(x, y, s, s);
    ctx.fillStyle = "rgba(0,0,0,0.3)"; for (let yy = y + 3; yy < y + s; yy += 4) ctx.fillRect(x, yy, s, 1);
    neon(NEON.yellow, 10); ctx.strokeStyle = NEON.yellow; ctx.lineWidth = 3; ctx.strokeRect(x, y, s, s); noNeon();
    ctx.fillStyle = NEON.cyan;
    [[3, 3], [s - 7, 3], [3, s - 7], [s - 7, s - 7]].forEach(([a, b]) => ctx.fillRect(x + a, y + b, 4, 4));
    neon(NEON.magenta, 8); ctx.strokeStyle = NEON.magenta; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 18, y); ctx.lineTo(x + 13, y + 10); ctx.lineTo(x + 22, y + 18); ctx.lineTo(x + 15, y + 28); ctx.lineTo(x + 19, y + s); ctx.stroke(); noNeon();
    ctx.fillStyle = "#140032";
    ctx.beginPath(); ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + 12); ctx.lineTo(x + s - 11, y); ctx.fill();
  }
  horses.forEach(h => {
    if (h.t < h.warn) {                                // aviso vermelho com a mesma largura da colisão
      const warningSize = 76.5 * (h.fury ? 1.5 : 1.25);
      ctx.fillStyle = "rgba(255,42,77," + (0.12 + 0.18 * (Math.floor(h.t * 10) % 2)) + ")";
      ctx.strokeStyle = "rgba(255,42,77,0.8)"; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
      if (h.dir === "h") { ctx.fillRect(0, h.lane - warningSize / 2, W(), warningSize); ctx.strokeRect(0, h.lane - warningSize / 2, W(), warningSize); }
      else {
        // No modo fúria, a faixa vertical começa na base da parede do KNIGHT,
        // nunca na área superior reservada às estatísticas.
        const wall = h.fury ? knightWallRect() : null;
        const warningTop = wall ? wall.y + wall.h : 0;
        const warningHeight = Math.max(0, H() - warningTop);
        ctx.fillRect(h.lane - warningSize / 2, warningTop, warningSize, warningHeight);
        ctx.strokeRect(h.lane - warningSize / 2, warningTop, warningSize, warningHeight);
      }
      ctx.setLineDash([]);
      return;
    }
    // Aumenta a dimensão visual transversal do cavalo até corresponder à
    // espessura da sua área de colisão, para o jogador perceber melhor o perigo.
    const visualCollisionSize = 76.5 * (h.fury ? 1.5 : 1.25);
    // Ajuste independente dos eixos: o cavalo ocupa exatamente a caixa de
    // colisão (180 px no sentido do movimento e visualCollisionSize no eixo transversal).
    // Os desenhos-base medem aprox. 130x44 px na horizontal; na vertical, os eixos invertem.
    const scaleAlong = 180 / 130;
    const scaleAcross = visualCollisionSize / 44;
    ctx.save();
    ctx.translate(h.pos, h.lane);
    ctx.scale(h.dir === "h" ? scaleAlong : scaleAcross,
              h.dir === "h" ? scaleAcross : scaleAlong);
    ctx.translate(-h.pos, -h.lane);
    const tl = 130;                                    // rastro de luz
    ctx.fillStyle = "rgba(0,229,255,0.22)";
    if (h.dir === "h") ctx.fillRect(h.side > 0 ? h.pos - 40 - tl : h.pos + 40, h.lane - 12, tl, 24);
    else ctx.fillRect(h.lane - 12, h.side > 0 ? h.pos - 40 - tl : h.pos + 40, 24, tl);
    neon(NEON.cyan, 12); ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 2; ctx.fillStyle = "#08202e";
    if (h.dir === "h") {
      ctx.fillRect(h.pos - 40, h.lane - 14, 70, 28); ctx.strokeRect(h.pos - 40, h.lane - 14, 70, 28);
      [-34, -14, 6, 22].forEach(d => ctx.strokeRect(h.pos + d, h.lane + 14, 8, 10));
      neon(NEON.magenta, 12); ctx.fillStyle = NEON.magenta; ctx.fillRect(h.pos + (h.side > 0 ? 30 : -60), h.lane - 20, 30, 22);
      ctx.fillStyle = "#fff"; ctx.fillRect(h.pos + (h.side > 0 ? 44 : -50), h.lane - 14, 6, 4);
    } else {
      ctx.fillRect(h.lane - 14, h.pos - 40, 28, 70); ctx.strokeRect(h.lane - 14, h.pos - 40, 28, 70);
      [-34, -14, 6, 22].forEach(d => ctx.strokeRect(h.lane + 14, h.pos + d, 10, 8));
      neon(NEON.magenta, 12); ctx.fillStyle = NEON.magenta; ctx.fillRect(h.lane - 20, h.pos + (h.side > 0 ? 30 : -60), 22, 30);
      ctx.fillStyle = "#fff"; ctx.fillRect(h.lane - 14, h.pos + (h.side > 0 ? 44 : -50), 4, 6);
    }
    noNeon();
    ctx.restore();
  });
  bands.forEach(bd => {                                // ondas de aura do KNIGHT: parede de energia
    [[0, bd.gapX], [bd.gapX + bd.gapW, W()]].forEach(([x0, x1]) => {
      const w = x1 - x0;
      if (w <= 0) return;
      ctx.fillStyle = "rgba(0,229,255,0.35)"; ctx.fillRect(x0, bd.y, w, bd.h);
      ctx.fillStyle = "rgba(255,43,214,0.35)"; for (let xx = x0; xx < x1; xx += 24) ctx.fillRect(xx, bd.y, 8, bd.h);
      neon(NEON.cyan, 14); ctx.fillStyle = "#e8ffff"; ctx.fillRect(x0, bd.y + bd.h - 3, w, 3); noNeon();
    });
  });
  bolts.forEach(bo => {                                // lasers do PEEP: brilho + núcleo branco
    const m = Math.hypot(bo.vx, bo.vy) || 1, col = bo.fury ? NEON.magenta : NEON.cyan;
    ctx.beginPath(); ctx.moveTo(bo.x - bo.vx / m * 22, bo.y - bo.vy / m * 22); ctx.lineTo(bo.x, bo.y);
    neon(col, 14); ctx.strokeStyle = col; ctx.lineWidth = 6; ctx.stroke(); noNeon();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  });
}

function drawBull(b) {
  const cx = b.x + b.size / 2, cy = b.y + b.size / 2;
  const jx = b.state === "dead" ? (Math.random() - 0.5) * 10 : 0, jy = b.state === "dead" ? (Math.random() - 0.5) * 10 : 0;
  const x = b.x + jx, y = b.y + jy, s = b.size;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, b.alpha));
  if (b.state === "aim" || b.state === "windup") {     // linha de mira neon
    neon(NEON.red, 10); ctx.strokeStyle = "rgba(255,42,77,0.7)"; ctx.lineWidth = 3; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(b.ang) * 170, cy + Math.sin(b.ang) * 170); ctx.stroke();
    ctx.setLineDash([]); noNeon();
  }
  const blink = b.state === "windup" && Math.floor(b.t * 12) % 2 === 0;
  const edge = blink ? NEON.red : (b.fury ? NEON.orange : NEON.magenta);
  cyberBody(x, y, s, s, blink ? "#5a0014" : (b.fury ? "#2b0a05" : "#1a0b2e"), edge, "rgba(0,229,255,0.55)");

  neon(NEON.cyan, 16); ctx.fillStyle = "#b8f7ff";      // chifres de aço neon
  ctx.beginPath(); ctx.moveTo(x, y + 12); ctx.lineTo(x - 16, y - 14); ctx.lineTo(x + 22, y); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + s, y + 12); ctx.lineTo(x + s + 16, y - 14); ctx.lineTo(x + s - 22, y); ctx.fill();
  noNeon();

  const lx = Math.cos(b.ang) * 4, ly = Math.sin(b.ang) * 4;   // olhos-visor seguem a mira
  [-18, 18].forEach(d => {
    neon(b.fury ? NEON.yellow : NEON.red, 14); ctx.fillStyle = b.fury ? NEON.yellow : NEON.red;
    ctx.fillRect(cx + d - 8 + jx, cy - 14 + jy, 16, 9); noNeon();
    ctx.fillStyle = "#fff"; ctx.fillRect(cx + d - 2 + lx + jx, cy - 12 + ly + jy, 4, 4);
  });
  ctx.fillStyle = "#0a0414"; ctx.fillRect(cx - 16 + jx, cy + 14 + jy, 32, 14);   // focinho com argola neon
  neon(NEON.yellow, 10); ctx.strokeStyle = NEON.yellow; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx + jx, cy + 28 + jy, 6, 0, Math.PI); ctx.stroke(); noNeon();

  if (b.state === "stun") {                            // estrelas neon sobre a cabeça
    neon(NEON.yellow, 10); ctx.fillStyle = NEON.yellow; ctx.font = "bold 22px Arial"; ctx.textAlign = "center";
    for (let i = 0; i < 3; i++) {
      const a = performance.now() / 300 + i * 2.1;
      ctx.fillText("★", cx + Math.cos(a) * 32, b.y - 14 + Math.sin(a) * 8);
    }
    noNeon(); ctx.textAlign = "left";
  }
  ctx.restore();
}

function drawPeep(b) {
  const cx = b.x + b.size / 2, cy = b.y + b.size / 2, r = b.size / 2;
  const j = b.state === "dead" ? (Math.random() - 0.5) * 10 : 0;
  const col = b.fury ? NEON.orange : NEON.magenta;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, b.alpha));
  if (b.state === "spin") {                            // lasers giratórios neon
    const L = Math.hypot(W(), H()), charge = b.t <= 0.9;
    [0, Math.PI].forEach(off => {
      const a = (b.spinA || 0) + off;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L);
      if (charge) { ctx.strokeStyle = "rgba(255,43,214,0.5)"; ctx.lineWidth = 2; ctx.setLineDash([10, 10]); ctx.stroke(); ctx.setLineDash([]); }
      else { neon(col, 18); ctx.strokeStyle = col; ctx.lineWidth = 10; ctx.stroke(); noNeon(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.stroke(); }
    });
  }
  ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.lineDashOffset = -performance.now() / 40;
  ctx.beginPath(); ctx.arc(cx + j, cy + j, r + 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);   // anel orbital
  ctx.fillStyle = NEON.dark; ctx.beginPath(); ctx.arc(cx + j, cy + j, r, 0, Math.PI * 2); ctx.fill();   // núcleo
  neon(col, 16); ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.stroke(); noNeon();
  ctx.strokeStyle = "rgba(0,229,255,0.7)"; ctx.lineWidth = 2;                                            // arcos de circuito
  [[0.2, 1.1], [2.0, 3.0], [3.8, 4.6]].forEach(([a0, a1]) => {
    const o = performance.now() / 2000;
    ctx.beginPath(); ctx.arc(cx + j, cy + j, r - 8, a0 + o, a1 + o); ctx.stroke();
  });
  neon(NEON.cyan, 14); ctx.fillStyle = "#e8ffff";                                                         // olho
  ctx.beginPath(); ctx.arc(cx + j, cy + j, 21, 0, Math.PI * 2); ctx.fill(); noNeon();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx + j + Math.cos(b.ang) * 9, cy + j + Math.sin(b.ang) * 9, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.2)"; for (let yy = cy - 21; yy < cy + 21; yy += 4) ctx.fillRect(cx - 21, yy, 42, 1);
  if (b.state === "draw" || b.state === "gun") {       // arma laser
    ctx.translate(cx, cy); ctx.rotate(b.ang);
    ctx.fillStyle = "#1b1b2f"; ctx.fillRect(r - 4, -6, 36, 12);
    neon(NEON.cyan, 10); ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 2; ctx.strokeRect(r - 4, -6, 36, 12);
    ctx.fillStyle = "#fff"; ctx.fillRect(r + 30, -3, 6, 6); noNeon();
  }
  ctx.restore();
}

function drawKnight(b) {
  const cx = b.x + b.size / 2, tired = b.state === "tired", dy = tired ? 8 : 0;
  const jx = b.state === "dead" ? (Math.random() - 0.5) * 10 : 0, jy = b.state === "dead" ? (Math.random() - 0.5) * 10 : 0;
  const x = b.x + jx, y = b.y + jy + dy, s = b.size;
  const edge = tired ? "#4a6fa5" : (b.fury ? NEON.magenta : NEON.cyan);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, b.alpha));
  if (b.state === "swing") {                           // marca neon da brecha por onde dá para passar
    const gw = b.fury ? 60 : 100;
    neon("#4dff88", 10); ctx.strokeStyle = "rgba(77,255,136," + (0.5 + 0.5 * Math.sin(performance.now() / 80)) + ")"; ctx.lineWidth = 4;
    [b.gapX, b.gapX + gw].forEach(gx => { ctx.beginPath(); ctx.moveTo(gx, b.y + b.size); ctx.lineTo(gx, H()); ctx.stroke(); });
    noNeon();
  }
  cyberBody(x, y, s, s - dy, tired ? "#0e1623" : (b.fury ? "#1d0a2b" : "#101a33"), edge, "rgba(255,43,214,0.5)");
  const vis = b.fury ? NEON.yellow : NEON.magenta;     // viseira neon com varredura
  neon(vis, 14); ctx.fillStyle = vis; ctx.fillRect(x + 14, y + 24, 52, 10); noNeon();
  ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(x + 14 + (Math.floor(performance.now() / 300) % 3) * 18, y + 24, 6, 10);
  neon(NEON.magenta, 12); ctx.fillStyle = NEON.magenta;   // crista
  ctx.beginPath(); ctx.moveTo(cx - 8 + jx, b.y + jy); ctx.lineTo(cx + jx, b.y - 22 + jy); ctx.lineTo(cx + 8 + jx, b.y + jy); ctx.fill(); noNeon();
  ctx.save();                                          // espada de energia
  const wind = b.fury ? 0.45 : 0.75;
  const ang = b.state === "swing" ? -2.2 + Math.min(1, b.t / wind) * 2.4 : -0.5;
  ctx.translate(cx + 44 + jx, b.y + 34 + jy); ctx.rotate(ang);
  neon(NEON.cyan, 16); ctx.fillStyle = NEON.cyan; ctx.fillRect(-5, -74, 10, 74); noNeon();
  ctx.fillStyle = "#fff"; ctx.fillRect(-2, -72, 4, 70);
  neon(NEON.yellow, 8); ctx.fillStyle = NEON.yellow; ctx.fillRect(-11, -4, 22, 6); noNeon();
  ctx.restore();
  if (b.state === "trumpet") {                         // trombeta neon
    neon(NEON.yellow, 12); ctx.fillStyle = NEON.yellow; ctx.fillRect(cx - 6, b.y + b.size - 8, 40, 8);
    ctx.beginPath(); ctx.moveTo(cx + 34, b.y + b.size - 4); ctx.lineTo(cx + 54, b.y + b.size - 18); ctx.lineTo(cx + 54, b.y + b.size + 10); ctx.fill(); noNeon();
  }
  if (tired) {                                         // suor
    ctx.fillStyle = NEON.cyan;
    for (let i = 0; i < 3; i++) {
      const t = (performance.now() / 400 + i / 3) % 1;
      ctx.beginPath(); ctx.arc(b.x + b.size + 8 + i * 6, b.y + 6 + t * 30, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function updateBoss(dt) {
  stageT += dt;
  runTime += dt;   // tempo total da run (não conta enquanto pausado)
  furyFlash = Math.max(0, furyFlash - dt * 1.2);

  if (bossStage === "intro") {                   // jogador sozinho no mapa
    movePlayer(dt);
    if (stageT >= 3) { bossStage = "cutscene"; stageT = 0; spawnBoss(); }
    return;
  }
  if (bossStage === "cutscene") {                // boss entra, barra de vida enche
    const p = Math.min(1, stageT / 3.5), e = 1 - Math.pow(1 - p, 3);
    boss.y = boss.startY + (boss.homeY - boss.startY) * e;
    boss.alpha = Math.min(1, p * 2); boss.hpShown = boss.maxHp * p;

    // A entrada do boss pode ocupar a faixa inferior da arena. Se o jogador
    // ficou dentro dessa estrutura durante a cutscene, empurra-o para baixo
    // dela e também mantém a zona das estatísticas livre.
    keepPlayerBelowBossHud();
    // A barra cinematográfica inferior (parede preta com borda neon azul)
    // é uma zona inacessível durante a entrada de QUALQUER boss. Se o jogador
    // estiver nela ou ultrapassar sua borda, empurra-o para cima da linha.
    const cinematicBottomTop = H() - 52; // topo da faixa preta/linha ciano inferior
    if (player.y + player.size > cinematicBottomTop) {
      player.y = Math.max(50, cinematicBottomTop - player.size);
    }

    const bossLeft = boss.x, bossRight = boss.x + boss.size;
    const playerOverBossX = player.x < bossRight && player.x + player.size > bossLeft;
    const structureBottom = boss.y + boss.size + (boss.idx === 2 ? KNIGHT_WALL_H : 12);
    if (playerOverBossX && player.y < structureBottom && player.y + player.size > boss.y) {
      player.y = Math.min(cinematicBottomTop - player.size, structureBottom);
    }
    if (p >= 1) { bossStage = "fight"; stageT = 0; bossSet(boss.idx === 0 ? "aim" : "idle"); }
    return;
  }

  movePlayer(dt);
  const oldY = player.y;
  player.x += kb.x * dt; player.y += kb.y * dt; clampEntity(player); keepPlayerBelowBossHud(); resolveKnightWall(oldY);
  const damp = Math.max(0, 1 - 6 * dt); kb.x *= damp; kb.y *= damp;

  if (bossStage === "between") {                 // pequena pausa antes da próxima cutscene
    if (stageT >= 1.5) { bossStage = "cutscene"; stageT = 0; spawnBoss(); }
    return;
  }
  if (bossStage === "dying") {
    boss.alpha = Math.max(0, 1 - stageT / 2.5);
    if (stageT >= 2.5) {
      if (bossIdx < 2) {                           // próximo boss: BULL -> PEEP -> KNIGHT
        bossIdx++; bossStage = "between"; stageT = 0; boss = null; clearHazards();
        playerHP = Math.min(PLAYER_MAX_HP, playerHP + 30);
        floats.push({ x: player.x, y: player.y - 12, text: "+30 VIDA", color: "#4dff88", life: 1.2 });
      } else {
        const ms = Math.round(runTime * 1000);
        submitIf("bossBestMs", ms);                // recorde de velocidade (menor tempo)
        endBossGame("VOCÊ SALVOU A CYBERÓPOLIS!", "Parabéns, herói! Tempo total: " + fmtRun(ms), "#4dff88");
      }
    }
    return;
  }

  [updateBossFight, updatePeepFight, updateKnightFight][bossIdx](dt);
  if (gameOver) return;
  updateHazards(dt);
  if (gameOver) return;

  if (wave) {                                    // onda magnética (modo fúria)
    wave.r += 420 * dt;
    const d = Math.hypot(player.x + player.size / 2 - wave.x, player.y + player.size / 2 - wave.y);
    if (!wave.hit && invuln <= 0 && Math.abs(d - wave.r) < 24) {
      wave.hit = true;
      let px = -lastMove.x, py = -lastMove.y;    // empurra para o lado oposto ao que ia
      if (Math.hypot(px, py) < 0.1) { px = player.x + player.size / 2 - wave.x; py = player.y + player.size / 2 - wave.y; }
      const m = Math.hypot(px, py) || 1;
      kb.x = px / m * 700; kb.y = py / m * 700;
      damagePlayer(10);
      if (gameOver) return;
    }
    if (wave && wave.r > 170) wave = null;
  }

  if (drop && (drop.collectDelay || 0) <= 0 && overlap(player, drop)) collectDrop();
}

// Barras acima do personagem: vida (verde, só no modo boss) e stamina (azul)
function drawPlayerBars() {
  const showHP = mode === "boss";
  const w = player.size + 16, x = player.x + player.size / 2 - w / 2, h = 5;
  const n = showHP ? 2 : 1, totalH = n * h + (n - 1) * 2;
  let y = player.y - 6 - totalH;
  if (y < 2) y = player.y + player.size + 6;   // perto do topo da tela: desenha embaixo
  const bar = (ratio, color) => {
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, ratio)), h);
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    y += h + 2;
  };
  if (showHP) bar(playerHP / PLAYER_MAX_HP, "#4dff88");
  bar(stamina / STAMINA_MAX, exhausted && Math.floor(performance.now() / 150) % 2 ? "#5b7a99" : "#00ACFF");
}

function drawBossScene() {
  drawKnightWall();
  if (wave) {
    ctx.globalAlpha = Math.max(0, 1 - wave.r / 170);
    ctx.strokeStyle = "#00ACFF"; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(wave.x, wave.y, wave.r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (drop) {
    const s = drop.size * (1 + 0.15 * Math.sin(performance.now() / 120));
    const cx = drop.x + drop.size / 2, cy = drop.y + drop.size / 2;
    if (drop.aura && boss && boss.idx !== 1) {
      const pulse = 1 + 0.12 * Math.sin(performance.now() / 100);
      ctx.save(); ctx.globalAlpha = 0.75; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3;
      ctx.shadowColor = "#ffffff"; ctx.shadowBlur = 22;
      ctx.beginPath(); ctx.arc(cx, cy, drop.size * 1.25 * pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 0.22; ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(cx, cy, drop.size * 1.1 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.save(); ctx.shadowColor = "#ff2638"; ctx.shadowBlur = 14;
    ctx.fillStyle = "#ff2638";
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s); ctx.restore();
  }
  drawHazards();
  if (!boss) return;
  if (boss.idx === 1) { drawPeep(boss); return; }
  if (boss.idx === 2) { drawKnight(boss); return; }

  drawBull(boss);
}

function drawBossHud() {
  const pw = Math.min(150, W() / 2 - 60), px = 15, py = 44;   // vida do jogador
  const r = Math.max(0, playerHP / PLAYER_MAX_HP);
  ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(px, py, pw, 12);
  ctx.fillStyle = r > 0.5 ? "#4dff88" : r > 0.25 ? "#ffb703" : "#ff5a5a";
  ctx.fillRect(px, py, pw * r, 12);
  ctx.strokeStyle = "white"; ctx.lineWidth = 2; ctx.strokeRect(px, py, pw, 12);
  const sy = py + 16;                                 // stamina logo abaixo da barra verde
  ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(px, sy, pw, 8);
  ctx.fillStyle = exhausted && Math.floor(performance.now() / 150) % 2 ? "#5b7a99" : "#00ACFF";
  ctx.fillRect(px, sy, pw * Math.max(0, Math.min(1, stamina / STAMINA_MAX)), 8);
  ctx.strokeStyle = "white"; ctx.lineWidth = 2; ctx.strokeRect(px, sy, pw, 8);

  if (boss && (bossStage !== "cutscene" || stageT > 0.3)) {   // nome e barra do boss
    const bw = Math.min(W() - 40, 480), bx = W() / 2 - bw / 2, by = 78;
    ctx.textAlign = "center";
    const col = boss.fury ? NEON.orange : NEON.magenta;
    neon(col, 12); ctx.fillStyle = col;
    ctx.font = "bold 18px 'Arial Black', Arial, sans-serif";
    ctx.fillText(boss.name, W() / 2, 72); noNeon();
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(bx, by, bw, 16);
    neon(col, 10); ctx.fillStyle = col;
    ctx.fillRect(bx, by, bw * Math.max(0, boss.hpShown / boss.maxHp), 16); noNeon();
    ctx.fillStyle = "rgba(0,0,0,0.55)";               // divisões: 1 por ponto de vida
    for (let i = 1; i < boss.maxHp; i++) ctx.fillRect(bx + bw * i / boss.maxHp - 1, by, 2, 16);
    neon(NEON.cyan, 8); ctx.strokeStyle = NEON.cyan; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, 16); noNeon();
    ctx.textAlign = "left";
  }
  if (bossStage === "intro" && stageT > 1.2) {
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 150);
    ctx.fillStyle = "#ff5a5a"; ctx.font = "bold 20px Arial"; ctx.textAlign = "center";
    ctx.fillText("Algo se aproxima...", W() / 2, H() * 0.3);
    ctx.textAlign = "left"; ctx.globalAlpha = 1;
  }
  if (bossStage === "cutscene") {                     // barras de cinema
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, W(), 50); ctx.fillRect(0, H() - 50, W(), 50);
    neon(NEON.cyan, 10); ctx.fillStyle = NEON.cyan; ctx.fillRect(0, 50, W(), 2); ctx.fillRect(0, H() - 52, W(), 2); noNeon();
  }
  if (furyFlash > 0) {
    ctx.fillStyle = "rgba(255,0,0," + (furyFlash * 0.35) + ")";
    ctx.fillRect(0, 0, W(), H());
  }
}

// ATUALIZAÇÃO
function update(dt) {
  if (paused) return;
  shake = Math.max(0, shake - dt);
  floats.forEach(f => { f.life -= dt; f.y -= 40 * dt; });
  floats = floats.filter(f => f.life > 0);
  flash = Math.max(0, flash - dt);
  invuln = Math.max(0, invuln - dt);
  fade = Math.max(0, fade - dt);
  if (screen !== "playing" || gameOver) return;

  if (mode === "boss") { updateBoss(dt); return; }

  timeLeft -= dt;
  if (timeLeft <= 0) {
    timeLeft = 0; gameOver = true; keys.clear(); running = false; stick = null; beep(300, 0.4);
    recordBest();
    submitRecord();
    return;
  }

  // Modo difícil: blocos vão e voltam o tempo todo
  if (mode === "hard") {
    elapsed += dt;
    obstacles.forEach(o => {
      const s = Math.sin(elapsed * o.spd + o.phase) * o.amp;
      o.x = o.ax + (o.axis === 0 ? s : 0);
      o.y = o.ay + (o.axis === 1 ? s : 0);
      clampEntity(o);
    });
  }

  if (mode === "easy") updatePowerups(dt); else if (mode === "hard") updateDebuffs(dt);
  if (debuff === "slow") running = false;   // lentidão: não pode correr

  movePlayer(dt);

  // Item vermelho: nasce em qualquer lugar, sem ficar em cima de brancos
  // Ímã atua só no bloco vermelho que dá pontos (nunca nos power-ups)
  const magnetReach = mode === "easy" && magnetTime > 0 &&
    Math.hypot(player.x + player.size / 2 - (item.x + item.size / 2),
               player.y + player.size / 2 - (item.y + item.size / 2)) < MAGNET_RADIUS;
  if (overlap(player, item) || magnetReach) {
    hit(true, item.x, item.y, mode === "hard" ? HARD_ITEM_POINTS : 1);
    placeItem(item);
    if (fake) placeNear(fake, item);
    collected++;
    if (mode === "easy" && collected % ITEMS_PER_SHUFFLE === 0) shuffleObstacles();
  }
  // Bloco mímico (falso): tira 1 ponto
  if (fake && overlap(player, fake)) {
    hit(false, fake.x, fake.y, 1);
    placeNear(fake, item);
  }

  // Obstáculos
  if (mode === "easy") {
    obstacles.forEach(obs => {
      if (shield <= 0 && overlap(player, obs)) {
        hit(false, obs.x, obs.y);
        const others = obstacles.filter(o => o !== obs);
        const p = safePosition(obs.size, [player, item, ...powerupZones(), ...others], 60);
        obs.x = p.x; obs.y = p.y;
      }
    });
  } else if (invuln <= 0) {
    const obs = obstacles.find(o => overlap(player, o));
    if (obs) { hit(false, obs.x, obs.y, SPIKE_DAMAGE); invuln = INVULN_TIME; fade = FADE_TIME; }
  }
}

// DESENHO
function drawButton(b) {
  if (b.outline) {
    ctx.strokeStyle = "yellow"; ctx.lineWidth = 3;
    ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
    ctx.fillStyle = "yellow";
  } else {
    ctx.fillStyle = b.color || "yellow";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#140032";
  }
  ctx.textAlign = "center";
  ctx.font = "bold " + (b.font || 26) + "px Arial";
  ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + (b.sub ? -4 : 8));
  if (b.sub) { ctx.font = "14px Arial"; ctx.fillText(b.sub, b.x + b.w / 2, b.y + b.h / 2 + 20); }
  ctx.textAlign = "left";
}

function drawSpiky(o) {
  const s = o.size, t = 5, n = 3, w = (s - 2 * t) / n;
  ctx.fillRect(o.x + t, o.y + t, s - 2 * t, s - 2 * t);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = o.x + t + i * w, b = o.y + t + i * w;
    ctx.moveTo(a, o.y + t); ctx.lineTo(a + w / 2, o.y); ctx.lineTo(a + w, o.y + t);
    ctx.moveTo(a, o.y + s - t); ctx.lineTo(a + w / 2, o.y + s); ctx.lineTo(a + w, o.y + s - t);
    ctx.moveTo(o.x + t, b); ctx.lineTo(o.x, b + w / 2); ctx.lineTo(o.x + t, b + w);
    ctx.moveTo(o.x + s - t, b); ctx.lineTo(o.x + s, b + w / 2); ctx.lineTo(o.x + s - t, b + w);
  }
  ctx.fill();
}

function drawTitle(text, size, y, color) {
  ctx.fillStyle = color; ctx.textAlign = "center";
  ctx.font = "bold " + size + "px 'Arial Black', Arial, sans-serif";
  const tw = ctx.measureText(text).width;
  if (tw > W() - 40) {   // reduz a fonte se o texto não couber na tela
    ctx.font = "bold " + Math.floor(size * (W() - 40) / tw) + "px 'Arial Black', Arial, sans-serif";
  }
  ctx.fillText(text, W() / 2, y);
  ctx.textAlign = "left";
}

function draw() {
  ctx.fillStyle = "#140032";
  ctx.fillRect(0, 0, W(), H());
  const cy = H() / 2;

  if (screen === "login") { drawLogin(); return; }
  if (screen === "hall") { drawHall(); return; }
  if (screen === "menu") {
    drawTitle("CYBER TECH GAME", 52, menuLayout().top - 38, "yellow");
    getButtons().forEach(drawButton);
    if (me) {
      ctx.fillStyle = "#00e5ff"; ctx.font = "bold 14px Arial"; ctx.textAlign = "right";
      ctx.fillText("Jogador: " + me.name, W() - 15, 24);
      ctx.textAlign = "left";
    }
    return;
  }
  if (screen === "modes") {
    drawTitle("ESCOLHA O MODO DE JOGO", 34, cy - 100, "yellow");
    getButtons().forEach(drawButton);
    ctx.fillStyle = "white"; ctx.font = "14px Arial"; ctx.textAlign = "center";
    ctx.fillText("ou pressione 1 (clássico) / 2 (boss) · Esc para voltar", W() / 2, cy + 198);
    ctx.textAlign = "left";
    return;
  }
  if (screen === "difficulty") {
    drawTitle("ESCOLHA A DIFICULDADE", 34, cy - 100, "yellow");
    getButtons().forEach(drawButton);
    ctx.fillStyle = "white"; ctx.font = "14px Arial"; ctx.textAlign = "center";
    ctx.fillText("ou pressione 1 (fácil) / 2 (difícil) · Esc para voltar", W() / 2, cy + 198);
    ctx.textAlign = "left";
    return;
  }

  if (screen === "rewards") { drawRewards(); return; }
  if (screen === "congrats") { drawCongrats(); return; }

  ctx.fillStyle = "white";
  obstacles.forEach(o => mode === "hard" ? drawSpiky(o) : ctx.fillRect(o.x, o.y, o.size, o.size));

  powerups.forEach(p => {
    if (p.life < 2 && Math.floor(p.life * 6) % 2 === 0) return;   // pisca antes de sumir
    if (p.type === "shield") {
      ctx.fillStyle = "#2ecc40"; ctx.fillRect(p.x, p.y, p.size, p.size);
    } else {
      ctx.fillStyle = "#00ACFF"; ctx.fillRect(p.x, p.y, p.size / 2, p.size);
      ctx.fillStyle = "red"; ctx.fillRect(p.x + p.size / 2, p.y, p.size / 2, p.size);
    }
  });

  if (fake) { ctx.fillStyle = "#a30000"; ctx.fillRect(fake.x, fake.y, fake.size, fake.size); }
  ctx.fillStyle = "red";
  ctx.fillRect(item.x, item.y, item.size, item.size);

  if (mode === "boss") drawBossScene();

  // Após o dano fica a 15% e vai ficando visível aos poucos até 100%
  ctx.globalAlpha = fade > 0 ? 0.15 + 0.85 * (1 - fade / FADE_TIME) : 1;
  ctx.fillStyle = flash > 0 ? flashColor : "yellow";
  ctx.fillRect(player.x, player.y, player.size, player.size);
  if (running && keys.size > 0) {
    ctx.strokeStyle = "white"; ctx.lineWidth = 3;
    ctx.strokeRect(player.x, player.y, player.size, player.size);
  }
  if (magnetTime > 0) {
    ctx.strokeStyle = "rgba(0,172,255,0.45)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(player.x + player.size / 2, player.y + player.size / 2, MAGNET_RADIUS, 0, Math.PI * 2); ctx.stroke();
  }
  if (shield > 0) {
    ctx.strokeStyle = "#4dff88"; ctx.lineWidth = 4;
    ctx.strokeRect(player.x - 4, player.y - 4, player.size + 8, player.size + 8);
  }
  ctx.globalAlpha = 1;
  drawPlayerBars();

  ctx.font = "bold 20px Arial";
  floats.forEach(f => {
    const fadeAlpha = f.maxLife ? Math.min(1, f.life / 0.45) : Math.max(0, f.life / 0.8);
    ctx.globalAlpha = fadeAlpha * (f.opacity === undefined ? 1 : f.opacity);
    ctx.fillStyle = f.color;
    if (f.centered) ctx.textAlign = "center";
    ctx.fillText(f.text, f.x, f.y);
    if (f.centered) ctx.textAlign = "left";
  });
  ctx.globalAlpha = 1;

  if (stick) {
    const vx = stick.x - stick.ox, vy = stick.y - stick.oy;
    const len = Math.hypot(vx, vy) || 1;
    const k = Math.min(len, STICK_MAX) / len;
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(stick.ox, stick.oy, STICK_MAX, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,0,0.6)";
    ctx.beginPath(); ctx.arc(stick.ox + vx * k, stick.oy + vy * k, 22, 0, Math.PI * 2); ctx.fill();
  }

  // HUD
  ctx.shadowColor = "black"; ctx.shadowBlur = 5;
  ctx.fillStyle = "white";
  ctx.font = "bold 22px 'Arial Black', Arial, sans-serif";
  ctx.fillText("Pontuação: " + score, 15, 30);
  ctx.font = "bold 14px Arial";
  if (mode !== "boss") ctx.fillText(mode === "easy"
    ? "Troca de blocos: " + (collected % ITEMS_PER_SHUFFLE) + "/" + ITEMS_PER_SHUFFLE
    : "Modo difícil: espinhos -" + SPIKE_DAMAGE + " · vermelho +" + HARD_ITEM_POINTS, 15, 52);
  if (mode === "easy") {
    if (magnetTime > 0) { ctx.fillStyle = "#00ACFF"; ctx.fillText("Ímã: " + Math.ceil(magnetTime) + "s", 15, 72); }
    if (shield > 0) { ctx.fillStyle = "#4dff88"; ctx.fillText("Invencível: " + Math.ceil(shield) + "s", 15, 92); }
    ctx.fillStyle = "white";
  } else if (debuff) {
    ctx.fillStyle = "#ff5a5a"; ctx.textAlign = "center";
    ctx.fillText("DEBUFF: " + DEBUFFS[debuff] + " (" + Math.ceil(debuffTime) + "s)", W() / 2, 66);
    ctx.textAlign = "left"; ctx.fillStyle = "white";
  }
  ctx.font = "bold 22px 'Arial Black', Arial, sans-serif";
  ctx.textAlign = "right";
  if (mode !== "boss") ctx.fillText("Tempo: " + Math.ceil(timeLeft), W() - 15, 30);
  ctx.textAlign = "left";

  if (!gameOver && mode !== "boss" && timeLeft > GAME_TIME - 6) {
    ctx.font = "bold 16px Arial"; ctx.textAlign = "center";
    ctx.fillText(touchShown ? "Use os botões (toque 2x rápido para correr)"
                            : "WASD / setas (toque 2x rápido para correr) ou arraste o dedo",
                 W() / 2, touchShown ? 100 : H() - 20);
    ctx.textAlign = "left";
  }
  ctx.shadowBlur = 0;

  if (mode === "boss") drawBossHud();
  if (!gameOver && !paused) getButtons().forEach(drawButton);

  if (gameOver) {
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, 0, W(), H());
    drawTitle(endTitle, 45, cy - 70, endColor);
    if (endSub) { ctx.fillStyle = "white"; ctx.font = "bold 16px Arial"; ctx.textAlign = "center"; ctx.fillText(endSub, W() / 2, cy - 44); ctx.textAlign = "left"; }
    ctx.fillStyle = "#00ACFF"; ctx.font = "bold 28px Arial"; ctx.textAlign = "center";
    ctx.fillText("Pontuação final: " + score, W() / 2, cy - 20);
    const reachedMeta = tierFor(score);
    if (reachedMeta) {
      const wl = cooldownLeft();
      ctx.fillStyle = wl > 0 ? "#ffb703" : "#4dff88"; ctx.font = "bold 16px Arial";
      ctx.fillText(wl > 0 ? "Meta atingida! Aguarde " + fmtTime(wl) + " para resgatar"
                          : "Meta atingida! Você ganhou " + balasText(reachedMeta.balas), W() / 2, cy + 6);
    }
    getButtons().forEach(drawButton);
    ctx.fillStyle = "white"; ctx.font = "14px Arial"; ctx.textAlign = "center";
    ctx.fillText("ou pressione Enter / Espaço", W() / 2, cy + (canClaimNow(score) ? 237 : 165));
    ctx.textAlign = "left";
  }

  if (paused) {
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(0, 0, W(), H());
    drawTitle("PAUSADO", 45, cy - 60, "yellow");
    getButtons().forEach(drawButton);
    ctx.fillStyle = "white"; ctx.font = "14px Arial"; ctx.textAlign = "center";
    ctx.fillText("P / Esc / Enter para continuar", W() / 2, cy + 130);
    ctx.textAlign = "left";
  }
}

// LOOP PRINCIPAL
function loop(ts) {
  const dt = Math.min((ts - (last || ts)) / 1000, 0.1);
  last = ts;
  update(dt);
  updateTouchControls();
  syncNameInput();
  ctx.save();
  if (shake > 0 && screen === "playing" && !gameOver) {   // tremor de tela (só durante a partida)
    const m = 14 * Math.min(1, shake * 2);
    ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
  }
  draw();
  ctx.restore();
  requestAnimationFrame(loop);
}

// ===== MÚSICA DE FUNDO =====
const MUSIC_VOLUME = 0.5;   // 50% do volume do aparelho da pessoa
const bgm = new Audio("assets/audio/cyberpunk-suspense.mp3");
bgm.loop = true;            // repete sem parar
bgm.volume = MUSIC_VOLUME;
bgm.preload = "auto";

let musicStarted = false;
const MUSIC_EVENTS = ["pointerdown", "touchend", "click", "keydown"];

// Os navegadores só liberam áudio depois de uma interação:
// a música começa na primeira vez que a pessoa tocar, clicar ou digitar.
function startMusic() {
  bgm.play().then(() => {
    musicStarted = true;
    MUSIC_EVENTS.forEach(ev => window.removeEventListener(ev, startMusic, true));
  }).catch(() => {});       // se o navegador recusar, tenta de novo na próxima interação
}
MUSIC_EVENTS.forEach(ev => window.addEventListener(ev, startMusic, true));

// Pausa quando a aba vai para segundo plano e volta quando a pessoa retorna
document.addEventListener("visibilitychange", () => {
  if (!musicStarted) return;
  if (document.hidden) bgm.pause(); else bgm.play().catch(() => {});
});

loadMe();
if (!me) screen = "login";   // primeira vez: pede o nome de usuário
syncMe();
loadBest();
loadCooldown();
resizeCanvas();
requestAnimationFrame(loop);