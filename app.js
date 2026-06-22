import { firebaseConfig } from "./firebase-config.js";

const FINISH_PERSON_COUNT = 5;
// 賽道上跑者可見的左右端點（百分比）：左=取水起點，右=灌溉終點。
// 終點小人聚成一小叢，路徑因此可拉長、更好看。
const RELAY_PATH = { start: 13, end: 85 };
// 倒水動作落在一趟行程中段（f≈0.5）的視窗，讓潑水與小人成長同步發生。
const POUR_WINDOW = { from: 0.46, to: 0.62 };
const FINISH_DELAY_MS = 1700; // 達標後停在終點潑水的時間，再進入結算
const TEAM_META = {
  coral: { name: "晨露隊", color: "#e76f51", dark: "#b74733" },
  river: { name: "河浪隊", color: "#277da1", dark: "#15546f" },
  leaf: { name: "嫩芽隊", color: "#43aa8b", dark: "#20745c" }
};
const STORAGE_PREFIX = "water-splash-race";
const query = new URLSearchParams(window.location.search);
const isHost = query.get("view") === "host";
const requestedRoomCode = normalizeRoomCode(query.get("room"));
const roomCode = requestedRoomCode || (isHost ? makeRoomCode() : "WATER2026");
if (isHost && !requestedRoomCode) {
  query.set("room", roomCode);
  window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}${window.location.hash}`);
}
const localKey = `${STORAGE_PREFIX}:${roomCode}`;
const playerKey = `${STORAGE_PREFIX}:${roomCode}:player`;

let game = createDefaultState();
let currentPlayer = readCurrentPlayer();
let backend = { type: "demo", channel: null };
let firebaseApi = null;
let renderedQrUrl = "";
let shareFeedback = "";
let shareFeedbackTimer = null;
let lastPointerTapAt = 0;

const elements = {
  connectionBadge: document.querySelector("#connection-badge"), roomLabel: document.querySelector("#room-label"),
  hostView: document.querySelector("#host-view"), playerView: document.querySelector("#player-view"),
  hostHeading: document.querySelector("#host-heading"), hostCopy: document.querySelector("#host-copy"),
  startButton: document.querySelector("#start-button"), autoAssignButton: document.querySelector("#auto-assign-button"), resetButton: document.querySelector("#reset-button"),
  playerJoinLink: document.querySelector("#player-join-link"), copyPlayerLinkButton: document.querySelector("#copy-player-link-button"), joinShareNote: document.querySelector("#join-share-note"), joinQrCode: document.querySelector("#join-qr-code"),
  bucketCapacity: document.querySelector("#bucket-capacity"), growthStages: document.querySelector("#growth-stages"), countdownSeconds: document.querySelector("#countdown-seconds"),
  hostScoreboard: document.querySelector("#host-scoreboard"), playerCount: document.querySelector("#player-count"), playerRoster: document.querySelector("#player-roster"),
  joinPanel: document.querySelector("#join-panel"), tapPanel: document.querySelector("#tap-panel"), joinForm: document.querySelector("#join-form"),
  playerName: document.querySelector("#player-name"), joinError: document.querySelector("#join-error"), yourTeamLabel: document.querySelector("#your-team-label"),
  tapHeading: document.querySelector("#tap-heading"), tapCounter: document.querySelector("#tap-counter"), teamProgressFill: document.querySelector("#team-progress-fill"),
  tapMessage: document.querySelector("#tap-message"), tapButton: document.querySelector("#tap-button"), changeTeamButton: document.querySelector("#change-team-button"),
  winnerOverlay: document.querySelector("#winner-overlay"), winnerTitle: document.querySelector("#winner-title"), winnerCopy: document.querySelector("#winner-copy"), winnerNextButton: document.querySelector("#winner-next-button")
};

function createDefaultState() {
  return {
    version: 6, round: 1, status: "lobby", countdownEndsAt: null, startedAt: null, finishedAt: null, finishAnimationEndsAt: null, winner: null,
    settings: { bucketCapacity: 24, growthStages: 4, countdownSeconds: 5 },
    teams: Object.fromEntries(Object.keys(TEAM_META).map((teamId) => [teamId, { waterUnits: 0 }])), players: {}
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function normalizeRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
}

function makeRoomCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => characters[value % characters.length]).join("");
}

function normalizeState(value) {
  if (!value || ![3, 4, 5, 6].includes(value.version)) return createDefaultState();
  const base = createDefaultState();
  const source = value;
  const players = Object.fromEntries(Object.entries(source.players || {}).filter(([, player]) => player).map(([id, player]) => [id, {
    name: String(player.name || "隊員").slice(0, 16), team: TEAM_META[player.team] ? player.team : null, taps: clampNumber(player.taps, 0, 0, 1000000), joinedAt: clampNumber(player.joinedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  }]));
  return {
    ...base, ...source, version: 6, round: clampNumber(source.round, 1, 1, 100000),
    status: ["lobby", "countdown", "running", "finishing", "finished"].includes(source.status) ? source.status : "lobby",
    finishAnimationEndsAt: clampNumber(source.finishAnimationEndsAt, 0, 0, Number.MAX_SAFE_INTEGER) || null,
    settings: {
      bucketCapacity: clampNumber(source.settings?.bucketCapacity, 24, 5, 100),
      growthStages: clampNumber(source.settings?.growthStages, 4, 1, 8),
      countdownSeconds: clampNumber(source.settings?.countdownSeconds, 5, 1, 20)
    },
    // 只保留 waterUnits 作為唯一同步來源；舊版的 deliveryEvents 等欄位升級時自動丟棄。
    teams: Object.fromEntries(Object.keys(TEAM_META).map((teamId) => [teamId, {
      waterUnits: clampNumber(source.teams?.[teamId]?.waterUnits, 0, 0, 100000000)
    }])),
    players, winner: TEAM_META[source.winner] ? source.winner : null
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function readCurrentPlayer() { try { const player = JSON.parse(sessionStorage.getItem(playerKey)); return player?.id ? player : null; } catch { return null; } }
function saveCurrentPlayer(player) { currentPlayer = player; sessionStorage.setItem(playerKey, JSON.stringify(player)); }
function gamePath() { return `${STORAGE_PREFIX}/rooms/${roomCode}`; }
function teamPlayers(teamId) { return Object.values(game.players).filter((player) => player.team === teamId); }

function playerJoinUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "play");
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function shareMessage() {
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
  if (localHost) return { text: "本機網址只供目前電腦測試；正式活動請使用部署 HTTPS 網址並完成 Firebase 設定。", warning: true };
  if (backend.type !== "firebase") return { text: "目前是示範模式：QR 可開啟頁面，但多支手機不會即時同步；請先設定 Firebase。", warning: true };
  return { text: "即時多人模式已啟用，掃描後即可加入此房間。", warning: false };
}

function renderJoinQrCode() {
  const joinUrl = playerJoinUrl();
  elements.playerJoinLink.textContent = joinUrl;
  const message = shareFeedback ? { text: shareFeedback, warning: false } : shareMessage();
  elements.joinShareNote.textContent = message.text;
  elements.joinShareNote.className = `share-note${message.warning ? " is-warning" : ""}`;
  if (renderedQrUrl === joinUrl) return;
  if (typeof window.QRCode !== "function") { elements.joinShareNote.textContent = "QR Code 載入中，請稍候。"; return; }
  renderedQrUrl = joinUrl;
  try {
    elements.joinQrCode.replaceChildren();
    new window.QRCode(elements.joinQrCode, { text: joinUrl, width: 160, height: 160, colorDark: "#102a43", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
  } catch (error) {
    renderedQrUrl = "";
    elements.joinShareNote.textContent = "QR Code 無法產生，請使用上方連線網址。";
    elements.joinShareNote.className = "share-note is-warning";
  }
}

async function copyPlayerJoinLink() {
  const joinUrl = playerJoinUrl();
  try {
    await navigator.clipboard.writeText(joinUrl);
  } catch {
    const temporaryInput = document.createElement("textarea");
    temporaryInput.value = joinUrl; temporaryInput.setAttribute("readonly", "");
    temporaryInput.style.position = "fixed"; temporaryInput.style.opacity = "0";
    document.body.append(temporaryInput); temporaryInput.select(); document.execCommand("copy"); temporaryInput.remove();
  }
  shareFeedback = "玩家連線網址已複製。";
  window.clearTimeout(shareFeedbackTimer);
  shareFeedbackTimer = window.setTimeout(() => { shareFeedback = ""; renderJoinQrCode(); }, 2200);
  renderJoinQrCode();
}

// 一切由 waterUnits 推導：一趟行程＝一桶水（bucketCapacity 次打水），
// 行程前半段提水往終點（out）、中段倒水（pour）、後半段空手返回（back）。
// 因此跑者位置只跟著打水次數前進，沒人打水就停住；倒水時讓終點小人成長一階。
function teamMetrics(teamId) {
  const units = game.teams[teamId].waterUnits;
  const { bucketCapacity, growthStages } = game.settings;
  const maxGrowth = FINISH_PERSON_COUNT * growthStages; // 需要的總澆水次數
  const trips = units / bucketCapacity;                 // 連續的行程數
  const f = trips - Math.floor(trips);                  // 當前行程內進度 0..1
  const outbound = f < 0.5;
  const legFrac = outbound ? f / 0.5 : (f - 0.5) / 0.5; // 該段（去／回）內 0..1
  const span = RELAY_PATH.end - RELAY_PATH.start;
  const posPct = outbound ? RELAY_PATH.start + legFrac * span : RELAY_PATH.end - legFrac * span;
  const pouring = f >= POUR_WINDOW.from && f <= POUR_WINDOW.to;
  // 倒水發生在每趟中段（f 越過 0.5）；已完成的澆水次數 = floor(trips + 0.5)
  const pours = Math.min(maxGrowth, Math.floor(trips + 0.5));
  const growthRatio = Math.min(1, pours / maxGrowth);   // 五位小人共同的成長比例
  return { units, maxGrowth, pours, growthRatio, posPct, outbound, pouring, progress: Math.round(growthRatio * 100) };
}

// 起點群眾：codex 卡通隊員（蝴蝶結＋頭髮＋笑臉＋衣服），超過顯示上限以 +N 標示。
function crowdMarkup(teamId) {
  const members = teamPlayers(teamId);
  const cap = 6;
  const visibleCount = Math.max(3, Math.min(cap, members.length || 3));
  const visible = Array.from({ length: visibleCount }, (_, index) => {
    const player = members[index];
    const name = player?.name || "隊員";
    return `<span class="crowd-member ${player ? "" : "is-support"}" style="--crowd-shift:${(index % 3) * 2}px" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}"><span class="crowd-bow"></span><span class="crowd-hair"></span><span class="crowd-face"><i class="eye-left"></i><i class="eye-right"></i><b></b></span><span class="crowd-shirt"></span></span>`;
  }).join("");
  const overflow = members.length > cap ? `<strong class="crowd-overflow">+${members.length - cap}</strong>` : "";
  return `${visible}${overflow}`;
}

// 沙地裝飾：石頭與仙人掌各自隨機數量，確保兩者都會出現，位置／大小皆隨機（避開取水／灌溉區）。
function decorationsMarkup() {
  const items = [];
  const stones = 2 + Math.floor(Math.random() * 3);   // 2–4 顆石頭
  const cacti = 1 + Math.floor(Math.random() * 2);    // 1–2 株仙人掌
  for (let n = 0; n < stones; n++) items.push("🪨");
  for (let n = 0; n < cacti; n++) items.push("🌵");
  // 洗牌，避免石頭與仙人掌各自成群
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return items.map((emoji) => {
    const left = 18 + Math.random() * 56;             // 18%–74%
    const bottom = 5 + Math.random() * 9;             // 5–14px
    const size = (emoji === "🌵" ? 13 : 11) + Math.random() * 6;
    const opacity = (0.78 + Math.random() * 0.22).toFixed(2);
    return `<span class="stone" aria-hidden="true" style="left:${left.toFixed(1)}%;bottom:${bottom.toFixed(0)}px;font-size:${size.toFixed(0)}px;opacity:${opacity}">${emoji}</span>`;
  }).join("");
}

// codex 提水跑者造型（雙手各提一桶）。
function relayRunnerMarkup() {
  return `<div class="relay-runner">
    <span class="runner-bow"></span><span class="runner-hair"></span>
    <span class="runner-head"><span class="runner-eye eye-left"></span><span class="runner-eye eye-right"></span><span class="runner-cheek cheek-left"></span><span class="runner-cheek cheek-right"></span><span class="runner-smile"></span></span>
    <span class="runner-body"><span class="runner-badge">♥</span></span><span class="runner-legs"></span>
    <span class="runner-arm runner-arm-left"></span><span class="runner-arm runner-arm-right"></span>
    <span class="runner-bucket runner-bucket-left"><i></i></span><span class="runner-bucket runner-bucket-right"><i></i></span>
    <span class="bucket-spray bucket-spray-left"><i></i><i></i><i></i></span><span class="bucket-spray bucket-spray-right"><i></i><i></i><i></i></span>
    <span class="irrigation-splash"></span>
  </div>`;
}

// codex 終點小人造型；位置由 laneSkeleton 隨機指定（水平錯位 + 垂直深度）。
// 站在前面（bottom 較小）的疊在上層，讓重疊看起來像一群人前後站。
function tinyPersonMarkup(left, bottom) {
  const z = Math.round(40 - Number(bottom));
  return `<span class="tiny-person" style="--person-scale:0.24;left:${left}%;bottom:${bottom}px;z-index:${z}"><span class="person-bow"></span><span class="person-hair"></span><span class="person-head"><span class="person-eye eye-left"></span><span class="person-eye eye-right"></span><span class="person-cheek cheek-left"></span><span class="person-cheek cheek-right"></span><span class="person-smile"></span></span><span class="person-body"><span class="person-heart">♥</span></span><span class="person-arms"></span><span class="person-legs"></span></span>`;
}

// 五位小人聚成一小叢（互相重疊以縮小佔位），各自隨機水平錯位與深度。
function tinyPeopleMarkup() {
  return Array.from({ length: FINISH_PERSON_COUNT }, (_, i) => {
    const base = i * 14;                                         // 0,14,28,42,56（緊湊、重疊）
    const left = Math.max(0, Math.min(62, base + (Math.random() * 8 - 4))).toFixed(1);
    const bottom = (1 + Math.random() * 20).toFixed(0);          // 1–21px 深度
    return tinyPersonMarkup(left, bottom);
  }).join("");
}

// 賽場採「建一次、之後只更新樣式」的策略：跑者與小人是常駐 DOM，
// 位置只透過 style 變動 + CSS 過渡平滑移動，不會因每 250ms 重繪而中斷搖晃與成長動畫。
let fieldSignature = "";
const laneRefs = {};

// 賽道骨架：沙地賽道上散落石頭，左取水起點群眾、中間提水跑者、右終點五位小人。
function laneSkeleton(teamId) {
  const meta = TEAM_META[teamId];
  const people = tinyPeopleMarkup();
  return `<section class="lane" data-team="${teamId}" style="--team:${meta.color};--team-dark:${meta.dark}" aria-label="${meta.name}由左側取水往右側灌溉">
    <div class="lane-head">
      <span class="lane-name">${meta.name}</span>
      <span class="lane-meta"></span>
      <span class="lane-pct">0%</span>
    </div>
    <div class="lane-track">
      <div class="lane-fill"></div>
      ${decorationsMarkup()}
      <div class="zone start-zone"><div class="crowd">${crowdMarkup(teamId)}</div><span class="zone-tag">💧 取水</span></div>
      <div class="runner" aria-hidden="true">${relayRunnerMarkup()}</div>
      <div class="zone finish-zone">
        <div class="watering-rain" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="tiny-people">${people}</div>
        <span class="zone-tag">🌱 灌溉</span>
      </div>
    </div>
  </section>`;
}

function buildFieldSkeleton() {
  elements.hostScoreboard.innerHTML = `<section class="field" aria-label="三隊同場接力賽場">
    <header class="field-head">
      <div><h3>澆水成長賽場</h3></div>
      <span class="field-hint">手指打水時提水人才前進；提到右側倒水讓乾枯小人長大</span>
    </header>
    <div class="lanes">${Object.keys(TEAM_META).map(laneSkeleton).join("")}</div>
  </section>`;
  Object.keys(TEAM_META).forEach((teamId) => {
    const lane = elements.hostScoreboard.querySelector(`.lane[data-team="${teamId}"]`);
    laneRefs[teamId] = {
      track: lane.querySelector(".lane-track"), fill: lane.querySelector(".lane-fill"),
      pct: lane.querySelector(".lane-pct"), meta: lane.querySelector(".lane-meta"),
      runner: lane.querySelector(".runner"), people: [...lane.querySelectorAll(".tiny-person")]
    };
  });
}

// 只在隊員名單變動時重建骨架（群眾頭像會變），其餘每次只更新樣式。
function renderField() {
  const signature = Object.keys(TEAM_META).map((t) => `${t}:${teamPlayers(t).map((p) => p.name).join(",")}`).join("|");
  if (signature !== fieldSignature || !laneRefs.coral) { buildFieldSkeleton(); fieldSignature = signature; }

  const active = game.status === "running" || game.status === "finishing";
  Object.keys(TEAM_META).forEach((teamId) => {
    const m = teamMetrics(teamId);
    const ref = laneRefs[teamId];
    const hasMembers = teamPlayers(teamId).length > 0;
    const pouring = active && m.pouring;
    ref.fill.style.width = `${m.progress}%`;
    ref.pct.textContent = `${m.progress}%`;
    ref.meta.textContent = `${teamPlayers(teamId).length} 位 · 澆水 ${m.pours} 次`;
    // 跑者：位置跟著 waterUnits，CSS 過渡讓它慢慢滑動；倒水時潑水姿態，回程時水桶倒空。
    const returning = active && !m.outbound && !pouring;
    ref.runner.style.left = `${m.posPct}%`;
    ref.runner.classList.toggle("show", active && hasMembers);
    ref.runner.classList.toggle("is-pour", pouring);
    ref.runner.classList.toggle("is-return", returning);
    ref.track.classList.toggle("is-watering", pouring);
    // 終點小人：依澆水比例由小變大（CSS 過渡平滑）；倒水時整片小人彈跳（happy-sprinkle）。
    const personScale = (0.24 + m.growthRatio * 0.76).toFixed(3);
    const grown = m.growthRatio >= 1;
    ref.people.forEach((p) => {
      p.style.setProperty("--person-scale", personScale);
      p.classList.toggle("is-grown", grown);
    });
  });
}

function statusCopy() {
  const seconds = game.countdownEndsAt ? Math.max(0, Math.ceil((game.countdownEndsAt - Date.now()) / 1000)) : 0;
  if (game.status === "countdown") return { title: `${seconds} 秒後開始`, copy: "各隊隊員在取水起點準備雙桶接力。" };
  if (game.status === "running") return { title: "全力提水中", copy: "手指打水，提水人才會慢慢走向終點倒水讓小人長大。" };
  if (game.status === "finishing") return { title: "灌溉成功！", copy: "最後一桶水正在潑灑，準備結算。" };
  if (game.status === "finished") return { title: `${TEAM_META[game.winner]?.name || "本回合"}獲勝`, copy: "最先讓五位小人全部長大。" };
  return { title: "等待三隊就位", copy: "隊員不限人數，分隊後從起點輪流雙桶接力灌溉。" };
}

function render() {
  const copy = statusCopy();
  const totalPlayers = Object.keys(game.players).length;
  elements.roomLabel.textContent = `房間 ${roomCode}`;
  elements.connectionBadge.textContent = backend.type === "firebase" ? "即時多人模式" : "示範模式";
  elements.connectionBadge.className = `status-badge ${backend.type === "firebase" ? "is-live" : "is-demo"}`;
  elements.hostView.hidden = !isHost; elements.playerView.hidden = isHost;
  document.body.dataset.view = isHost ? "host" : "player";
  document.body.classList.toggle("is-player-joined", !isHost && Boolean(currentPlayer && game.players[currentPlayer.id]));

  if (isHost) {
    const locked = game.status !== "lobby";
    const unassignedCount = Object.values(game.players).filter((player) => !player.team).length;
    elements.hostHeading.textContent = copy.title; elements.hostCopy.textContent = unassignedCount ? `目前有 ${unassignedCount} 人待分隊，請先按「自動分隊」。` : copy.copy;
    elements.startButton.textContent = game.status === "lobby" ? "開始倒數" : game.status === "finished" ? "下一輪" : game.status === "countdown" ? "倒數中" : game.status === "finishing" ? "結算中" : "進行中";
    elements.startButton.disabled = game.status === "countdown" || game.status === "running" || game.status === "finishing" || unassignedCount > 0 || totalPlayers === 0;
    elements.autoAssignButton.disabled = locked || totalPlayers === 0;
    elements.bucketCapacity.value = String(game.settings.bucketCapacity); elements.growthStages.value = String(game.settings.growthStages); elements.countdownSeconds.value = String(game.settings.countdownSeconds);
    [elements.bucketCapacity, elements.growthStages, elements.countdownSeconds].forEach((input) => { input.disabled = locked; });
    renderField();
    elements.playerCount.textContent = `${totalPlayers} 人`;
    const roster = Object.values(game.players).sort((a, b) => a.joinedAt - b.joinedAt);
    elements.playerRoster.innerHTML = roster.length ? roster.map((player) => `<span class="player-pill" style="--team:${TEAM_META[player.team]?.color || "#687d94"}">${escapeHtml(player.name)}${player.team ? "" : "（待分隊）"}</span>`).join("") : '<span class="empty-roster">尚未有人加入</span>';
    renderJoinQrCode();
  } else {
    const joined = Boolean(currentPlayer && game.players[currentPlayer.id]);
    elements.joinPanel.hidden = joined; elements.tapPanel.hidden = !joined;
    if (joined) renderPlayerPanel();
  }

  const showWinner = game.status === "finished" && game.winner;
  elements.winnerOverlay.hidden = !showWinner;
  if (showWinner) { elements.winnerTitle.textContent = `${TEAM_META[game.winner].name}獲勝`; elements.winnerCopy.textContent = "最先讓五位小人全部長大。"; elements.winnerNextButton.hidden = !isHost; }
}

function renderPlayerPanel() {
  const player = game.players[currentPlayer.id];
  if (!player?.team) {
    document.body.style.removeProperty("--active-team"); document.body.style.removeProperty("--active-team-dark");
    elements.yourTeamLabel.textContent = "等待分隊"; elements.tapCounter.textContent = "0 次";
    elements.tapHeading.textContent = "等待主持人自動分隊"; elements.tapMessage.textContent = "主持人完成分隊後，這裡會自動顯示你的隊伍。";
    if (elements.teamProgressFill) elements.teamProgressFill.style.width = "0%";
    elements.tapButton.disabled = true; return;
  }
  const teamId = player.team; const metric = teamMetrics(teamId);
  // 以所屬隊伍顏色點亮玩家頁的打水按鈕與進度條。
  document.body.style.setProperty("--active-team", TEAM_META[teamId].color);
  document.body.style.setProperty("--active-team-dark", TEAM_META[teamId].dark);
  if (elements.teamProgressFill) elements.teamProgressFill.style.width = `${metric.progress}%`;
  const countdownSeconds = game.countdownEndsAt ? Math.max(0, Math.ceil((game.countdownEndsAt - Date.now()) / 1000)) : 0;
  elements.yourTeamLabel.textContent = TEAM_META[teamId].name; elements.tapCounter.textContent = `${Number(player?.taps || 0)} 次`;
  elements.tapButton.disabled = game.status !== "running";
  elements.tapHeading.textContent = game.status === "running" ? "快速打水" : game.status === "finishing" ? "灌溉成功！" : game.status === "finished" ? "本回合結束" : game.status === "countdown" ? `${countdownSeconds} 秒後開始` : "準備提水";
  elements.tapMessage.textContent = game.status === "running" ? `五位小人的成長水分已達 ${metric.progress}%，繼續提水。` : game.status === "finishing" ? "最後一桶水正在潑灑，請等待結算。" : game.status === "finished" ? `${TEAM_META[game.winner]?.name || "本回合"}最先完成灌溉。` : game.status === "countdown" ? "倒數中，先把手指放在按鈕上。" : "等待主持人開始。";
}

function writeLocalState(next) { game = normalizeState(next); localStorage.setItem(localKey, JSON.stringify(game)); backend.channel?.postMessage(game); render(); }
async function mutateGame(mutator) {
  if (backend.type === "firebase") { await firebaseApi.runTransaction(firebaseApi.roomRef, (current) => { const next = normalizeState(current); mutator(next); return next; }); return; }
  const next = clone(game); mutator(next); writeLocalState(next);
}

// 達標所需的總打水量：澆水 maxGrowth 次，倒水落在每趟中段，故約 (maxGrowth - 0.5) 桶。
function unitsToWin(state) {
  const maxGrowth = FINISH_PERSON_COUNT * state.settings.growthStages;
  return (maxGrowth - 0.5) * state.settings.bucketCapacity;
}

async function joinGame(event) {
  event.preventDefault();
  const name = elements.playerName.value.trim().replace(/\s+/g, " ").slice(0, 16); elements.joinError.textContent = "";
  if (!name) { elements.playerName.focus(); return; }
  const player = { id: `p_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`, name, team: null };
  try {
    await mutateGame((state) => {
      state.players[player.id] = { name: player.name, team: player.team, taps: 0, joinedAt: Date.now() };
    });
    saveCurrentPlayer(player); render();
  } catch (error) { showConnectionProblem(error); }
}

async function sendTap() {
  if (!currentPlayer || game.status !== "running") return;
  try {
    const player = game.players[currentPlayer.id];
    if (!player?.team) return;
    if (backend.type === "firebase") {
      await firebaseApi.update(firebaseApi.roomRef, {
        [`teams/${player.team}/waterUnits`]: firebaseApi.increment(1),
        [`players/${currentPlayer.id}/taps`]: firebaseApi.increment(1)
      });
      return;
    }
    await mutateGame((state) => {
      const current = state.players[currentPlayer.id];
      if (state.status !== "running" || !current?.team) return;
      state.teams[current.team].waterUnits += 1;
      current.taps += 1;
    });
  } catch (error) { showConnectionProblem(error); }
}

function sendTapFromPointer(event) {
  if (!event.isPrimary) return;
  lastPointerTapAt = Date.now();
  event.preventDefault();
  sendTap();
}

function sendTapFromClick(event) {
  if (event.detail === 0 || Date.now() - lastPointerTapAt > 500) sendTap();
}

async function startOrResetRound() {
  try {
    if (game.status === "lobby") { await mutateGame((state) => { if (state.status === "lobby") { state.status = "countdown"; state.countdownEndsAt = Date.now() + state.settings.countdownSeconds * 1000; } }); return; }
    if (game.status === "finished") await prepareNextRound();
  } catch (error) { showConnectionProblem(error); }
}

async function prepareNextRound() {
  await mutateGame(resetRoundState);
}

function resetRoundState(state) {
  state.round += 1; state.status = "lobby"; state.countdownEndsAt = null; state.startedAt = null; state.finishedAt = null; state.finishAnimationEndsAt = null; state.winner = null; Object.values(state.teams).forEach((team) => { team.waterUnits = 0; }); Object.values(state.players).forEach((player) => { player.taps = 0; });
}

async function autoAssignTeams() {
  try {
    await mutateGame((state) => {
      if (state.status !== "lobby") return;
      const players = Object.entries(state.players).sort(([, left], [, right]) => Number(left.joinedAt) - Number(right.joinedAt));
      players.forEach(([, player], index) => { player.team = Object.keys(TEAM_META)[index % Object.keys(TEAM_META).length]; player.taps = 0; });
    });
  } catch (error) { showConnectionProblem(error); }
}

async function updateSetting(event) {
  if (game.status !== "lobby") return;
  const input = event.currentTarget; const setting = input.id === "bucket-capacity" ? "bucketCapacity" : input.id === "growth-stages" ? "growthStages" : "countdownSeconds";
  const value = clampNumber(input.value, game.settings[setting], Number(input.min), Number(input.max)); input.value = String(value);
  try { await mutateGame((state) => { state.settings[setting] = value; }); } catch (error) { showConnectionProblem(error); }
}

function showConnectionProblem(error) { console.error("遊戲同步失敗", error); elements.connectionBadge.textContent = "同步失敗"; elements.connectionBadge.className = "status-badge is-demo"; }
function startNextRoundFromResult() {
  if (!isHost || game.status !== "finished") return;
  mutateGame((state) => {
    if (state.status === "finished") resetRoundState(state);
  }).catch(showConnectionProblem);
}

async function reconcileGameClock() {
  if (!isHost) { render(); return; }
  if (game.status === "countdown" && Date.now() >= game.countdownEndsAt) await mutateGame((state) => { if (state.status === "countdown" && Date.now() >= state.countdownEndsAt) { state.status = "running"; state.startedAt = Date.now(); } });
  if (game.status === "running") {
    const someReady = Object.keys(TEAM_META).some((teamId) => teamMetrics(teamId).pours >= teamMetrics(teamId).maxGrowth);
    if (someReady) await mutateGame((state) => {
      if (state.status !== "running") return;
      const winThreshold = unitsToWin(state);
      const winners = Object.keys(TEAM_META).filter((teamId) => state.teams[teamId].waterUnits >= winThreshold);
      if (winners.length) {
        winners.sort((left, right) => state.teams[right].waterUnits - state.teams[left].waterUnits || left.localeCompare(right));
        state.status = "finishing"; state.winner = winners[0]; state.finishAnimationEndsAt = Date.now() + FINISH_DELAY_MS;
      }
    });
  }
  if (game.status === "finishing" && Date.now() >= game.finishAnimationEndsAt) await mutateGame((state) => { if (state.status === "finishing" && Date.now() >= state.finishAnimationEndsAt) { state.status = "finished"; state.finishedAt = Date.now(); state.finishAnimationEndsAt = null; } });
  render();
}

function bindEvents() {
  elements.joinForm.addEventListener("submit", joinGame);
  elements.tapButton.addEventListener("pointerdown", sendTapFromPointer);
  elements.tapButton.addEventListener("click", sendTapFromClick);
  elements.changeTeamButton.addEventListener("click", async () => { if (!currentPlayer) return; const id = currentPlayer.id; try { await mutateGame((state) => { delete state.players[id]; }); sessionStorage.removeItem(playerKey); currentPlayer = null; render(); } catch (error) { showConnectionProblem(error); } });
  elements.startButton.addEventListener("click", startOrResetRound); elements.autoAssignButton.addEventListener("click", autoAssignTeams); elements.winnerNextButton.addEventListener("click", startNextRoundFromResult);
  elements.copyPlayerLinkButton.addEventListener("click", () => { copyPlayerJoinLink().catch(showConnectionProblem); });
  elements.resetButton.addEventListener("click", () => { if (window.confirm("要重設本回合的提水進度嗎？已加入的玩家會保留。")) prepareNextRound().catch(showConnectionProblem); });
  [elements.bucketCapacity, elements.growthStages, elements.countdownSeconds].forEach((input) => input.addEventListener("change", updateSetting));
}

function connectDemo() {
  try { const stored = localStorage.getItem(localKey); game = stored ? normalizeState(JSON.parse(stored)) : createDefaultState(); localStorage.setItem(localKey, JSON.stringify(game)); } catch { game = createDefaultState(); }
  if ("BroadcastChannel" in window) { backend.channel = new BroadcastChannel(localKey); backend.channel.addEventListener("message", (event) => { game = normalizeState(event.data); render(); }); }
  window.addEventListener("storage", (event) => { if (event.key === localKey && event.newValue) { game = normalizeState(JSON.parse(event.newValue)); render(); } });
}

async function connectFirebase() {
  if (!firebaseConfig?.apiKey || !firebaseConfig?.databaseURL) return false;
  try {
    const [{ initializeApp, getApps }, { getAuth, signInAnonymously }, { getDatabase, ref, onValue, runTransaction, update, increment }] = await Promise.all([import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"), import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"), import("https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js")]);
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig); await signInAnonymously(getAuth(app)); const roomRef = ref(getDatabase(app), gamePath()); firebaseApi = { roomRef, runTransaction, update, increment };
    await runTransaction(roomRef, (current) => current?.version >= 3 ? normalizeState(current) : createDefaultState()); onValue(roomRef, (snapshot) => { game = normalizeState(snapshot.val()); render(); }, showConnectionProblem); backend = { type: "firebase", channel: null }; return true;
  } catch (error) { console.warn("Firebase 無法使用，切換為示範模式。", error); return false; }
}

async function initialise() { if (!await connectFirebase()) connectDemo(); bindEvents(); render(); window.setInterval(() => { reconcileGameClock().catch(showConnectionProblem); }, 250); }
initialise();
