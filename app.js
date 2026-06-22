import { firebaseConfig } from "./firebase-config.js";

const FINISH_PERSON_COUNT = 5;
const RELAY_TIMING = { outbound: 1600, pour: 850, return: 2200 };
const RELAY_CYCLE_MS = RELAY_TIMING.outbound + RELAY_TIMING.pour + RELAY_TIMING.return;
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
    version: 5, round: 1, status: "lobby", countdownEndsAt: null, startedAt: null, finishedAt: null, finishAnimationEndsAt: null, winner: null,
    settings: { bucketCapacity: 24, growthStages: 4, countdownSeconds: 5 },
    teams: Object.fromEntries(Object.keys(TEAM_META).map((teamId) => [teamId, { waterUnits: 0, deliveryIndex: -1, lastDeliveryAt: 0, deliveryEvents: [] }])), players: {}
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

function normalizeDeliveryEvents(events, deliveryIndex, lastDeliveryAt) {
  const normalized = Array.isArray(events) ? events.map((event) => ({
    runnerIndex: clampNumber(event?.runnerIndex, -1, -1, 1000000),
    startsAt: clampNumber(event?.startsAt, 0, 0, Number.MAX_SAFE_INTEGER)
  })).filter((event) => event.runnerIndex >= 0 && event.startsAt > 0) : [];
  if (!normalized.length && deliveryIndex >= 0 && lastDeliveryAt > 0) normalized.push({ runnerIndex: deliveryIndex, startsAt: lastDeliveryAt });
  return normalized.sort((left, right) => left.startsAt - right.startsAt);
}

function normalizeState(value) {
  if (!value || ![3, 4, 5].includes(value.version)) return createDefaultState();
  const base = createDefaultState();
  const source = value;
  const players = Object.fromEntries(Object.entries(source.players || {}).filter(([, player]) => player).map(([id, player]) => [id, {
    name: String(player.name || "隊員").slice(0, 16), team: TEAM_META[player.team] ? player.team : null, taps: clampNumber(player.taps, 0, 0, 1000000), joinedAt: clampNumber(player.joinedAt, 0, 0, Number.MAX_SAFE_INTEGER)
  }]));
  return {
    ...base, ...source, version: 5, round: clampNumber(source.round, 1, 1, 100000),
    status: ["lobby", "countdown", "running", "finishing", "finished"].includes(source.status) ? source.status : "lobby",
    finishAnimationEndsAt: clampNumber(source.finishAnimationEndsAt, 0, 0, Number.MAX_SAFE_INTEGER) || null,
    settings: {
      bucketCapacity: clampNumber(source.settings?.bucketCapacity, 24, 5, 100),
      growthStages: clampNumber(source.settings?.growthStages, 4, 1, 8),
      countdownSeconds: clampNumber(source.settings?.countdownSeconds, 5, 1, 20)
    },
    teams: Object.fromEntries(Object.keys(TEAM_META).map((teamId) => [teamId, {
      waterUnits: clampNumber(source.teams?.[teamId]?.waterUnits, 0, 0, 1000000),
      deliveryIndex: clampNumber(source.teams?.[teamId]?.deliveryIndex, -1, -1, 1000000),
      lastDeliveryAt: clampNumber(source.teams?.[teamId]?.lastDeliveryAt, 0, 0, Number.MAX_SAFE_INTEGER),
      deliveryEvents: normalizeDeliveryEvents(source.teams?.[teamId]?.deliveryEvents, clampNumber(source.teams?.[teamId]?.deliveryIndex, -1, -1, 1000000), clampNumber(source.teams?.[teamId]?.lastDeliveryAt, 0, 0, Number.MAX_SAFE_INTEGER))
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

function teamMetrics(teamId) {
  const units = game.teams[teamId].waterUnits;
  const { bucketCapacity, growthStages } = game.settings;
  const deliveredBuckets = Math.floor(units / bucketCapacity);
  const maxGrowth = FINISH_PERSON_COUNT * growthStages;
  const growthTotal = Math.min(units / bucketCapacity, maxGrowth);
  const personGrowth = growthTotal / FINISH_PERSON_COUNT;
  const people = Array.from({ length: FINISH_PERSON_COUNT }, () => Math.min(growthStages, personGrowth));
  return { units, deliveredBuckets, growthTotal, maxGrowth, people, smallFill: Math.round(((units % bucketCapacity) / bucketCapacity) * 100), progress: Math.round((growthTotal / maxGrowth) * 100) };
}

// 終點小人：以 emoji 呈現，隨澆水比例由小長到大，長大後換成大人並冒出星星。
function personMarkup(stage, index, growthStages) {
  const ratio = Math.min(1, stage / growthStages);
  const scale = (0.42 + ratio * 0.58).toFixed(3);
  const grown = ratio >= 1;
  const faces = ["🧒", "👦", "👧", "🧒", "👶"];
  const label = grown ? "已長大" : `吸收水分 ${Math.round(ratio * 100)}%`;
  return `<span class="grower ${grown ? "is-grown" : ""}" style="--g:${scale}" aria-label="第 ${index + 1} 位小人，${label}">
    <span class="grower-face">${grown ? "🧑" : faces[index % faces.length]}</span>
    <span class="grower-spark" aria-hidden="true">✨</span>
  </span>`;
}

// 接力跑者：emoji 人物 + 水桶，依進度沿賽道由左(起點)往右(終點)移動；倒水時換成潑水動作。
function runnerMarkup(role, progress, pouring, label) {
  const pos = Math.round(12 + Math.min(1, Math.max(0, progress)) * 70);
  const accessibleLabel = escapeHtml(label);
  const person = pouring ? "🧍" : "🏃";
  const load = pouring ? "💦" : "🪣";
  return `<span class="runner ${role} ${pouring ? "is-pouring" : ""}" style="--pos:${pos}%" aria-label="${accessibleLabel}">
    <span class="runner-person" aria-hidden="true">${person}</span><span class="runner-load" aria-hidden="true">${load}</span>
  </span>`;
}

function relayIsActive() { return game.status === "running" || game.status === "finishing"; }

function isPouringAtFinish(teamId) {
  if (!relayIsActive()) return false;
  const now = Date.now();
  return game.teams[teamId].deliveryEvents.some((event) => {
    const elapsed = now - event.startsAt;
    return elapsed >= RELAY_TIMING.outbound && elapsed < RELAY_TIMING.outbound + RELAY_TIMING.pour;
  });
}

function relayMarkup(teamId) {
  const team = game.teams[teamId];
  const members = teamPlayers(teamId);
  if (!members.length || !relayIsActive()) return "";
  const now = Date.now();
  return team.deliveryEvents.map((event) => {
    const elapsed = now - event.startsAt;
    if (elapsed < 0 || elapsed >= RELAY_CYCLE_MS) return "";
    const runnerIndex = event.runnerIndex % members.length;
    const currentName = members[runnerIndex]?.name || "隊員";
    if (elapsed < RELAY_TIMING.outbound) return runnerMarkup("is-outbound", elapsed / RELAY_TIMING.outbound, false, `${currentName}正提著兩桶水前往灌溉`);
    if (elapsed < RELAY_TIMING.outbound + RELAY_TIMING.pour) return runnerMarkup("is-pouring", 1, true, `${currentName}正在灌溉`);
    const returnProgress = (elapsed - RELAY_TIMING.outbound - RELAY_TIMING.pour) / RELAY_TIMING.return;
    return runnerMarkup("is-returning", 1 - returnProgress, false, `${currentName}正提著空桶返回起點`);
  }).join("");
}

// 起點群眾：以 emoji 頭像表示等待接力的隊員，超過顯示上限以 +N 標示。
function crowdMarkup(teamId) {
  const members = teamPlayers(teamId);
  const faces = ["🧑", "🧒", "👦", "👧", "🧓", "👩"];
  const cap = 6;
  const visibleCount = Math.max(3, Math.min(cap, members.length || 3));
  const visible = Array.from({ length: visibleCount }, (_, index) => {
    const player = members[index];
    const name = player?.name || "隊員";
    return `<span class="crowd-face ${player ? "" : "is-support"}" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">${faces[index % faces.length]}</span>`;
  }).join("");
  const overflow = members.length > cap ? `<span class="crowd-overflow">+${members.length - cap}</span>` : "";
  return `${visible}${overflow}`;
}

// 單一隊伍賽道：左側取水起點 → 接力跑者 → 右側終點五位小人，下方為成長進度條。
function irrigationLaneMarkup(teamId) {
  const meta = TEAM_META[teamId];
  const metric = teamMetrics(teamId);
  const people = metric.people.map((stage, index) => personMarkup(stage, index, game.settings.growthStages)).join("");
  const watering = isPouringAtFinish(teamId);
  return `<section class="lane" style="--team:${meta.color};--team-dark:${meta.dark}" aria-label="${meta.name}由左側取水往右側灌溉">
    <div class="lane-head">
      <span class="lane-name">${meta.name}</span>
      <span class="lane-meta">${teamPlayers(teamId).length} 位 · ${metric.deliveredBuckets} 桶</span>
      <span class="lane-pct">${metric.progress}%</span>
    </div>
    <div class="lane-track ${watering ? "is-watering" : ""}">
      <div class="lane-fill" style="width:${metric.progress}%"></div>
      <div class="zone start-zone"><div class="crowd">${crowdMarkup(teamId)}</div><span class="zone-tag">💧 取水</span></div>
      <div class="runners">${relayMarkup(teamId)}</div>
      <div class="zone finish-zone">
        <div class="rain" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="growers">${people}</div>
        <span class="zone-tag">🌱 灌溉</span>
      </div>
    </div>
  </section>`;
}

function sharedRaceStageMarkup() {
  return `<section class="field" aria-label="三隊同場接力賽場">
    <header class="field-head">
      <div><p class="section-label">三隊同場接力</p><h3>澆水成長賽場</h3></div>
      <span class="field-hint">隊員從左側取水，提到右側讓五位小人長大</span>
    </header>
    <div class="lanes">${Object.keys(TEAM_META).map(irrigationLaneMarkup).join("")}</div>
  </section>`;
}

function statusCopy() {
  const seconds = game.countdownEndsAt ? Math.max(0, Math.ceil((game.countdownEndsAt - Date.now()) / 1000)) : 0;
  if (game.status === "countdown") return { title: `${seconds} 秒後開始`, copy: "各隊隊員在取水起點準備雙桶接力。" };
  if (game.status === "running") return { title: "全力提水中", copy: "每提滿一桶，就派一位隊員雙手提桶前往灌溉。" };
  if (game.status === "finishing") return { title: "最後一趟回程中", copy: "完成灌溉的隊員正在帶著空桶返回起點。" };
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
    elements.startButton.textContent = game.status === "lobby" ? "開始倒數" : game.status === "finished" ? "下一輪" : game.status === "countdown" ? "倒數中" : game.status === "finishing" ? "回程中" : "進行中";
    elements.startButton.disabled = game.status === "countdown" || game.status === "running" || game.status === "finishing" || unassignedCount > 0 || totalPlayers === 0;
    elements.autoAssignButton.disabled = locked || totalPlayers === 0;
    elements.bucketCapacity.value = String(game.settings.bucketCapacity); elements.growthStages.value = String(game.settings.growthStages); elements.countdownSeconds.value = String(game.settings.countdownSeconds);
    [elements.bucketCapacity, elements.growthStages, elements.countdownSeconds].forEach((input) => { input.disabled = locked; });
    elements.hostScoreboard.innerHTML = sharedRaceStageMarkup();
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
  elements.tapHeading.textContent = game.status === "running" ? "快速打水" : game.status === "finishing" ? "最後一趟回程中" : game.status === "finished" ? "本回合結束" : game.status === "countdown" ? `${countdownSeconds} 秒後開始` : "準備提水";
  elements.tapMessage.textContent = game.status === "running" ? `五位小人的成長水分已達 ${metric.progress}%，繼續提水。` : game.status === "finishing" ? "隊員正在帶著空桶返回起點，請等待結算。" : game.status === "finished" ? `${TEAM_META[game.winner]?.name || "本回合"}最先完成灌溉。` : game.status === "countdown" ? "倒數中，先把手指放在按鈕上。" : "等待主持人開始。";
}

function writeLocalState(next) { game = normalizeState(next); localStorage.setItem(localKey, JSON.stringify(game)); backend.channel?.postMessage(game); render(); }
async function mutateGame(mutator) {
  if (backend.type === "firebase") { await firebaseApi.runTransaction(firebaseApi.roomRef, (current) => { const next = normalizeState(current); mutator(next); return next; }); return; }
  const next = clone(game); mutator(next); writeLocalState(next);
}

function queueDelivery(team, timestamp) {
  const activeOrQueued = team.deliveryEvents.filter((event) => event.startsAt + RELAY_CYCLE_MS > timestamp);
  const previous = activeOrQueued[activeOrQueued.length - 1];
  team.deliveryIndex += 1;
  const startsAt = Math.max(timestamp, previous ? previous.startsAt + RELAY_TIMING.outbound + RELAY_TIMING.pour : 0);
  team.deliveryEvents = [...activeOrQueued, { runnerIndex: team.deliveryIndex, startsAt }];
  team.lastDeliveryAt = startsAt;
}

function queuePendingDeliveries(state, timestamp) {
  const maxDeliveries = FINISH_PERSON_COUNT * state.settings.growthStages;
  Object.values(state.teams).forEach((team) => {
    const deliveredBuckets = Math.min(Math.floor(team.waterUnits / state.settings.bucketCapacity), maxDeliveries);
    while (team.deliveryIndex + 1 < deliveredBuckets) queueDelivery(team, timestamp);
  });
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
      const team = state.teams[current.team];
      const previousBuckets = Math.floor(team.waterUnits / state.settings.bucketCapacity);
      team.waterUnits += 1;
      const deliveredBuckets = Math.floor(team.waterUnits / state.settings.bucketCapacity);
      if (deliveredBuckets > previousBuckets) queueDelivery(team, Date.now());
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
  state.round += 1; state.status = "lobby"; state.countdownEndsAt = null; state.startedAt = null; state.finishedAt = null; state.finishAnimationEndsAt = null; state.winner = null; Object.values(state.teams).forEach((team) => { team.waterUnits = 0; team.deliveryIndex = -1; team.lastDeliveryAt = 0; team.deliveryEvents = []; }); Object.values(state.players).forEach((player) => { player.taps = 0; });
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
    const hasPendingDeliveries = Object.keys(TEAM_META).some((teamId) => {
      const metric = teamMetrics(teamId);
      return game.teams[teamId].deliveryIndex + 1 < Math.min(metric.deliveredBuckets, metric.maxGrowth);
    });
    const ready = Object.keys(TEAM_META).filter((teamId) => {
      const metric = teamMetrics(teamId);
      return metric.growthTotal >= metric.maxGrowth;
    });
    if (hasPendingDeliveries || ready.length) await mutateGame((state) => {
      if (state.status !== "running") return;
      queuePendingDeliveries(state, Date.now());
      const winners = Object.keys(TEAM_META).filter((teamId) => Math.min(Math.floor(state.teams[teamId].waterUnits / state.settings.bucketCapacity), FINISH_PERSON_COUNT * state.settings.growthStages) >= FINISH_PERSON_COUNT * state.settings.growthStages);
      if (winners.length) {
        winners.sort((left, right) => state.teams[right].waterUnits - state.teams[left].waterUnits || left.localeCompare(right));
        const lastReturnAt = Math.max(Date.now(), ...Object.values(state.teams).flatMap((team) => team.deliveryEvents.map((event) => event.startsAt + RELAY_CYCLE_MS)));
        state.status = "finishing"; state.winner = winners[0]; state.finishAnimationEndsAt = lastReturnAt;
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
