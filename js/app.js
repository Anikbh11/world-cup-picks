import { createInitialState, ROUND_NAMES, STATE_VERSION } from "./data.js?v=16";
import { buildBracket, getProjectedChampion } from "./bracket.js?v=16";
import { scoreMatch, summarizeScores } from "./scoring.js?v=16";
import { createLiveStore } from "./supabaseStore.js?v=16";
import { formatTeam, getFlag } from "./flags.js?v=16";

const STORAGE_KEY = "world-cup-r32-bracket-state";
const PERSONAL_LOOKUP_KEY = "world-cup-r32-personal-lookup";
let state = loadState();
let liveStore = null;
let remoteSaveTimer = null;
let submissions = [];
let personalLookup = localStorage.getItem(PERSONAL_LOOKUP_KEY) || "";

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
  playerLookup: document.querySelector("#playerLookup"),
  poolRaceStats: document.querySelector("#poolRaceStats"),
  standings: document.querySelector("#standings"),
  template: document.querySelector("#matchCardTemplate"),
  resetButton: document.querySelector("#resetButton"),
  simulateButton: document.querySelector("#simulateButton"),
  lockButton: document.querySelector("#lockButton"),
  lockButtons: document.querySelectorAll("#lockButton, .lock-button"),
  lockTitle: document.querySelector("#lockTitle"),
  lockCopy: document.querySelector("#lockCopy"),
  playerName: document.querySelector("#playerName"),
  bracketLookup: document.querySelector("#bracketLookup"),
  syncStatus: document.querySelector("#syncStatus"),
};

const isBracketEntryPage = Boolean(elements.lockButton);

init();

elements.matchList?.addEventListener("input", handleMatchInput);
elements.matchList?.addEventListener("change", handleMatchInput);
elements.resetButton?.addEventListener("click", resetApp);
elements.simulateButton?.addEventListener("click", simulateScores);
elements.lockButtons.forEach((button) => button.addEventListener("click", lockBracket));
elements.playerName?.addEventListener("input", handlePlayerInput);
elements.bracketLookup?.addEventListener("input", handleBracketLookup);
elements.playerLookup?.addEventListener("input", handlePersonalLookup);
elements.bracket?.addEventListener("click", handleBracketPick);
elements.bracket?.addEventListener("input", handleBracketScoreInput);
elements.bracket?.addEventListener("change", handleBracketScoreInput);

async function init() {
  render();

  try {
    liveStore = await createLiveStore();
    setSyncStatus(liveStore.status, liveStore.enabled ? "connected" : "local");

    if (!isBracketEntryPage) {
      const remoteState = await liveStore.load();
      if (isValidState(remoteState)) {
        state = remoteState;
        render();
      } else if (liveStore.enabled) {
        await liveStore.save(state);
      }
    }

    if (liveStore.enabled) {
      submissions = await liveStore.loadSubmissions();
      render();
    }

    if (!isBracketEntryPage) {
      liveStore.subscribe((incomingState) => {
        if (!isValidState(incomingState) || !isNewer(incomingState, state)) return;
        state = incomingState;
        render();
        setSyncStatus("Live update received", "connected");
      });
    }

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
  const players = buildPlayers();

  renderMatches();
  renderBracket(rounds);
  renderMetrics(summary, players);
  renderStats(summary, players);
  renderChampionSignals();
  renderScoreBreakdown();
  renderStandings(players);
  renderRaceStats(players);
  renderLockState();
  renderPlayerDetails();
  renderPersonalLookup();
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
  if (elements.resetButton) {
    elements.resetButton.disabled = false;
    elements.resetButton.textContent = state.locked ? "New Draft" : "Clear Draft";
  }
  elements.lockTitle.textContent = state.locked ? "Locked bracket" : "Draft bracket";
  elements.lockCopy.textContent = state.locked
    ? `Showing ${state.player?.name || "a saved bracket"}. Locked ${formatDateTime(state.lockedAt)}.`
    : "Add your name, pick winners, enter scores, then lock your bracket. Make sure to click and select the team you predict to win in each bracket.";
  elements.playerName?.toggleAttribute("disabled", state.locked);
}

function renderPlayerDetails() {
  if (elements.playerName && elements.playerName.value !== (state.player?.name || "")) {
    elements.playerName.value = state.player?.name || "";
  }

}

function renderPersonalLookup() {
  if (elements.playerLookup && elements.playerLookup.value !== personalLookup) {
    elements.playerLookup.value = personalLookup;
  }
}

function renderMetrics(summary, players) {
  const liveLeader = players.slice().sort((a, b) => b.livePoints - a.livePoints)[0];
  const projectedLeader = players.slice().sort((a, b) => b.projectedPoints - a.projectedPoints)[0];

  if (elements.championMetric) elements.championMetric.textContent = players.length;
  if (elements.championSource) elements.championSource.textContent = players.length === 1 ? "1 locked bracket" : `${players.length} locked brackets`;
  if (elements.pointsMetric) elements.pointsMetric.textContent = `${summary.completed}/16`;
  if (elements.pointsDetail) elements.pointsDetail.textContent = summary.completed ? `${summary.completed} matches with final scores` : "No final scores yet";
  if (elements.accuracyMetric) elements.accuracyMetric.textContent = liveLeader ? liveLeader.name : "-";
  if (elements.accuracyDetail) elements.accuracyDetail.textContent = liveLeader ? `${formatNumber(liveLeader.livePoints)} live points` : "No points yet";
  if (elements.exactMetric) elements.exactMetric.textContent = projectedLeader ? projectedLeader.name : "-";
  if (elements.exactDetail) elements.exactDetail.textContent = projectedLeader ? `${formatNumber(projectedLeader.projectedPoints)} projected points` : "Awaiting brackets";
  if (elements.completedPill) elements.completedPill.textContent = elements.lockButton ? (state.locked ? "Locked" : "Draft") : `${summary.completed}/16 final`;
}

function renderStats(summary, players) {
  if (!elements.qualityStats) return;

  const livePoints = players.map((player) => player.livePoints);
  const projectedPoints = players.map((player) => player.projectedPoints);
  const averageLive = livePoints.length ? livePoints.reduce((sum, value) => sum + value, 0) / livePoints.length : 0;
  const averageProjected = projectedPoints.length ? projectedPoints.reduce((sum, value) => sum + value, 0) / projectedPoints.length : 0;
  const spread = livePoints.length ? Math.max(...livePoints) - Math.min(...livePoints) : 0;
  const activeMatches = state.matches.filter((match) => match.actual.status === "live").length;

  elements.qualityStats.innerHTML = `
    <div class="stat-line"><span>Locked brackets</span><strong>${players.length}</strong></div>
    <div class="stat-line"><span>Final matches</span><strong>${summary.completed}</strong></div>
    <div class="stat-line"><span>Live matches</span><strong>${activeMatches}</strong></div>
    <div class="stat-line"><span>Average live points</span><strong>${formatNumber(averageLive)}</strong></div>
    <div class="stat-line"><span>Average projected points</span><strong>${formatNumber(averageProjected)}</strong></div>
    <div class="stat-line"><span>Live point spread</span><strong>${formatNumber(spread)}</strong></div>
  `;
}

function renderChampionSignals() {
  if (!elements.championSignals) return;

  const signals = getPopularChampions();
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

  const matchedSubmission = getPersonalSubmission();
  const matchedMatches = matchedSubmission ? getSubmittedMatches(matchedSubmission) : null;
  const rows = state.matches
    .filter((match) => match.actual.status === "final" || match.actual.status === "live")
    .map((match, index) => {
      const personalMatch = matchedMatches?.[index];
      const score = personalMatch ? scoreMatch(personalMatch) : null;
      const row = document.createElement("div");
      row.className = "breakdown-row";
      const resultText = getResultText(match);
      const personalText = score
        ? `Prediction ${formatPrediction(personalMatch)} | ${match.actual.status === "final" ? `${formatNumber(score.total)} pts` : "live"}`
        : "Enter a submitted name to compare predictions.";
      row.innerHTML = `
        <div>
          <strong>Match ${match.matchNumber}: ${formatTeam(match.home)} ${resultText} ${formatTeam(match.away)}</strong>
          <small>${personalText}</small>
        </div>
        <strong>${match.actual.status === "live" ? "Live" : "Final"}</strong>
      `;
      return row;
    });

  const intro = personalLookup && !matchedSubmission ? [emptyState(`No locked bracket found for "${personalLookup}".`)] : [];
  elements.scoreBreakdown.replaceChildren(...(rows.length ? [...intro, ...rows] : [emptyState("Results will appear here")]));
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

function renderRaceStats(players) {
  if (!elements.poolRaceStats) return;
  if (!players.length) {
    elements.poolRaceStats.replaceChildren(emptyState("No locked brackets yet."));
    return;
  }

  const sorted = players.slice().sort((a, b) => b.livePoints - a.livePoints || b.projectedPoints - a.projectedPoints);
  const leader = sorted[0];
  const chasers = sorted.slice(1, 4);
  const livePoints = players.map((player) => player.livePoints);
  const projectedPoints = players.map((player) => player.projectedPoints);
  const averageLive = livePoints.reduce((sum, value) => sum + value, 0) / livePoints.length;
  const averageProjected = projectedPoints.reduce((sum, value) => sum + value, 0) / projectedPoints.length;
  const spread = Math.max(...livePoints) - Math.min(...livePoints);

  const leaderCard = document.createElement("div");
  leaderCard.className = "race-card race-card--leader";
  leaderCard.innerHTML = `
    <span>Current leader</span>
    <strong>${leader.name}</strong>
    <small>${formatNumber(leader.livePoints)} live points · ${formatNumber(leader.projectedPoints)} projected</small>
  `;

  const miniGrid = document.createElement("div");
  miniGrid.className = "race-mini-grid";
  miniGrid.innerHTML = `
    <div class="race-card">
      <span>Average live</span>
      <strong>${formatNumber(averageLive)}</strong>
      <small>Across ${players.length} brackets</small>
    </div>
    <div class="race-card">
      <span>Point spread</span>
      <strong>${formatNumber(spread)}</strong>
      <small>Leader to last place</small>
    </div>
  `;

  const projectionCard = document.createElement("div");
  projectionCard.className = "race-card";
  projectionCard.innerHTML = `
    <span>Average projected</span>
    <strong>${formatNumber(averageProjected)}</strong>
    <small>If every remaining prediction lands</small>
  `;

  const chaserList = document.createElement("div");
  chaserList.className = "chaser-list";
  chaserList.append(
    ...chasers.map((player, index) => {
      const row = document.createElement("div");
      row.className = "chaser-row";
      row.innerHTML = `
        <span class="standing-rank">${index + 2}</span>
        <strong>${player.name}</strong>
        <span>${formatNumber(leader.livePoints - player.livePoints)} back</span>
      `;
      return row;
    }),
  );

  elements.poolRaceStats.replaceChildren(leaderCard, miniGrid, projectionCard, chaserList);
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
  const matches = getSubmittedMatches(submission);
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

function getSubmittedMatches(submission) {
  const submittedMatches = submission.state?.matches || [];

  return state.matches.map((liveMatch, index) => ({
    ...liveMatch,
    prediction: submittedMatches[index]?.prediction || liveMatch.prediction,
  }));
}

function getPersonalSubmission() {
  const query = personalLookup.trim().toLowerCase();
  if (!query) return null;

  return submissions.find((submission) => {
    const name = submission.player_name || submission.state?.player?.name || "";
    return name.toLowerCase() === query;
  });
}

function getPopularChampions() {
  const counts = new Map();

  submissions.forEach((submission) => {
    const submittedState = submission.state || {};
    const rounds = buildBracket(submittedState.matches || [], submittedState.bracketPicks || {}, submittedState.bracketScores || {});
    const champion = getProjectedChampion(rounds);
    if (!champion || champion === "TBD") return;
    counts.set(champion, (counts.get(champion) || 0) + 1);
  });

  return Array.from(counts, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 7);
}

function getResultText(match) {
  const home = match.actual.home ?? "-";
  const away = match.actual.away ?? "-";
  return `${home}-${away}`;
}

function formatPrediction(match) {
  const home = match.prediction.home ?? "-";
  const away = match.prediction.away ?? "-";
  const pick = match.prediction.pick ? formatTeam(match[match.prediction.pick]) : "no winner";
  return `${home}-${away}, ${pick}`;
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
    if (match) {
      match.prediction.pick = button.dataset.teamIndex === "0" ? "home" : "away";
      enforcePickedWinnerScore(match.prediction);
    }
  } else {
    state.bracketPicks[button.dataset.nodeId] = button.dataset.teamName;
    enforceAdvancedRoundScore(button.dataset.nodeId, button.dataset.teamIndex);
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
    enforcePickedWinnerScore(match.prediction);
  } else {
    const current = state.bracketScores[event.target.dataset.nodeId] || [null, null];
    current[index] = value;
    state.bracketScores[event.target.dataset.nodeId] = current;
    enforceAdvancedRoundScore(event.target.dataset.nodeId);
  }

  state.updatedAt = new Date().toISOString();
  render();
  queueRemoteSave();
  restoreBracketFocus(event.target.dataset.nodeId, event.target.dataset.round, index);
}

function enforcePickedWinnerScore(prediction) {
  if (!prediction?.pick) return;
  const pickedKey = prediction.pick;
  const otherKey = pickedKey === "home" ? "away" : "home";
  const pickedScore = prediction[pickedKey];
  const otherScore = prediction[otherKey];

  if (pickedScore === null || pickedScore === undefined || otherScore === null || otherScore === undefined) return;
  if (Number(pickedScore) < Number(otherScore)) {
    prediction[pickedKey] = otherScore;
  }
}

function enforceAdvancedRoundScore(nodeId, teamIndex) {
  const score = state.bracketScores[nodeId];
  if (!score) return;

  const pickedIndex = teamIndex !== undefined ? Number(teamIndex) : getPickedTeamIndex(nodeId);
  if (pickedIndex !== 0 && pickedIndex !== 1) return;

  const otherIndex = pickedIndex === 0 ? 1 : 0;
  if (score[pickedIndex] === null || score[pickedIndex] === undefined || score[otherIndex] === null || score[otherIndex] === undefined) return;
  if (Number(score[pickedIndex]) < Number(score[otherIndex])) {
    score[pickedIndex] = score[otherIndex];
  }
}

function getPickedTeamIndex(nodeId) {
  const rounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores);
  const node = rounds.flat().find((item) => item.id === nodeId);
  if (!node?.winner) return null;
  return node.teams.findIndex((team) => team.name === node.winner);
}

function enforceAllPickedWinnerScores() {
  state.matches.forEach((match) => enforcePickedWinnerScore(match.prediction));
  Object.keys(state.bracketScores).forEach((nodeId) => enforceAdvancedRoundScore(nodeId));
}

function handlePlayerInput(event) {
  if (state.locked) return;
  state.player ||= { name: "" };
  if (event.target === elements.playerName) state.player.name = event.target.value;
  state.updatedAt = new Date().toISOString();
  persist();
  queueRemoteSave();
}

function handleBracketLookup(event) {
  const query = event.target.value.trim().toLowerCase();
  if (!query) return;

  const submission = submissions.find((item) => {
    const name = item.player_name || item.state?.player?.name || "";
    return name.toLowerCase() === query;
  });

  if (!submission) {
    if (elements.lockCopy) elements.lockCopy.textContent = `No locked bracket found for "${event.target.value.trim()}".`;
    return;
  }

  state = structuredClone(submission.state);
  state.locked = true;
  state.lockedAt ||= submission.locked_at;
  state.updatedAt = new Date().toISOString();
  persist();
  render();
  setSyncStatus("Loaded saved bracket", "connected");
}

function handlePersonalLookup(event) {
  personalLookup = event.target.value;
  localStorage.setItem(PERSONAL_LOOKUP_KEY, personalLookup);
  renderScoreBreakdown();
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
  if (elements.bracketLookup) elements.bracketLookup.value = "";
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
  enforceAllPickedWinnerScores();
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
  if (!liveStore?.enabled || isBracketEntryPage) return;
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
