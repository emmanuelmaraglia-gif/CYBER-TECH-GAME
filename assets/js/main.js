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

  // ---------------- FIREBASE (Firestore + login anônimo: cada nome tem um dono) ----------------
  if (useFirebase) {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const fs = firebase.firestore(), auth = firebase.auth();
    let uid = null;                                   // identifica o dono de cada nome (login anônimo, invisível para o jogador)
    const ready = auth.signInAnonymously().then(c => { uid = c.user.uid; });
    ready.catch(err => console.error("Falha no login anônimo do Firebase (ative Authentication → Anônimo):", err));
    const players = () => fs.collection("players");
    const metaRef = fs.collection("meta").doc("leaderboard");

    const readTop = async (field, dir) => {
      const snap = await players().where(field, ">", 0).orderBy(field, dir).limit(10).get();
      return snap.docs.map(d => ({ name: d.data().name, value: d.data()[field] }));
    };

    // Monta a fotografia consolidada (Top 10) a partir dos recordes individuais.
    // Plano gratuito (Spark): feito no cliente; as regras do Firestore limitam create/update.
    const buildSnapshotPayload = async () => {
      const [easy, hard, boss] = await Promise.all([
        readTop("easyBest", "desc"),
        readTop("hardBest", "desc"),
        readTop("bossBestMs", "asc")
      ]);
      return {
        easy,
        hard,
        boss,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
    };

    // Cria o 1º ciclo se ainda não existir; se já existir e passaram 24h, renova.
    // Se as regras recusarem (ainda dentro das 24h), mantém o snapshot anterior.
    const maybeRefreshLeaderboard = async () => {
      try {
        const current = await metaRef.get();
        const payload = await buildSnapshotPayload();
        if (!current.exists) {
          await metaRef.set(payload);
          return;
        }
        // Tentativa de update — as regras só permitem se updatedAt + 24h <= agora.
        await metaRef.update(payload);
      } catch (err) {
        // permission-denied = ciclo de 24h ainda ativo (esperado) ou regras/auth.
        // Não interrompe a gravação do recorde individual do jogador.
        if (err && err.code !== "permission-denied") {
          console.warn("Hall da Fama: não foi possível atualizar o snapshot:", err);
        }
      }
    };

    return {
      mode: "firebase", keyOf, ready,

      // Nome ocupado = já existe e pertence a OUTRO aparelho (o dono, no mesmo aparelho, pode entrar de novo)
      async isNameTaken(name) {
        await ready;
        const d = await players().doc(keyOf(name)).get();
        return d.exists && d.data().uid !== uid;
      },

      // O ID do documento é o nome normalizado; o "uid" guarda quem é o dono.
      // Se o nome já existe e é de outra pessoa, recusa. Duas pessoas nunca ficam com o mesmo nome.
      async claimName(name) {
        await ready;
        const ref = players().doc(keyOf(name));
        return fs.runTransaction(async t => {
          const d = await t.get(ref);
          if (d.exists) return d.data().uid === uid ? { ok: true, record: pick(d.data()) } : { ok: false, reason: "taken" };
          t.set(ref, { uid, name, createdAt: firebase.firestore.FieldValue.serverTimestamp(), easyBest: 0, hardBest: 0 });
          return { ok: true, record: pick({}) };
        });
      },

      async submit(me, field, value) {
        if (!["easyBest", "hardBest", "bossBestMs"].includes(field) || !(value > 0)) return;
        await ready;
        const ref = players().doc(keyOf(me.name));
        await fs.runTransaction(async t => {
          const d = await t.get(ref);
          if (!d.exists) throw new Error("Jogador não encontrado no Hall da Fama.");
          if (d.data().uid !== uid) throw new Error("Esse nome pertence a outro jogador.");   // só o dono grava recordes
          const old = d.data()[field] || 0;
          const better = field === "bossBestMs" ? (!old || value < old) : value > old;
          if (better) t.update(ref, { [field]: value });
        });
        // O Hall consulta diretamente /players; não depende de uma fotografia de 24 horas.
      },

      async getLeaderboards() {
        // Consulta os recordes atuais em /players a cada abertura do Hall.
        // Não depende de meta/leaderboard nem de ciclos de 24 horas.
        const [easy, hard, boss] = await Promise.all([
          readTop("easyBest", "desc"),
          readTop("hardBest", "desc"),
          readTop("bossBestMs", "asc")
        ]);
        return { easy, hard, boss, updatedAt: Date.now() };
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
      if (!(value > 0)) return;
      const p = players(), k = keyOf(me.name);
      p[k] = p[k] || { name: me.name, easyBest: 0, hardBest: 0 };
      const better = field === "bossBestMs" ? (!p[k][field] || value < p[k][field]) : value > (p[k][field] || 0);
      if (better) { p[k][field] = value; write(PK, p); }
      let snap = read(SK, null);
      if (!snap) {
        snap = { updatedAt: Date.now(), easy: top(p, "easyBest", true), hard: top(p, "hardBest", true), boss: top(p, "bossBestMs", false) };
        write(SK, snap);
      }
    },

    async getLeaderboards() {
      let snap = read(SK, null);
      // Não cria o primeiro ciclo apenas por abrir o Hall; exige pontuação válida.
      if (!snap) return { updatedAt: null, easy: [], hard: [], boss: [] };
      return snap;
    }
  };
})();

// ################################################################
// PARTE 3 — O JOGO
// ################################################################
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const runnerIcon = new Image();
runnerIcon.src = "assets/imagens/running-icon.png";

// CONFIGURAÇÕES
const TOTAL_OBSTACLES = 50;
const SPEED = 420;
const GAME_TIME = 120;
const STICK_MAX = 60;       // raio do analógico (limite de puxada)
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
let screen = "menu";        // telas do jogo
let mode = "easy";          // "easy" | "hard"
let player = { x: 0, y: 0, size: 40 };
let item = { x: 0, y: 0, size: 20 };
let obstacles = [];
let floats = [];
let score = 0, collected = 0, timeLeft = GAME_TIME, elapsed = 0, invuln = 0, fade = 0;
let gameOver = false;
let flash = 0, flashColor = "#fff";
let last = 0, running = false, stick = null, audio = null;
let sprintPointer = null, sprintHeld = false;
let paused = false;
let confirmMenu = false;   // pergunta "voltar ao menu?" na pausa (modo clássico)
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
  // Também aceita zonas retangulares (w/h), usadas para reservar espaço aos controles móveis.
  const bw = b.w ?? b.size, bh = b.h ?? b.size;
  return a.x < b.x + bw + m && a.x + a.size > b.x - m &&
         a.y < b.y + bh + m && a.y + a.size > b.y - m;
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
  // Usa a área realmente disponível ao canvas, não a janela inteira: em celulares
  // a barra do navegador/teclado virtual pode alterar a altura visível.
  const rect = canvas.getBoundingClientRect();
  const nextWidth = Math.max(100, Math.round(rect.width));
  const nextHeight = Math.max(100, Math.round(rect.height));
  if (canvas.width !== nextWidth) canvas.width = nextWidth;
  if (canvas.height !== nextHeight) canvas.height = nextHeight;
  [player, item, ...obstacles].forEach(clampEntity);
  obstacles.forEach(o => {
    if (o.ax !== undefined) { o.ax = Math.max(0, Math.min(o.ax, W() - o.size)); o.ay = Math.max(0, Math.min(o.ay, H() - o.size)); }
  });
}
window.addEventListener("resize", resizeCanvas);
if (window.visualViewport) window.visualViewport.addEventListener("resize", resizeCanvas);

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
  confirmMenu = false; stickRunning = false; sprintHeld = false; sprintPointer = null;
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
  const p = safePosition(item.size, [player, pauseZone(), ...locomotionControlZones()], 80);
  item.x = p.x; item.y = p.y; keepOffPause(item);

  const cfg = obstacleSettings();
  const playerMargin = Math.min(hard ? 65 : 70, Math.min(W(), H()) / 3);
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
  DB.submit(me, field, value).catch(err => console.error("Falha ao salvar/sincronizar recorde no Firebase:", err));
}
function submitRecord() {
  if (mode === "easy") submitIf("easyBest", score);
  else if (mode === "hard") submitIf("hardBest", score);
}
function syncMe() {                                  // reenvia recordes guardados (ex.: se estava sem internet)
  if (!me) return;
  DB.ready.then(() => ["easyBest", "hardBest", "bossBestMs"].forEach(f => { if (me[f]) DB.submit(me, f, me[f]).catch(err => console.error("Falha ao reenviar recorde " + f + ":", err)); })).catch(err => console.error("Falha ao preparar sincronização de recordes:", err));
}

// ----- LOGIN -----
const sanitizeName = v => v.replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s{2,}/g, " ").slice(0, 20);
const validName = n => n.length >= 3 && n.length <= 20;
function setLoginMsg(text, ok) { loginMsg = text; loginMsgOk = !!ok; }

// Filtro multilingue para combinações numéricas proibidas no nome.
// A normalização remove acentos e trata hífens/pontuação como separadores.
const normalizeNumberWords = value => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const NUMBER_WORDS = {
  six: ["six", "seis", "sei", "sis", "seis", "seis", "sechs", "zes", "sex", "seks", "kuusi", "shest", "shest", "liu", "roku", "yuk", "chhah", "chhe", "choy", "sita", "shash", "sześć", "szesc", "sześć", "sze", "sest", "sest", "sáu", "sau", "enam", "anim", "si", "sitta", "sitta", "sitta", "sitt", "sittin", "sittun", "six", "sixieme"],
  seven: ["seven", "sete", "siete", "sept", "sieben", "zeven", "sju", "syv", "seitsemän", "seitsem", "siedem", "sedm", "sim", "sem", "epta", "yedi", "sab'a", "sabaa", "saba", "sheva", "shiva", "saat", "sat", "sapt", "tujuh", "bay", "qi", "nana", "shichi", "ilgop", "ilgot", "hét", "sedam", "sedam", "sedam", "sette", "sju", "septyni", "septyni", "seitse", "seitseman", "fitu", "saba"],
  sixty: ["sixty", "soixante", "sesenta", "sessenta", "sessanta", "sechzig", "zestig", "sextio", "seksti", "sexti", "kuusikymmenta", "shestdesyat", "shestdesiat", "szescdziesiat", "sześćdziesiąt", "šedesát", "sedesat", "saessak", "rokujuu", "rokujū", "liushi", "liu shi", "altmis", "altmış", "sittun", "sittin", "saath", "saTh", "satth"],
  four: ["four", "quatre", "cuatro", "quattro", "vier", "vier", "fyra", "fire", "nelja", "chetyre", "cztery", "ctyri", "dort", "dort", "arbaa", "arba", "empat", "bon", "si", "yon", "shi", "yon", "net", "char", "chaar", "negy", "neli", "neli", "fourth", "empat", "patru", "patru", "cuatro", "kvar", "neljä", "nelja", "tetras", "cuatro"],
  forty: ["forty", "quarante", "cuarenta", "quarenta", "quaranta", "vierzig", "veertig", "fyrtio", "fyrre", "neljakymmenta", "sorok", "czterdziesci", "czterdzieści", "ctyricet", "kyrti", "kirk", "kirk", "karante", "chetyrdesyat", "chotrom", "chulop", "yonjuu", "yonju", "sish", "arbaun", "chalis", "chollis"],
  two: ["two", "deux", "dos", "due", "zwei", "twee", "tva", "to", "kaksi", "dva", "dve", "dwa", "dwie", "iki", "ithnan", "ithnayn", "shnayim", "do", "hai", "dua", "hai", "song", "er", "ni", "i", "dois", "duas", "du", "twо", "twee", "dous", "duo", "dva", "dve", "bi", "rendu", "randu", "dua", "dalawa", "duha"],
  one: ["one", "um", "uma", "uno", "una", "un", "une", "eins", "ein", "een", "ett", "en", "yksi", "odin", "odin", "jeden", "jeden", "bir", "wahid", "wahed", "ek", "ichi", "il", "satu", "mot", "yi", "yat", "eka", "satu"]
};
// Inclui também as formas de dezenas para cobrir expressões como "sessenta e sete" e "quarenta e dois".
const hasAnyNumberWord = (tokens, forms) => tokens.some(token => forms.includes(token));
function forbiddenNameCombinationKind(name) {
  const normalized = normalizeNumberWords(name);
  const tokens = normalized ? normalized.split(/\s+/) : [];
  const compact = normalized.replace(/\s+/g, "");
  // Lista explícita de formas coladas: evita que nomes como "sixseven" escapem
  // do filtro por diferenças de normalização, espaços ou pontuação.
  const joinedForbidden = new Set([
    "sixseven", "sevensix", "six7", "7six", "67", "76",
    "sixtyseven", "seventysixty", "sessentaesete", "seteesessenta",
    "sessentaesete", "sesentaysiete", "sieteysesenta", "soixantesept",
    "septsoixante", "sessantaesette", "settesessanta", "sechzigsieben",
    "siebensechzig", "zestigzeven", "zevenzestig",
    "fortytwo", "twoforty", "quarentaedois", "doisequarenta",
    "cuarentaydos", "dosycuarenta", "quarantadue", "duequaranta",
    "sixtyone", "onesixty", "sessentaeum", "umsessenta",
    "sesentayuno", "unoysesenta", "soixanteetun", "unsoixante"
  ]);
  if (joinedForbidden.has(compact)) {
    if (["sixseven", "sevensix", "six7", "7six", "67", "76", "sixtyseven", "seventysixty", "sessentaesete", "seteesessenta", "sesentaysiete", "sieteysesenta", "soixantesept", "septsoixante", "sessantaesette", "settesessanta", "sechzigsieben", "siebensechzig", "zestigzeven", "zevenzestig"].includes(compact)) return "67";
    if (["fortytwo", "twoforty", "quarentaedois", "doisequarenta", "cuarentaydos", "dosycuarenta", "quarantadue", "duequaranta"].includes(compact)) return "42";
    if (["sixtyone", "onesixty", "sessentaeum", "umsessenta", "sesentayuno", "unoysesenta", "soixanteetun", "unsoixante"].includes(compact)) return "61";
  }
  const hasDigit6 = /6/.test(name), hasDigit7 = /7/.test(name);
  const hasDigit4 = /4/.test(name), hasDigit2 = /2/.test(name), hasDigit1 = /1/.test(name);
  if (hasDigit6 && hasDigit7) return "67";
  if (hasDigit4 && hasDigit2) return "42";
  if (hasDigit6 && hasDigit1) return "61";

  const sixWords = NUMBER_WORDS.six.concat(NUMBER_WORDS.sixty);
  const sevenWords = NUMBER_WORDS.seven;
  const fourWords = NUMBER_WORDS.four.concat(NUMBER_WORDS.forty);
  const twoWords = NUMBER_WORDS.two;
  const oneWords = NUMBER_WORDS.one;
  if (hasAnyNumberWord(tokens, sixWords) && hasAnyNumberWord(tokens, sevenWords)) return "67";
  if (hasAnyNumberWord(tokens, fourWords) && hasAnyNumberWord(tokens, twoWords)) return "42";
  if (hasAnyNumberWord(tokens, sixWords) && hasAnyNumberWord(tokens, oneWords)) return "61";

  // Também reconhece palavras coladas, como "sixseven", sem espaço ou hífen.
  // Exige pelo menos 3 letras em cada parte para reduzir falsos positivos.
  const hasJoinedPair = (leftForms, rightForms) => leftForms.some(left => {
    const a = normalizeNumberWords(left).replace(/\s+/g, "");
    if (a.length < 3) return false;
    return rightForms.some(right => {
      const b = normalizeNumberWords(right).replace(/\s+/g, "");
      return b.length >= 3 && (compact.includes(a + b) || compact.includes(b + a));
    });
  });
  if (hasJoinedPair(sixWords, sevenWords)) return "67";
  if (hasJoinedPair(fourWords, twoWords)) return "42";
  if (hasJoinedPair(sixWords, oneWords)) return "61";

  // Formas compostas e traduções frequentes das dezenas, com ou sem espaços/pontuação.
  const compactForms = forms => forms.some(form => compact.includes(normalizeNumberWords(form).replace(/\s+/g, "")));
  if (compactForms([
    "sessenta e sete", "sixty seven", "soixante sept", "sesenta y siete", "sessanta e sette", "sechzig sieben", "zestig zeven",
    "sechzig sieben", "szescdziesiat siedem", "šedesát sedm", "sedesat sedam", "shestdesyat sem", "shestdesyat sem", "liushi qi",
    "rokujuu nana", "rokujuu shichi", "yukju seot", "altmis yedi", "sittio sju", "seksti syv", "kuusikymmenta seitseman"
  ])) return "67";
  if (compactForms([
    "quarenta e dois", "forty two", "quarante deux", "cuarenta y dos", "quaranta e due", "vierzig zwei", "veertig twee",
    "czterdziesci dwa", "štyridsať dva", "sorok dva", "yonjuu ni", "liushi er", "arbaain ithnan", "chalis do", "neljakymmenta kaksi"
  ])) return "42";
  if (compactForms([
    "sessenta e um", "sixty one", "soixante et un", "soixante un", "sesenta y uno", "sessanta e uno", "sechzig eins", "zestig een",
    "szescdziesiat jeden", "šedesát jedna", "sedesat jedan", "shestdesyat odin", "liushi yi", "rokujuu ichi", "altmis bir", "sittio ett", "seksti en"
  ])) return "61";
  return "";
}
function forbiddenNameCombination(name) {
  return forbiddenNameCombinationKind(name) ? "Tá achando que vai farmar aura betinha?" : "";
}

// Filtro de nomes ofensivos: cobre palavrões, insultos e termos discriminatórios comuns
// em português, inglês, espanhol, francês e alemão. A normalização também reduz
// tentativas simples de evasão com números (ex.: 4ssh0le) e letras repetidas.
const OFFENSIVE_NAME_MESSAGE = "Esse nome não é permitido. Escolha outro!";
const offensiveWords = new Set((`
porra caralho cacete merda bosta bostaço foda foder fodeu fodase pqp puta puto putinha putaria cu cuzao cuzão arrombado babaca otario otaria idiota imbecil desgracado desgracada vagabundo vagabunda corno corna escroto escrota lixo nojento nojenta vaca cadela filhodaputa fodido fodida viado viada bicha sapatão sapatona traveco nazista nazi racista racismo xenofobo homofobico machista fascista
fuck fucking fucked motherfucker shit bullshit bitch bastard asshole asswipe dick dickhead prick cunt whore slut piss douchebag dumbass jackass twat wanker bollocks arsehole faggot fag shemale tranny nigger nigga chink spic kike wetback cracker retard retarded nazi hitler
puta puto mierda joder jodido cabron cabrona pendejo pendeja gilipollas coño maricon zorra perra hijodeputa malparido malparida
merde putain connard connasse salope encule enculer pute batard con conne salaud tapette pede
scheisse arschloch hurensohn fotze fick ficke schwuchtel miststuck
`).split(/\s+/).map(w => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").toLowerCase()).filter(Boolean));
function normalizeForOffensiveCheck(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[0134578@$!]/g, ch => ({"0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","8":"b","@":"a","$":"s","!":"i"}[ch] || ch))
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function offensiveNameDetected(name) {
  const normalized = normalizeForOffensiveCheck(name);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  // Bloqueia palavras inteiras para evitar falsos positivos em nomes comuns.
  if (tokens.some(token => offensiveWords.has(token))) return true;
  // Também bloqueia algumas expressões ofensivas compostas, mesmo com espaços/hífens.
  const compact = normalized.replace(/\s+/g, "");
  return ["sonofabitch", "motherfucker", "hijodeputa", "filhodaputa", "filhadaputa", "goawaynazi", "whitepower", "heilhitler", "killall", "racista", "homofobico", "xenofobo", "nazi"].some(term => compact.includes(term)) ||
    [...offensiveWords].some(term => term.length >= 5 && compact.includes(term));
}
function blockedNameReason(name) {
  return forbiddenNameCombination(name) || (offensiveNameDetected(name) ? OFFENSIVE_NAME_MESSAGE : "");
}

// Efeito de áudio: voz (com som) → phonk do 0:00.
// Estratégia anti-Android: recria o Audio da voz a cada play (estado limpo)
// e NÃO pula para a phonk se a voz falhar na 1ª tentativa — tenta de novo.
const VOICE_SRC = "assets/audio/aura-betinha-voz.mp3";
const PHONK_SRC = "assets/audio/aura-phonk.mp3";

let auraVoice = new Audio(VOICE_SRC);
auraVoice.preload = "auto";
auraVoice.volume = 1.0;

let auraPhonk = new Audio(PHONK_SRC);
auraPhonk.preload = "auto";
auraPhonk.volume = 1.0;

let auraEffectActive = false;

function playAuraEffect() {
  if (auraEffectActive) return;
  auraEffectActive = true;

  try { bgm.pause(); } catch (e) {}

  // Para phonk se estiver tocando
  try {
    auraPhonk.pause();
    auraPhonk.currentTime = 0;
    auraPhonk.muted = false;
    auraPhonk.volume = 1.0;
  } catch (e) {}

  // Recria a voz do zero (evita estado "muted/pausado" preso no Android)
  try { auraVoice.pause(); } catch (e) {}
  auraVoice = new Audio(VOICE_SRC);
  auraVoice.preload = "auto";
  auraVoice.volume = 1.0;
  auraVoice.muted = false;

  const startPhonk = () => {
    if (!auraEffectActive) return;
    try {
      auraPhonk.muted = false;
      auraPhonk.volume = 1.0;
      auraPhonk.currentTime = 0;
    } catch (e) {}
    const p = auraPhonk.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        setTimeout(() => {
          if (!auraEffectActive) return;
          try { auraPhonk.currentTime = 0; } catch (e) {}
          auraPhonk.play().catch(() => {
            auraEffectActive = false;
            if (musicStarted && !document.hidden) {
              try { bgm.play().catch(() => {}); } catch (e) {}
            }
          });
        }, 150);
      });
    }
  };

  auraPhonk.onended = () => {
    if (!auraEffectActive) return;
    auraEffectActive = false;
    if (musicStarted && !document.hidden) {
      try { bgm.play().catch(() => {}); } catch (e) {}
    }
  };

  auraVoice.onended = startPhonk;
  auraVoice.onerror = () => {
    // Se o arquivo da voz falhar de verdade, aí sim vai para a phonk
    startPhonk();
  };

  // Toca a voz; se a 1ª tentativa falhar, tenta DE NOVO antes de ir para a phonk
  const tryPlayVoice = (attempt) => {
    if (!auraEffectActive) return;
    const pr = auraVoice.play();
    if (pr && typeof pr.then === "function") {
      pr.then(() => {
        // Voz tocando — ok
      }).catch(() => {
        if (attempt < 2) {
          setTimeout(() => tryPlayVoice(attempt + 1), 80);
        } else {
          // Só depois de 2 falhas vai para a phonk
          startPhonk();
        }
      });
    }
  };
  tryPlayVoice(1);
}

let lastAuraKind = "";

function stopAuraEffect() {
  auraEffectActive = false;
  try {
    auraVoice.pause();
    auraVoice.currentTime = 0;
    auraPhonk.pause();
    auraPhonk.currentTime = 0;
  } catch (e) {}
  if (musicStarted && !document.hidden) {
    try { bgm.play().catch(() => {}); } catch (e) {}
  }
}

nameInput.addEventListener("input", () => {
  const clean = sanitizeName(nameInput.value);
  if (clean !== nameInput.value) nameInput.value = clean;
  loginArmed = false;
  const numericKind = forbiddenNameCombinationKind(nameInput.value);
  const numericReason = numericKind ? "Tá achando que vai farmar aura betinha?" : "";
  const blockedReason = numericReason || (offensiveNameDetected(nameInput.value) ? OFFENSIVE_NAME_MESSAGE : "");
  setLoginMsg(blockedReason || "", false);        // valida durante a digitação e novamente ao confirmar
  // Toca a sequência quando o nome passa a conter uma combinação proibida nova.
  // O tipo (67/42/61) é usado como chave para não reiniciar a voz a cada tecla.
  if (numericKind && numericKind !== lastAuraKind) playAuraEffect();
  else if (!numericKind && lastAuraKind && auraEffectActive) stopAuraEffect();
  lastAuraKind = numericKind;
});
// Esquenta o áudio UMA vez quando a pessoa toca no campo de nome
// (gesto válido no Android). Não roda de novo a cada tecla para não pausar a voz.
let auraAudioWarmed = false;
function warmAuraAudio() {
  if (auraAudioWarmed || auraEffectActive) return;
  auraAudioWarmed = true;
  try {
    [auraVoice, auraPhonk].forEach(a => {
      if (!a) return;
      const p = a.play();
      if (p && typeof p.then === "function") {
        p.then(() => { try { a.pause(); a.currentTime = 0; } catch (e) {} }).catch(() => {});
      }
    });
  } catch (e) {}
}
nameInput.addEventListener("pointerdown", warmAuraAudio, { passive: true });
nameInput.addEventListener("touchstart", warmAuraAudio, { passive: true });
nameInput.addEventListener("focus", warmAuraAudio);
nameInput.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); loginClick(); }
});

async function loginClick() {
  if (loginBusy || screen !== "login") return;
  const name = nameInput.value.trim().replace(/\s+/g, " ");
  if (!validName(name)) { loginArmed = false; setLoginMsg("Use de 3 a 20 caracteres (letras, números, espaço, _ ou -).", false); return; }
  const blockedReason = blockedNameReason(name);
  if (blockedReason) { loginArmed = false; setLoginMsg(blockedReason, false); if (forbiddenNameCombination(name)) playAuraEffect(); return; }
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
    loginArmed = false;
    const code = e && e.code ? String(e.code) : "";
    setLoginMsg(code.includes("operation-not-allowed") || code.includes("admin-restricted") ? "Ative o login Anônimo no Firebase (Authentication)."
              : code.includes("permission-denied") ? "O Firebase recusou: confira as regras do Firestore."
              : "Sem conexão com o servidor. Tente novamente.", false);
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
  const cy = H() / 2, bh = H() < 450 ? 44 : 54, gap = 8, total = 4 * bh + 3 * gap, top = cy - total / 2 + 18, x = W() / 2 - 120;
  return { top, buttons: [
    { id: "play", label: "JOGAR", x, y: top, w: 240, h: bh },
    { id: "hall", label: "HALL DA FAMA", font: 21, color: "#ffd700", x, y: top + bh + gap, w: 240, h: bh },
    { id: "settings", label: "CONFIGURAÇÕES", font: 20, color: "#00e5ff", x, y: top + 2 * (bh + gap), w: 240, h: bh },
    { id: "rewards", label: "RECOMPENSAS", font: 20, color: "#00ACFF", x, y: top + 3 * (bh + gap), w: 240, h: bh }
  ] };
}

// ----- HALL DA FAMA -----
function openHall() {
  screen = "hall"; hallTab = 0; hallState = "loading";
  DB.getLeaderboards().then(d => { hall = d; hallState = "ok"; }).catch(err => {
    hallState = "error";
    console.error("Erro ao carregar o Hall da Fama:", err);
  });
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
                                   : (hall.updatedAt ? "Ranking consolidado · atualizado em " + fmtDate(hall.updatedAt)
                                                     : "Primeiro ranking em preparação · pontuações salvas no Firebase"), W() / 2, L.footY);
  if (me) ctx.fillText("Seus recordes: Fácil " + (me.easyBest || 0) + " · Difícil " + (me.hardBest || 0) +
                       " · Boss " + (me.bossBestMs ? fmtRun(me.bossBestMs) : "--"), W() / 2, L.footY + 16);
  ctx.textAlign = "left";
}

// TELAS / BOTÕES
function getButtons() {
  const cx = W() / 2, cy = H() / 2;
  if (screen === "login") return loginLayout().buttons;
  if (screen === "hall") return hallLayout().buttons;
  if (screen === "settings") return settingsLayout().buttons;
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
  if (screen === "playing" && paused && confirmMenu) return confirmLayout().buttons;
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
  else if (id === "settings") screen = "settings";
  else if (id === "ctlArrows") setControl("arrows");
  else if (id === "ctlAnalog") setControl("analog");
  else if (id === "volDown") setMusic(settings.music - 5);
  else if (id === "volUp") setMusic(settings.music + 5);
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
  else if (id === "menu") {
    if (screen === "playing" && paused && !gameOver && (mode === "boss" || score > 0)) { confirmMenu = true; return; }   // pede confirmação
    screen = "menu"; paused = false;
  }
  else if (id === "menuYes") { confirmMenu = false; screen = "menu"; paused = false; }
  else if (id === "menuNo") confirmMenu = false;
}

function pauseGame() {
  paused = true; confirmMenu = false; keys.clear(); running = false; stick = null;
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

// ===== ANALÓGICO (fixo, embaixo no centro da tela) =====
let isPhone = false;          // atualizado em updateTouchControls()
let stickRunning = false;     // true enquanto o analógico está puxado além da metade (corrida)
const STICK_RUN_AT = 0.5;     // até 50% do limite = anda | acima de 50% = corre
const analogOn = () => settings.control === "analog" && isPhone;
const analogBase = () => ({ x: Math.max(76, W() * 0.20), y: H() - STICK_MAX - 44 });
const sprintBase = () => ({ x: W() - Math.max(76, W() * 0.18), y: H() - 88 });
const SPRINT_RADIUS = 42;

// Direção do analógico (vetor unitário) e se está na faixa de corrida.
// A velocidade NÃO muda com a puxada: só existem "andar" e "correr", iguais às das setinhas.
function stickInfo() {
  if (!stick) return null;
  const b = analogBase(), vx = stick.x - b.x, vy = stick.y - b.y, len = Math.hypot(vx, vy);
  if (len < 6) return null;                                   // zona morta
  return { ux: vx / len, uy: vy / len };
}

function drawAnalog() {
  if (!analogOn() || screen !== "playing" || gameOver || paused) return;
  const b = analogBase();
  let kx = b.x, ky = b.y;
  if (stick) {
    const vx = stick.x - b.x, vy = stick.y - b.y, len = Math.hypot(vx, vy) || 1, k = Math.min(len, STICK_MAX) / len;
    kx = b.x + vx * k; ky = b.y + vy * k;
  }
  ctx.save();
  ctx.globalAlpha = 0.3; // todos os controles do analógico ficam com 30% de opacidade
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(b.x, b.y, STICK_MAX, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath(); ctx.arc(b.x, b.y, 22, 0, Math.PI * 2); ctx.fill();                              // centro (repouso)
  ctx.fillStyle = "rgba(255,255,0,0.6)";
  ctx.beginPath(); ctx.arc(kx, ky, 22, 0, Math.PI * 2); ctx.fill();                                // bolinha
  // Botão de corrida: fica visualmente indisponível durante LENTIDÃO no clássico difícil.
  const rb = sprintBase();
  const sprintDisabled = mode === "hard" && debuff === "slow";
  ctx.save();
  ctx.globalAlpha = sprintDisabled ? 0.12 : 0.3;
  ctx.shadowColor = sprintHeld && !sprintDisabled ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)";
  ctx.shadowBlur = sprintHeld && !sprintDisabled ? 14 : 6;
  ctx.fillStyle = sprintDisabled ? "rgba(120,120,120,0.7)" : (sprintHeld ? "rgba(0,190,255,0.98)" : "rgba(0,160,255,0.86)");
  ctx.beginPath(); ctx.arc(rb.x, rb.y, SPRINT_RADIUS, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  if (runnerIcon.complete && runnerIcon.naturalWidth) {
    const iconSize = 52;
    ctx.globalAlpha = sprintDisabled ? 0.15 : 1;
    ctx.drawImage(runnerIcon, rb.x - iconSize / 2, rb.y - iconSize / 2, iconSize, iconSize);
  }
  ctx.restore(); // restaura a opacidade dos demais controles
  ctx.restore();
}

// ===== CONFIGURAÇÕES =====
const SETTINGS_KEY = "cybertech_settings";
const settings = { control: "arrows", music: 50 };   // control: "arrows" (setinhas) | "analog" (analógico); music: 0 a 100 (de 5 em 5)

function applyMusicVolume() { bgm.volume = settings.music / 100; }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (s) {
      if (s.control === "arrows" || s.control === "analog") settings.control = s.control;
      if (Number.isFinite(s.music)) settings.music = Math.max(0, Math.min(100, Math.round(s.music / 5) * 5));
    } else {   // aproveita o que já estava salvo pela versão anterior (ctg_control_mode / ctg_music_volume)
      const c = localStorage.getItem("ctg_control_mode"), m = localStorage.getItem("ctg_music_volume");
      if (c === "arrows" || c === "analog") settings.control = c;
      if (m !== null && Number.isFinite(Number(m))) settings.music = Math.max(0, Math.min(100, Math.round(Number(m) / 5) * 5));
    }
  } catch (e) {}
  applyMusicVolume();
}
function setMusic(v) { settings.music = Math.max(0, Math.min(100, Math.round(v / 5) * 5)); applyMusicVolume(); saveSettings(); }
function setControl(c) { settings.control = c; stick = null; stickRunning = false; sprintHeld = false; sprintPointer = null; saveSettings(); }

function settingsLayout() {
  const compact = H() < 480;
  // Descrição alinhada à esquerda e usando a largura útil inteira da tela.
  const margin = Math.max(12, Math.min(22, W() * 0.035));
  const pw = Math.max(100, W() - margin * 2), x0 = margin;
  const titleSize = compact ? 26 : 34, titleY = compact ? 28 : 44;
  const secY1 = compact ? 58 : 96;
  const btnY = secY1 + (compact ? 8 : 12), btnH = compact ? 36 : 48, bw = (pw - 12) / 2;
  const descFont = H() < 480 ? 12 : (W() < 390 ? 13 : 14);
  ctx.font = descFont + "px Arial";
  const desc = wrapText(settings.control === "arrows"
    ? "Use as setinhas para se mover. Para correr, pressione a mesma seta 2 vezes rapidamente."
    : "Mova o analógico à esquerda. Para correr, mantenha pressionado o botão com o bonequinho correndo à direita enquanto move o analógico. Correr consome stamina.", pw - 8);
  const descLineH = compact ? 15 : (W() < 390 ? 17 : 19);
  const descY = btnY + btnH + (compact ? 22 : 28);
  // Volume e botão voltar são posicionados dinamicamente abaixo de TODA a descrição.
  const secY2 = descY + desc.length * descLineH + (compact ? 32 : 42);
  const rowY = secY2 + (compact ? 12 : 16), rowH = compact ? 36 : 48, sq = rowH;
  const backY = rowY + rowH + (compact ? 40 : 54), backH = compact ? 36 : 46;
  return {
    titleSize, titleY, secY1, secY2, descY, desc, descLineH, descX: x0 + 4, pw, x0, rowY, rowH,
    bar: { x: x0 + sq + 10, y: rowY, w: pw - 2 * sq - 20, h: rowH },
    buttons: [
      { id: "ctlArrows", label: "SETINHAS", font: compact ? 15 : 18, outline: settings.control !== "arrows", x: x0, y: btnY, w: bw, h: btnH },
      { id: "ctlAnalog", label: "ANALÓGICO", font: compact ? 15 : 18, outline: settings.control !== "analog", x: x0 + bw + 12, y: btnY, w: bw, h: btnH },
      { id: "volDown", label: "−", font: 30, color: settings.music <= 0 ? "#555" : "yellow", x: x0, y: rowY, w: sq, h: rowH },
      { id: "volUp", label: "+", font: 30, color: settings.music >= 100 ? "#555" : "yellow", x: x0 + pw - sq, y: rowY, w: sq, h: rowH },
      { id: "back", label: "VOLTAR", font: 18, outline: true, x: W() / 2 - Math.min(160, pw * 0.38), y: backY, w: Math.min(320, pw * 0.76), h: backH }
    ]
  };
}
function drawSettings() {
  const L = settingsLayout();
  drawTitle("CONFIGURAÇÕES", L.titleSize, L.titleY, "yellow");
  ctx.textAlign = "center"; ctx.fillStyle = "#00e5ff"; ctx.font = "bold 15px Arial";
  ctx.fillText("MOVIMENTO", W() / 2, L.secY1);
  ctx.fillText("VOLUME DA MÚSICA", W() / 2, L.secY2);
  L.buttons.forEach(drawButton);
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.font = (H() < 480 ? "12px Arial" : (W() < 390 ? "13px Arial" : "14px Arial"));
  ctx.textAlign = "left";
  L.desc.forEach((ln, i) => ctx.fillText(ln, L.descX, L.descY + i * L.descLineH));
  ctx.textAlign = "center";
  const b = L.bar;                                   // barra de volume (0 a 100, de 5 em 5)
  ctx.fillStyle = "rgba(255,255,255,0.1)"; ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = "rgba(0,229,255,0.55)"; ctx.fillRect(b.x, b.y, b.w * settings.music / 100, b.h);
  ctx.strokeStyle = "yellow"; ctx.lineWidth = 3; ctx.strokeRect(b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3);
  ctx.fillStyle = "white"; ctx.font = "bold 22px Arial";
  ctx.fillText(settings.music + "%", b.x + b.w / 2, b.y + b.h / 2 + 8);
  ctx.textAlign = "left";
}

// ===== CONFIRMAÇÃO: voltar ao menu pela pausa (modo clássico) =====
function confirmLayout() {
  const w = Math.min(W() - 30, 460), bw = Math.min(300, W() - 40);
  ctx.font = "16px Arial";
  const lines = wrapText(mode === "boss"
    ? "Se voltar ao menu agora, você não receberá nada desta partida."
    : "Se voltar ao menu agora, a partida será encerrada e esses pontos não serão salvos.", w - 20);
  const top = Math.max(10, H() / 2 - 150), msgY = top + 112;
  const btnY = msgY + lines.length * 22 + 10;
  return {
    lines, titleY: top + 36, ptsY: top + 80, msgY,
    buttons: [
      { id: "menuYes", label: "SIM, VOLTAR AO MENU", font: 19, color: "#ff5a5a", x: W() / 2 - bw / 2, y: btnY, w: bw, h: 52 },
      { id: "menuNo", label: "CONTINUAR JOGANDO", font: 19, x: W() / 2 - bw / 2, y: btnY + 62, w: bw, h: 52 }
    ]
  };
}

function drawConfirmMenu() {
  const L = confirmLayout();
  drawTitle("VOLTAR AO MENU?", 32, L.titleY, "yellow");
  ctx.textAlign = "center"; ctx.font = "bold 26px Arial";
  if (mode === "boss") { ctx.fillStyle = "#ff5a5a"; ctx.fillText("ATENÇÃO!", W() / 2, L.ptsY); }
  else { ctx.fillStyle = "#00e5ff"; ctx.fillText("Você fez " + (score === 1 ? "1 ponto" : score + " pontos") + " até agora", W() / 2, L.ptsY); }
  ctx.fillStyle = "white"; ctx.font = "16px Arial";
  L.lines.forEach((ln, i) => ctx.fillText(ln, W() / 2, L.msgY + i * 22));
  ctx.textAlign = "left";
  L.buttons.forEach(drawButton);
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
  isPhone = isCellphone;
  const show = screen === "playing" && !gameOver && !paused && isCellphone && settings.control === "arrows";
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
    if (paused && confirmMenu) {                       // na pergunta: Esc/P voltam à pausa; Enter não confirma por engano
      if (k === "p" || k === "escape") confirmMenu = false;
      e.preventDefault(); return;
    }
    if (!paused && (k === "p" || k === "escape")) { pauseGame(); e.preventDefault(); return; }
    if (paused && (k === "p" || k === "escape" || confirm)) { paused = false; e.preventDefault(); return; }
  }

  if ((screen === "rewards" || screen === "modes" || screen === "difficulty" || screen === "hall" || screen === "settings") && k === "escape") { screen = "menu"; return; }
  if (screen === "settings" && (k === "arrowleft" || k === "arrowright")) { setMusic(settings.music + (k === "arrowright" ? 5 : -5)); e.preventDefault(); return; }
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
window.addEventListener("blur", () => { keys.clear(); running = false; stick = null; sprintHeld = false; sprintPointer = null; });

// ENTRADA: TOQUE / CLIQUE
canvas.addEventListener("pointerdown", e => {
  initAudio();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;

  const b = getButtons().find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  if (b) { press(b.id); return; }

  // Analógico e botão de corrida têm zonas fixas separadas; tocar no meio não cria controles.
  if (analogOn() && screen === "playing" && !gameOver && !paused && e.pointerType !== "mouse") {
    const rb = sprintBase();
    if (Math.hypot(x - rb.x, y - rb.y) <= SPRINT_RADIUS + 12) {
      e.preventDefault();
      if (mode === "hard" && debuff === "slow") { sprintHeld = false; sprintPointer = null; return; }
      canvas.setPointerCapture(e.pointerId);
      sprintPointer = e.pointerId; sprintHeld = true;
      return;
    }
    const ab = analogBase();
    if (Math.hypot(x - ab.x, y - ab.y) <= STICK_MAX * 1.5) {
      canvas.setPointerCapture(e.pointerId);
      stick = { id: e.pointerId, x, y };
    }
  }
});
canvas.addEventListener("pointermove", e => {
  if (!stick || e.pointerId !== stick.id) return;
  const r = canvas.getBoundingClientRect();
  stick.x = e.clientX - r.left; stick.y = e.clientY - r.top;
});
const endStick = e => {
  if (stick && e.pointerId === stick.id) stick = null;
  if (sprintPointer === e.pointerId) { sprintPointer = null; sprintHeld = false; }
};
canvas.addEventListener("pointerup", endStick);
canvas.addEventListener("pointercancel", endStick);
canvas.addEventListener("lostpointercapture", endStick);

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

// Área do botão de pausa (topo, no centro): nenhum bloco vermelho/power-up nasce aí
function pauseZone() { return { x: W() / 2 - 22, y: 8, size: 44, gap: 14, fixed: true }; }

// Áreas reservadas aos controles de locomoção escolhidos nas configurações.
// Os retângulos incluem uma margem para que os itens não apareçam parcialmente sob os botões.
function locomotionControlZones() {
  if (!isPhone) return [];
  if (settings.control === "arrows") {
    const small = W() <= 420;
    const btn = small ? 58 : 66;
    const gap = 10, padX = small ? 12 : 20;
    const padY = 18; // inclui o espaço inferior dos controles
    const leftW = btn, leftH = btn * 2 + gap;
    const rightW = btn * 2 + gap, rightH = btn;
    return [
      { x: Math.max(0, padX - 12), y: H() - padY - leftH - 12, w: leftW + 24, h: leftH + 24, gap: 8, fixed: true },
      { x: Math.max(0, W() - padX - rightW - 12), y: H() - padY - rightH - 12, w: rightW + 24, h: rightH + 24, gap: 8, fixed: true }
    ];
  }
  if (settings.control === "analog") {
    const ab = analogBase(), rb = sprintBase();
    return [
      { x: Math.max(0, ab.x - STICK_MAX - 18), y: ab.y - STICK_MAX - 18,
        w: Math.min(W(), STICK_MAX * 2 + 36), h: STICK_MAX * 2 + 36, gap: 8, fixed: true },
      { x: rb.x - SPRINT_RADIUS - 14, y: rb.y - SPRINT_RADIUS - 14,
        w: SPRINT_RADIUS * 2 + 28, h: SPRINT_RADIUS * 2 + 28, gap: 8, fixed: true }
    ];
  }
  return [];
}
function keepOffPause(o) {
  const z = pauseZone();
  if (overlap(o, z, z.gap)) o.y = z.y + z.size + z.gap + 2;   // garantia extra: empurra para baixo da faixa
}

function freeAvoid(skip) {
  return [
    pauseZone(),
    ...locomotionControlZones(),
    { x: player.x, y: player.y, size: player.size, gap: 20, fixed: true },
    ...obstacles.map(proxyZone), ...powerupZones(), proxyZone(item),
    ...(fake && fake !== skip ? [proxyZone(fake)] : [])
  ];
}
function placeItem(o) {
  const p = safePosition(o.size, freeAvoid(o), 0);
  o.x = p.x; o.y = p.y; keepOffPause(o);
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
  const st = stickInfo();                                   // analógico (null se solto/zona morta)
  if (exhausted) running = false;
  const isRunning = (running && keys.size > 0) || (!!st && sprintHeld && !exhausted);
  if (isRunning) { stamina = Math.max(0, stamina - STAMINA_DRAIN * dt); staminaDelay = 0.6; }
  else { staminaDelay -= dt; if (staminaDelay <= 0) stamina = Math.min(STAMINA_MAX, stamina + STAMINA_REGEN * dt); }
  if (stamina <= 0) { exhausted = true; running = false; }
  else if (exhausted && stamina >= STAMINA_RESUME) exhausted = false;
  stickRunning = !!st && sprintHeld && !exhausted;         // corre só segurando o botão e com stamina

  let dx = 0, dy = 0;
  const dirs = {
    a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0],
    w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1]
  };
  keys.forEach(k => {
    const f = running ? 1 : SLOW_FACTOR;
    dx += dirs[k][0] * f; dy += dirs[k][1] * f;
  });

  if (st) {                                                  // 0–50% da puxada = anda | 51–100% = corre (velocidade fixa)
    const f = stickRunning ? 1 : SLOW_FACTOR;
    dx += st.ux * f; dy += st.uy * f;
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
  const dropSize = 20, gap = 10;
  let dx = cx - Math.cos(boss.ang) * (boss.size / 2 + 30) - dropSize / 2;
  let dy = cy - Math.sin(boss.ang) * (boss.size / 2 + 30) - dropSize / 2;

  if (boss.idx === 0) {
    // Tenta todas as quatro posições a exatamente 10 px do BULL (incluindo os chifres).
    const left = boss.x - 16, right = boss.x + boss.size + 16;
    const top = boss.y - 14, bottom = boss.y + 12;
    const candidates = [
      { x: left - gap - dropSize, y: cy - dropSize / 2, side: 'left' },
      { x: right + gap, y: cy - dropSize / 2, side: 'right' },
      { x: cx - dropSize / 2, y: top - gap - dropSize, side: 'top' },
      { x: cx - dropSize / 2, y: boss.y + boss.size + gap, side: 'bottom' },
      // Opções adicionais nas laterais, para não falhar só porque o centro está bloqueado.
      { x: left - gap - dropSize, y: boss.y - dropSize, side: 'left-top' },
      { x: left - gap - dropSize, y: boss.y + boss.size, side: 'left-bottom' },
      { x: right + gap, y: boss.y - dropSize, side: 'right-top' },
      { x: right + gap, y: boss.y + boss.size, side: 'right-bottom' }
    ];
    const valid = candidates.filter(c =>
      c.x >= 0 && c.y >= BOSS_HUD_SAFE_Y && c.x + dropSize <= W() && c.y + dropSize <= H() &&
      // Distância de 10 px dos limites visíveis do BULL e sem sobreposição do corpo.
      !(c.x < right + gap && c.x + dropSize > left - gap && c.y < bottom + gap && c.y + dropSize > top - gap) &&
      !(c.x < boss.x + boss.size && c.x + dropSize > boss.x && c.y < boss.y + boss.size && c.y + dropSize > boss.y)
    );
    if (valid.length) {
      const desiredX = dx + dropSize / 2, desiredY = dy + dropSize / 2;
      valid.sort((a,b) => Math.hypot(a.x + dropSize/2 - desiredX, a.y + dropSize/2 - desiredY) -
                          Math.hypot(b.x + dropSize/2 - desiredX, b.y + dropSize/2 - desiredY));
      dx = valid[0].x; dy = valid[0].y;
    } else {
      // Último recurso para arenas estreitas: varre a área ao redor do boss até achar
      // um quadrado dentro da tela, livre e separado do corpo por pelo menos 10 px.
      let found = null, best = Infinity;
      // Varredura completa em passos de 2 px. A caixa de exclusão inclui os chifres
      // do BULL e mantém 10 px livres; também nunca coloca o drop atrás da HUD.
      const exclusion = { left: boss.x - 16, right: boss.x + boss.size + 16,
                          top: boss.y - 14, bottom: boss.y + boss.size + 2 };
      for (let y = Math.max(BOSS_HUD_SAFE_Y, 0); y <= H() - dropSize; y += 2) {
        for (let x = 0; x <= W() - dropSize; x += 2) {
          const separated = x + dropSize + gap <= exclusion.left || x >= exclusion.right + gap ||
                            y + dropSize + gap <= exclusion.top || y >= exclusion.bottom + gap;
          if (!separated) continue;
          const d = Math.hypot(x + dropSize/2 - (dx + dropSize/2), y + dropSize/2 - (dy + dropSize/2));
          if (d < best) { best = d; found = {x,y}; }
        }
      }
      if (found) { dx = found.x; dy = found.y; }
    }
  }
  dx = Math.max(0, Math.min(W() - dropSize, dx));
  dy = Math.max(0, Math.min(H() - dropSize, dy));
  drop = { x: dx, y: dy, size: dropSize };
  showFirstOpportunity("AGORA É SUA CHANCE!", boss.idx !== 1);
  if (boss.fury) { wave = { x: cx, y: cy, r: 10, hit: false }; shake = 0.5; beep(90, 0.3); }
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
  // Mesmas zonas reservadas no Clássico: as caixas do PEEP respeitam os controles escolhidos.
  avoid.push(...locomotionControlZones().map(z => ({ ...z, controlZone: true })));
  const rand = () => ({ x: Math.random() * Math.max(1, W() - size), y: top + Math.random() * Math.max(1, H() - top - size) });
  const blocked = c => avoid.some(o => {
    if (o.controlZone) {
      const g = o.gap || 0;
      return c.x < o.x + o.w + g && c.x + size > o.x - g &&
             c.y < o.y + o.h + g && c.y + size > o.y - g;
    }
    return overlap({ x: c.x, y: c.y, size }, o, o.gap);
  });
  let p = null;
  for (let i = 0; i < 300 && !p; i++) {
    const c = rand();
    if (!blocked(c)) p = c;
  }
  // Se toda a área restante estiver bloqueada, não gera a caixa em cima dos controles.
  if (!p) return;
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
        floats.push({ x: bcx - 10, y: bcy - b.size, text: b.dir > 0 ? "↻" : "↺", color: f ? NEON.orange : "#ff2bd6", life: 0.8 });
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
  horses.push({ dir, side: verticalFuryFromWall ? 1 : side, lane,
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
    // Parede invisível sob a HUD: tiros do PEEP não atravessam a faixa das estatísticas.
    if (mode === "boss" && bossIdx === 1 && bo.y < BOSS_HUD_SAFE_Y) {
      bo.y = BOSS_HUD_SAFE_Y;
      if (bo.fury && bo.bounces < 2) { bo.vy = Math.abs(bo.vy); bo.bounces++; }
      else return false;
    }
    if (crate && bo.x > crate.x && bo.x < crate.x + crate.size && bo.y > crate.y && bo.y < crate.y + crate.size) {
      drop = { x: crate.x + 8, y: crate.y + 8, size: 20, life: 8, collectDelay: (boss && boss.idx === 1 && boss.fury) ? 1 : 0 };   // no modo fúria do PEEP, só pode pegar 1 s após a caixa quebrar
      floats.push({ x: crate.x, y: crate.y - 10, text: "CAIXA QUEBROU!", color: "#ffb703", life: 0.8 });
      crate = null; beep(300, 0.12);
      return false;
    }
    if (invuln <= 0 && Math.hypot(bo.x - pcx, bo.y - pcy) < player.size / 2 + 4) { damagePlayer(bo.fury ? 20 : 10); return false; }
    if (bo.x < 0 || bo.x > W() || bo.y < 0 || bo.y > H()) {
      if (bo.fury && bo.bounces < 2) {                // na fúria ricocheteia até 2 vezes
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
    const collisionScale = h.fury ? 1.4 : 1.25; // fúria: +40%; o desenho usa exatamente a mesma dimensão
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
      const warningSize = 76.5 * (h.fury ? 1.4 : 1.25);
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
    const visualCollisionSize = 76.5 * (h.fury ? 1.4 : 1.25);
    // Ajuste independente dos eixos: o cavalo ocupa exatamente a caixa de
    // colisão (180 px no sentido do movimento e visualCollisionSize no eixo transversal).
    // Os desenhos-base medem aprox. 130x44 px na horizontal; na vertical, os eixos invertem.
    const scaleAlong = 180 / 130;
    const scaleAcross = visualCollisionSize / 44;
    ctx.save();
    // FIX KNIGHT: centralizar a transformação no eixo correto para cada direção.
    // Horizontal: centro (pos, lane). Vertical: centro (lane, pos).
    // Assim a escala não desloca o cavalo vertical nem cria aparência diagonal.
    const horseCenterX = h.dir === "h" ? h.pos : h.lane;
    const horseCenterY = h.dir === "h" ? h.lane : h.pos;
    ctx.translate(horseCenterX, horseCenterY);
    ctx.scale(h.dir === "h" ? scaleAlong : scaleAcross,
              h.dir === "h" ? scaleAcross : scaleAlong);
    ctx.translate(-horseCenterX, -horseCenterY);
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
    const m = Math.hypot(bo.vx, bo.vy) || 1, col = bo.fury ? NEON.orange : NEON.cyan;
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
      if (charge) { ctx.strokeStyle = b.fury ? "rgba(255,106,0,0.75)" : "rgba(255,43,214,0.5)"; ctx.lineWidth = 2; ctx.setLineDash([10, 10]); ctx.stroke(); ctx.setLineDash([]); }
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
    neon(b.fury ? NEON.orange : NEON.cyan, 10); ctx.strokeStyle = b.fury ? NEON.orange : NEON.cyan; ctx.lineWidth = 2; ctx.strokeRect(r - 4, -6, 36, 12);
    ctx.fillStyle = b.fury ? NEON.orange : "#fff"; ctx.fillRect(r + 30, -3, 6, 6); noNeon();
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
    const gw = b.fury ? 80 : 100; // Deve corresponder exatamente a bands[].gapW (normal: 100, fúria: 80).
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
    if (boss && boss.idx === 2 && bossStage === "cutscene") {
      player.y = Math.max(player.y, Math.min(H() - player.size - 60, BOSS_HUD_SAFE_Y + 80));
    }
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
        // Ao sair do PEEP, reposiciona o jogador na arena acessível antes da entrada do KNIGHT.
        // Evita que ele fique atrás/acima da parede invocada pelo próximo chefe.
        if (bossIdx === 2) {
          player.y = Math.min(H() - player.size - 60, Math.max(H() * 0.55, BOSS_HUD_SAFE_Y + 80));
          player.x = Math.max(8, Math.min(W() - player.size - 8, player.x));
          kb.x = 0; kb.y = 0;
        }
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
  // Contato corporal com BULL e PEEP causa 15 de dano; a invulnerabilidade evita dano contínuo a cada frame.
  if (boss && bossIdx < 2 && invuln <= 0 && overlap(player, boss)) {
    damagePlayer(15);
    if (gameOver) return;
  }
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
  if (debuff === "slow") { running = false; sprintHeld = false; sprintPointer = null; stickRunning = false; } // lentidão: corrida bloqueada

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
  if (screen === "settings") { drawSettings(); return; }
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
  if ((running && keys.size > 0) || stickRunning) {
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

  drawAnalog();

  // HUD
  ctx.shadowColor = "black"; ctx.shadowBlur = 5;
  ctx.fillStyle = "white";
  // HUD responsivo: diminui a pontuação em telas estreitas e quando o número cresce.
  const scoreLabel = "Pontuação: " + score;
  const scoreMaxWidth = Math.max(70, W() * 0.39);
  let scoreFontSize = Math.min(22, Math.max(10, W() * 0.032));
  ctx.font = "bold " + scoreFontSize + "px 'Arial Black', Arial, sans-serif";
  while (ctx.measureText(scoreLabel).width > scoreMaxWidth && scoreFontSize > 10) {
    scoreFontSize -= 1;
    ctx.font = "bold " + scoreFontSize + "px 'Arial Black', Arial, sans-serif";
  }
  ctx.fillText(scoreLabel, 15, 30);
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
    // só a informação necessária para correr, conforme o controle escolhido
    const runTip = analogOn() ? "Segure o botão de correr e mova o analógico"
                              : "Para correr, pressione a mesma " + (isPhone ? "seta" : "tecla") + " 2 vezes rápido";
    wrapText(runTip, W() - 28).forEach((line, i) => ctx.fillText(line, W() / 2, (isPhone ? 100 : H() - 20) + i * 17));
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
    if (confirmMenu) drawConfirmMenu();
    else {
      drawTitle("PAUSADO", 45, cy - 60, "yellow");
      getButtons().forEach(drawButton);
      ctx.fillStyle = "white"; ctx.font = "14px Arial"; ctx.textAlign = "center";
      ctx.fillText("P / Esc / Enter para continuar", W() / 2, cy + 130);
      ctx.textAlign = "left";
    }
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
    // NÃO mexer em auraVoice/auraPhonk aqui — isso pausava a voz no meio da fala no celular.
  }).catch(() => {});       // se o navegador recusar, tenta de novo na próxima interação
}
MUSIC_EVENTS.forEach(ev => window.addEventListener(ev, startMusic, true));

// Pausa quando a aba vai para segundo plano e volta quando a pessoa retorna
document.addEventListener("visibilitychange", () => {
  if (!musicStarted) return;
  if (document.hidden) bgm.pause(); else bgm.play().catch(() => {});
});

loadSettings();   // controle escolhido e volume da música
loadMe();
if (!me) screen = "login";   // primeira vez: pede o nome de usuário
syncMe();
loadBest();
loadCooldown();
resizeCanvas();
requestAnimationFrame(loop);