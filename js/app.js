import { createInitialState, ROUND_NAMES, STATE_VERSION } from "./data.js?v=8";
import { buildBracket, getChampionSignals, getProjectedChampion } from "./bracket.js?v=8";
import { scoreMatch, summarizeScores } from "./scoring.js?v=8";
import { createLiveStore } from "./supabaseStore.js?v=8";
import { formatTeam, getFlag } from "./flags.js?v=8";

const STORAGE_KEY = "world-cup-r32-bracket-state";
let state = loadState();
let liveStore = null;
let remoteSaveTimer = null;
let submissions = [];

const elements = {
  matchList: document.querySelector("#matchList"),
  bracket: document.querySelector("#bracket"),
  championMetric: document.querySelector("#championMetric"),
  championSource: document.querySelector("#championSource"),
  pointsMetric: document.querySelector("#pointsMetric"),
  pointsDetail: document.querySelector("#pointsDetail"),
  accuracyMetric: document.querySelector("#accuracyMetric"),
  accuracyDetail: document.querySelector("#accuracyDetail"),
  exactMetric: document.querySelector("#exactMetric"),
  exactDetail: document.querySelector("#exactDetail"),
  completedPill: document.querySelector("#completedPill"),
  qualityStats: document.querySelector("#qualityStats"),
  championSignals: document.querySelector("#championSignals"),
  scoreBreakdown: document.querySelector("#scoreBreakdown"),
  standings: document.querySelector("#standings"),
  livePointsChart: document.querySelector("#livePointsChart"),
  projectedPointsChart: document.querySelector("#projectedPointsChart"),
  template: document.querySelector("#matchCardTemplate"),
  resetButton: document.querySelector("#resetButton"),
  simulateButton: document.querySelector("#simulateButton"),
  lockButton: document.querySelector("#lockButton"),
  lockButtons: document.querySelectorAll("#lockButton, .lock-button"),
  lockTitle: document.querySelector("#lockTitle"),
  lockCopy: document.querySelector("#lockCopy"),
  playerName: document.querySelector("#playerName"),
  syncStatus: document.querySelector("#syncStatus"),
};

init();

elements.matchList?.addEventListener("input", handleMatchInput);
elements.matchList?.addEventListener("change", handleMatchInput);
elements.resetButton?.addEventListener("click", resetApp);
elements.simulateButton?.addEventListener("click", simulateScores);
elements.lockButtons.forEach((button) => button.addEventListener("click", lockBracket));
elements.playerName?.addEventListener("input", handlePlayerInput);
elements.bracket?.addEventListener("click", handleBracketPick);
elements.bracket?.addEventListener("input", handleBracketScoreInput);
elements.bracket?.addEventListener("change", handleBracketScoreInput);

async function init() {
  render();

  try {
    liveStore = await createLiveStore();
    setSyncStatus(liveStore.status, liveStore.enabled ? "connected" : "local");

    const remoteState = await liveStore.load();
    if (isValidState(remoteState) && isNewer(remoteState, state)) {
      state = remoteState;
      render();
    } else if (liveStore.enabled) {
      await liveStore.save(state);
    }

    if (liveStore.enabled) {
      submissions = await liveStore.loadSubmissions();
      render();
    }

    liveStore.subscribe((incomingState) => {
      if (!isValidState(incomingState) || !isNewer(incomingState, state)) return;
      state = incomingState;
      render();
      setSyncStatus("Live update received", "connected");
    });

    liveStore.subscribeSubmissions(async () => {
      submissions = await liveStore.loadSubmissions();
      render();
      setSyncStatus("Entries updated", "connected");
    });
  } catch (error) {
    console.error(error);
    setSyncStatus("Local fallback", "warning");
  }
}

function render() {
  const rounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores);
  const summary = summarizeScores(state.matches);
  const champion = getProjectedChampion(rounds);
  const players = buildPlayers();

  renderMatches();
  renderBracket(rounds);
  renderMetrics(summary, champion);
  renderStats(summary);
  renderChampionSignals();
  renderScoreBreakdown();
  renderStandings(players);
  renderCharts(players);
  renderLockState();
  renderPlayerDetails();
  persist();
}

function renderMatches() {
  if (!elements.matchList || !elements.template) return;

  elements.matchList.replaceChildren(
    ...state.matches.map((match) => {
      const fragment = elements.template.content.cloneNode(true);
      const card = fragment.querySelector(".match-card");
      card.dataset.matchId = match.id;
      card.toggleAttribute("data-locked", state.locked);
      fragment.querySelector(".match-code").textContent = `Match ${match.matchNumber}`;
      fragment.querySelector(".fixture-note").textContent = match.note || "";
      if (fragment.querySelector(".status-select")) fragment.querySelector(".status-select").value = match.actual.status;
      fragment.querySelector(".prediction-home").value = match.prediction.home ?? "";
      fragment.querySelector(".prediction-away").value = match.prediction.away ?? "";
      renderPickOptions(fragment.querySelector(".prediction-pick"), match);
      if (fragment.querySelector(".actual-home")) fragment.querySelector(".actual-home").value = match.actual.home ?? "";
      if (fragment.querySelector(".actual-away")) fragment.querySelector(".actual-away").value = match.actual.away ?? "";
      renderPickOptions(fragment.querySelector(".actual-pick"), match, match.actual.pick || match.prediction.pick || "home");
      fragment.querySelector(".teams").replaceChildren(renderTeamRow(match, "home"), renderTeamRow(match, "away"));
      fragment.querySelector(".winner-row").textContent = getWinnerText(match);
      fragment.querySelector(".points-row").textContent = elements.lockButton ? "" : getPointsText(match);
      fragment.querySelectorAll("input, select").forEach((control) => {
        if (state.locked && !control.matches(".status-select, .actual-home, .actual-away, .actual-pick")) {
          control.disabled = true;
        }
      });
      return fragment;
    }),
  );
}

function renderTeamRow(match, side) {
  const row = document.createElement("label");
  row.className = "team-row";
  row.innerHTML = `
    <span class="team-flag" aria-hidden="true">${getFlag(match[side])}</span>
    <input class="team-name" data-side="${side}" aria-label="${side} team name" />
    <span class="team-score">${match.actual[side] ?? "-"}</span>
  `;
  row.querySelector("input").value = match[side];
  return row;
}

function renderPickOptions(select, match, value = match.prediction.pick || "home") {
  if (!select) return;
  select.replaceChildren(new Option(formatTeam(match.home), "home"), new Option(formatTeam(match.away), "away"));
  select.value = value;
}

function renderBracket(rounds) {
  if (!elements.bracket) return;

  elements.bracket.replaceChildren(
    ...rounds.map((round, index) => {
      const column = document.createElement("div");
      column.className = "round-column";
      column.innerHTML = `<div class="round-title">${ROUND_NAMES[index]}</div>`;
      round.forEach((node) => column.append(renderBracketNode(node)));
      return column;
    }),
  );
}

function renderBracketNode(node) {
  const article = document.createElement("article");
  article.className = "bracket-node";
  article.dataset.round = node.round;
  article.innerHTML = `
    <div class="bracket-node__head">
      <span>${node.label}</span>
      <span class="node-status ${node.status}" title="${node.status}"></span>
    </div>
    ${node.teams
      .map(
        (team, index) => `
          <div class="bracket-node__row ${node.winner === team.name ? "is-winner" : ""}">
            <button
              class="bracket-node__team"
              type="button"
              data-node-id="${node.id}"
              data-round="${node.round}"
              data-team-index="${index}"
              data-team-name="${team.name}"
              ${team.name === "TBD" || state.locked ? "disabled" : ""}
              aria-pressed="${node.winner === team.name}"
            >
              <span class="team-label"><span aria-hidden="true">${getFlag(team.name)}</span><strong>${team.name}</strong></span>
            </button>
            <input
              class="bracket-score-input"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              min="0"
              max="15"
              value="${node.score[index] ?? ""}"
              data-node-id="${node.id}"
              data-round="${node.round}"
              data-score-index="${index}"
              aria-label="${team.name} predicted goals"
              ${state.locked ? "disabled" : ""}
            />
          </div>
        `,
      )
      .join("")}
  `;
  return article;
}

function renderLockState() {
  if (!elements.lockButton) return;

  elements.lockButtons.forEach((button) => {
    button.disabled = state.locked;
    button.textContent = state.locked ? "Bracket Locked" : "Lock My Bracket";
  });
  if (elements.resetButton) elements.resetButton.disabled = state.locked;
  elements.lockTitle.textContent = state.locked ? "Locked bracket" : "Draft bracket";
  elements.lockCopy.textContent = state.locked
    ? `Locked ${formatDateTime(state.lockedAt)}. Your picks are frozen.`
    : "Add your name, pick winners, enter scores, then lock your bracket. Make sure to click and select the team you predict to win in each bracket.";
  elements.playerName?.toggleAttribute("disabled", state.locked);
}

function renderPlayerDetails() {
  if (elements.playerName && elements.playerName.value !== (state.player?.name || "")) {
    elements.playerName.value = state.player?.name || "";
  }

}

function renderMetrics(summary, champion) {
  if (elements.championMetric) elements.championMetric.textContent = champion || "-";
  if (elements.championSource) elements.championSource.textContent = champion ? "Based on current picks and scores" : "Add picks to see a winner";
  if (elements.pointsMetric) elements.pointsMetric.textContent = formatNumber(summary.total);
  if (elements.pointsDetail) elements.pointsDetail.textContent = `${formatNumber(summary.total)} of ${formatNumber(summary.maxPoints)} possible`;
  if (elements.accuracyMetric) elements.accuracyMetric.textContent = `${Math.round(summary.accuracy * 100)}%`;
  if (elements.accuracyDetail) elements.accuracyDetail.textContent = `${summary.winnerHits}/${summary.completed} completed winners`;
  if (elements.exactMetric) elements.exactMetric.textContent = summary.exactHits;
  if (elements.exactDetail) elements.exactDetail.textContent = `${summary.exactHits}/${summary.completed} final matches`;
  if (elements.completedPill) elements.completedPill.textContent = elements.lockButton ? (state.locked ? "Locked" : "Draft") : `${summary.completed}/16 final`;
}

function renderStats(summary) {
  if (!elements.qualityStats) return;

  elements.qualityStats.innerHTML = `
    <div class="stat-line"><span>Winner hit rate</span><strong>${Math.round(summary.accuracy * 100)}%</strong></div>
    <div class="stat-line"><span>Goal difference rate</span><strong>${Math.round(summary.goalDiffRate * 100)}%</strong></div>
    <div class="stat-line"><span>Exact score rate</span><strong>${Math.round(summary.exactRate * 100)}%</strong></div>
    <div class="stat-line"><span>Points efficiency</span><strong>${summary.maxPoints ? Math.round((summary.total / summary.maxPoints) * 100) : 0}%</strong></div>
    <div class="stat-line"><span>Average points per final</span><strong>${summary.completed ? (summary.total / summary.completed).toFixed(2) : "0.00"}</strong></div>
  `;
}

function renderChampionSignals() {
  if (!elements.championSignals) return;

  const signals = getChampionSignals(state.matches);
  const max = Math.max(...signals.map((signal) => signal.value), 1);

  elements.championSignals.replaceChildren(
    ...(signals.length
      ? signals.map((signal) => {
          const item = document.createElement("div");
          item.className = "bar-item";
          item.innerHTML = `
            <div class="bar-item__row"><span>${formatTeam(signal.name)}</span><strong>${signal.value}</strong></div>
            <div class="bar"><span style="width: ${(signal.value / max) * 100}%"></span></div>
          `;
          return item;
        })
      : [emptyState("No favorites yet")]),
  );
}

function renderScoreBreakdown() {
  if (!elements.scoreBreakdown) return;

  const rows = state.matches
    .filter((match) => match.actual.status === "final")
    .map((match) => {
      const score = scoreMatch(match);
      const row = document.createElement("div");
      row.className = "breakdown-row";
      row.innerHTML = `
        <div>
          <strong>Match ${match.matchNumber}: ${formatTeam(match.home)} vs ${formatTeam(match.away)}</strong>
          <small>Winner ${score.winner ? "+1" : "+0"} | GD ${score.goalDifference ? "+0.5" : "+0"} | Exact ${score.exact ? "+1" : "+0"}</small>
        </div>
        <strong>${formatNumber(score.total)}</strong>
      `;
      return row;
    });

  elements.scoreBreakdown.replaceChildren(...(rows.length ? rows : [emptyState("Final scores will appear here")]));
}

function renderStandings(players) {
  if (!elements.standings) return;
  if (!players.length) {
    elements.standings.replaceChildren(emptyState("No locked brackets yet."));
    return;
  }

  const rows = players
    .slice()
    .sort((a, b) => b.livePoints - a.livePoints || b.projectedPoints - a.projectedPoints)
    .map((player, index) => {
      const row = document.createElement("div");
      row.className = "standing-row";
      row.innerHTML = `
        <span class="standing-rank">${index + 1}</span>
        <strong>${player.name}</strong>
        <span>${formatNumber(player.livePoints)} live</span>
        <span>${formatNumber(player.projectedPoints)} projected</span>
      `;
      return row;
    });

  elements.standings.replaceChildren(...rows);
}

function renderCharts(players) {
  renderPointsList(elements.livePointsChart, players, "livePoints");
  renderPointsList(elements.projectedPointsChart, players, "projectedPoints");
}

function renderPointsList(container, players, key) {
  if (!container) return;
  if (!players.length) {
    container.replaceChildren(emptyState("No locked brackets yet."));
    return;
  }

  const sorted = players.slice().sort((a, b) => b[key] - a[key]);
  const max = Math.max(...sorted.map((player) => player[key]), 2.5);
  const rows = sorted.map((player, index) => {
    const row = document.createElement("div");
    row.className = "points-row-chart";
    row.innerHTML = `
      <span class="standing-rank">${index + 1}</span>
      <strong>${player.name}</strong>
      <div class="points-track"><span style="width: ${(player[key] / max) * 100}%"></span></div>
      <b>${formatNumber(player[key])}</b>
    `;
    return row;
  });

  container.replaceChildren(...rows);
}

function buildPlayers() {
  return submissions.map((submission) => buildSubmittedPlayer(submission));
}

function buildSubmittedPlayer(submission) {
  const submittedState = submission.state;
  const submittedMatches = submittedState.matches || [];
  const matches = state.matches.map((liveMatch, index) => ({
    ...liveMatch,
    prediction: submittedMatches[index]?.prediction || liveMatch.prediction,
  }));
  const livePoints = summarizeScores(matches).total;
  const projectedMatches = matches.map((match) => ({
    ...match,
    actual:
      match.actual.status === "final"
        ? match.actual
        : {
            home: match.prediction.home,
            away: match.prediction.away,
            pick: match.prediction.pick,
            status: "final",
          },
  }));
  const name = submission.player_name || submittedState.player?.name || "Anonymous";

  return {
    id: submission.id,
    name,
    shortName: name.slice(0, 8),
    livePoints,
    projectedPoints: summarizeScores(projectedMatches).total,
  };
}

function handleMatchInput(event) {
  if (state.locked && event.target.matches(".team-name, .prediction-home, .prediction-away, .prediction-pick")) return;
  const card = event.target.closest(".match-card");
  if (!card) return;
  const match = state.matches.find((item) => item.id === card.dataset.matchId);
  if (!match) return;
  const focusTarget = captureFocus(event.target, match.id);

  if (event.target.matches(".team-name")) {
    match[event.target.dataset.side] = event.target.value.trim() || "TBD";
  }

  if (event.target.matches(".status-select")) match.actual.status = event.target.value;
  if (event.target.matches(".prediction-home")) match.prediction.home = parseInput(event.target.value);
  if (event.target.matches(".prediction-away")) match.prediction.away = parseInput(event.target.value);
  if (event.target.matches(".prediction-pick")) match.prediction.pick = event.target.value;
  if (event.target.matches(".actual-home")) match.actual.home = parseInput(event.target.value);
  if (event.target.matches(".actual-away")) match.actual.away = parseInput(event.target.value);
  if (event.target.matches(".actual-pick")) match.actual.pick = event.target.value;
  state.updatedAt = new Date().toISOString();
  render();
  queueRemoteSave();
  restoreFocus(focusTarget);
}

function handleBracketPick(event) {
  const button = event.target.closest(".bracket-node__team");
  if (!button || state.locked || button.disabled) return;

  if (button.dataset.round === "0") {
    const match = state.matches.find((item) => item.id === button.dataset.nodeId);
    if (match) match.prediction.pick = button.dataset.teamIndex === "0" ? "home" : "away";
  } else {
    state.bracketPicks[button.dataset.nodeId] = button.dataset.teamName;
  }

  state.updatedAt = new Date().toISOString();
  render();
  queueRemoteSave();
}

function handleBracketScoreInput(event) {
  if (!event.target.matches(".bracket-score-input") || state.locked) return;

  const value = parseInput(event.target.value);
  const index = Number(event.target.dataset.scoreIndex);

  if (event.target.dataset.round === "0") {
    const match = state.matches.find((item) => item.id === event.target.dataset.nodeId);
    if (!match) return;
    if (index === 0) match.prediction.home = value;
    if (index === 1) match.prediction.away = value;
  } else {
    const current = state.bracketScores[event.target.dataset.nodeId] || [null, null];
    current[index] = value;
    state.bracketScores[event.target.dataset.nodeId] = current;
  }

  state.updatedAt = new Date().toISOString();
  render();
  queueRemoteSave();
  restoreBracketFocus(event.target.dataset.nodeId, event.target.dataset.round, index);
}

function handlePlayerInput(event) {
  if (state.locked) return;
  state.player ||= { name: "" };
  if (event.target === elements.playerName) state.player.name = event.target.value;
  state.updatedAt = new Date().toISOString();
  persist();
  queueRemoteSave();
}

function getWinnerText(match) {
  if (elements.lockButton) {
    return state.locked ? "Locked in." : "Draft pick. Lock your bracket before the first match.";
  }

  const score = scoreMatch(match);
  if (match.actual.status === "final") {
    return `Final scoring: ${formatNumber(score.total)} pts`;
  }
  if (match.actual.status === "live") {
    return "Current score is setting this bracket spot";
  }
  return "Your pick is setting this bracket spot";
}

function getPointsText(match) {
  const score = scoreMatch(match);
  if (!score.complete) return "Set the match to Final to count points.";
  return `Winner ${score.winner ? "+1" : "+0"} | Goal difference ${score.goalDifference ? "+0.5" : "+0"} | Exact ${score.exact ? "+1" : "+0"}`;
}

function simulateScores() {
  state.matches.forEach((match, index) => {
    if (match.actual.status === "final") return;
    const home = Math.max(0, Math.round((Number(match.prediction.home) || 1) + ((index % 3) - 1)));
    const away = Math.max(0, Math.round((Number(match.prediction.away) || 0) + (index % 2)));
    match.actual = { ...match.actual, home, away, pick: home >= away ? "home" : "away", status: index < 8 ? "final" : "live" };
  });
  state.updatedAt = new Date().toISOString();
  render();
  queueRemoteSave();
}

function resetApp() {
  localStorage.removeItem(STORAGE_KEY);
  state = createInitialState();
  render();
  queueRemoteSave({ immediate: true });
}

function lockBracket() {
  if (state.locked) return;
  if (elements.playerName && !state.player?.name?.trim()) {
    elements.playerName.focus();
    elements.lockCopy.textContent = "Add your name before locking your bracket.";
    return;
  }
  state.locked = true;
  state.lockedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();
  render();
  saveSubmission();
  queueRemoteSave({ immediate: true });
}

async function saveSubmission() {
  if (!liveStore?.enabled) return;

  try {
    await liveStore.saveSubmission(state);
    submissions = await liveStore.loadSubmissions();
    setSyncStatus("Submission saved", "connected");
  } catch (error) {
    console.error(error);
    setSyncStatus("Save failed", "warning");
  }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidState(saved)) return saved;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return createInitialState();
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function queueRemoteSave({ immediate = false } = {}) {
  if (!liveStore?.enabled) return;
  clearTimeout(remoteSaveTimer);

  const save = async () => {
    try {
      setSyncStatus("Syncing...", "syncing");
      await liveStore.save(state);
      setSyncStatus("Live synced", "connected");
    } catch (error) {
      console.error(error);
      setSyncStatus("Sync failed", "warning");
    }
  };

  if (immediate) {
    save();
    return;
  }

  remoteSaveTimer = setTimeout(save, 450);
}

function setSyncStatus(message, mode) {
  if (!elements.syncStatus) return;
  elements.syncStatus.textContent = message;
  elements.syncStatus.dataset.mode = mode;
}

function isNewer(candidate, current) {
  return new Date(candidate.updatedAt || 0).getTime() > new Date(current.updatedAt || 0).getTime();
}

function isValidState(candidate) {
  return candidate?.version === STATE_VERSION && candidate?.matches?.length === 16;
}

function parseInput(value) {
  return value === "" ? null : Number(value);
}

function emptyState(message) {
  const item = document.createElement("p");
  item.className = "empty-state";
  item.textContent = message;
  return item;
}

function formatNumber(number) {
  return Number(number).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function captureFocus(target, matchId) {
  let selector = null;
  if (target.matches(".team-name")) selector = `.team-name[data-side="${target.dataset.side}"]`;
  if (target.matches(".status-select")) selector = ".status-select";
  if (target.matches(".prediction-home")) selector = ".prediction-home";
  if (target.matches(".prediction-away")) selector = ".prediction-away";
  if (target.matches(".prediction-pick")) selector = ".prediction-pick";
  if (target.matches(".actual-home")) selector = ".actual-home";
  if (target.matches(".actual-away")) selector = ".actual-away";
  if (target.matches(".actual-pick")) selector = ".actual-pick";

  return {
    matchId,
    selector,
    start: "selectionStart" in target ? target.selectionStart : null,
    end: "selectionEnd" in target ? target.selectionEnd : null,
  };
}

function restoreFocus(focusTarget) {
  if (!focusTarget?.selector || !elements.matchList) return;
  const card = elements.matchList.querySelector(`[data-match-id="${focusTarget.matchId}"]`);
  const target = card?.querySelector(focusTarget.selector);
  if (!target) return;
  target.focus({ preventScroll: true });

  if (focusTarget.start !== null && "setSelectionRange" in target) {
    try {
      target.setSelectionRange(focusTarget.start, focusTarget.end);
    } catch {
      // Number inputs do not support text selection in every browser.
    }
  }
}

function restoreBracketFocus(nodeId, round, index) {
  const target = elements.bracket?.querySelector(
    `.bracket-score-input[data-node-id="${nodeId}"][data-round="${round}"][data-score-index="${index}"]`,
  );
  target?.focus({ preventScroll: true });
}
