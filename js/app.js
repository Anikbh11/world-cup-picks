import { createInitialState, ROUND_NAMES, STATE_VERSION } from "./data.js?v=37";
import { buildBracket, getProjectedChampion } from "./bracket.js?v=37";
import { getWinner, numberOrNull, scoreMatch, summarizeScores } from "./scoring.js?v=37";
import { createLiveStore } from "./supabaseStore.js?v=37";
import { formatTeam, getFlag } from "./flags.js?v=37";

const STORAGE_KEY = "world-cup-r32-bracket-state";
const PERSONAL_LOOKUP_KEY = "world-cup-r32-personal-lookup";
const SUBMISSIONS_OPEN = false;
const ESPN_SCOREBOARD_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const SCOREBOARD_DATES = [
  "20260628",
  "20260629",
  "20260630",
  "20260701",
  "20260702",
  "20260703",
  "20260704",
  "20260705",
  "20260706",
  "20260707",
  "20260708",
  "20260709",
  "20260710",
  "20260711",
  "20260712",
  "20260713",
  "20260714",
];
const SCORE_REFRESH_INTERVAL = 60 * 1000;
const ESPN_FINAL_STATES = new Set(["post"]);
const ESPN_LIVE_STATES = new Set(["in"]);
const TEAM_ALIASES = new Map([
  ["united states", "usa"],
  ["united states of america", "usa"],
  ["u.s.a.", "usa"],
  ["ivory coast", "cote divoire"],
  ["cote d ivoire", "cote divoire"],
  ["cote d'ivoire", "cote divoire"],
  ["côte d’ivoire", "cote divoire"],
  ["côte d'ivoire", "cote divoire"],
  ["cabo verde", "cape verde"],
  ["bosnia-herzegovina", "bosnia and herzegovina"],
  ["bosnia herzegovina", "bosnia and herzegovina"],
  ["congo dr", "dr congo"],
  ["congo, dr", "dr congo"],
  ["d r congo", "dr congo"],
]);
let state = loadState();
let liveStore = null;
let remoteSaveTimer = null;
let scoreRefreshTimer = null;
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
      loadBracketFromQuery();
      render();
    }

    if (!isBracketEntryPage) {
      await refreshScoresFromEspn();
      scheduleScoreRefresh();

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

function scheduleScoreRefresh() {
  clearInterval(scoreRefreshTimer);
  scoreRefreshTimer = setInterval(refreshScoresFromEspn, SCORE_REFRESH_INTERVAL);
}

async function refreshScoresFromEspn() {
  if (!liveStore?.enabled || isBracketEntryPage) return;

  try {
    setSyncStatus("Checking scores...", "syncing");
    const events = await fetchEspnEvents();
    const changed = applyEspnEvents(events);
    if (changed) {
      state.updatedAt = new Date().toISOString();
      render();
      await liveStore.save(state);
      setSyncStatus("Scores updated", "connected");
      return;
    }

    setSyncStatus("Scores current", "connected");
  } catch (error) {
    console.error(error);
    setSyncStatus("Score check failed", "warning");
  }
}

async function fetchEspnEvents() {
  const responses = await Promise.all(
    SCOREBOARD_DATES.map(async (date) => {
      const response = await fetch(`${ESPN_SCOREBOARD_BASE}?dates=${date}`);
      if (!response.ok) throw new Error(`ESPN scoreboard failed for ${date}`);
      return response.json();
    }),
  );

  const seen = new Set();
  return responses.flatMap((payload) => payload.events || []).filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

function applyEspnEvents(events) {
  let changed = false;

  state.matches.forEach((match) => {
    const candidate = findEspnEventForMatch(match, events);
    if (!candidate) return;

    const actual = normalizeEspnEvent(candidate.event, candidate.flip);
    if (!actual || actual.status === "scheduled" || !hasActualChanged(match.actual, actual)) return;

    match.actual = {
      ...match.actual,
      ...actual,
      sourceProvider: "espn-browser",
      sourceUpdatedAt: new Date().toISOString(),
    };
    changed = true;
  });

  for (let pass = 0; pass < 4; pass += 1) {
    const passChanged = applyBracketEspnEvents(events);
    changed = changed || passChanged;
    if (!passChanged) break;
  }

  return changed;
}

function applyBracketEspnEvents(events) {
  let changed = false;
  const rounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores, state.bracketActuals);

  rounds.slice(1).flat().forEach((node) => {
    if (node.teams.some((team) => team.name === "TBD")) return;

    const candidate = findEspnEventForTeams(node.teams[0].name, node.teams[1].name, events);
    if (!candidate) return;

    const actual = normalizeEspnEvent(candidate.event, candidate.flip);
    if (!actual || actual.status === "scheduled") return;

    const winner = actual.pick === "home" ? node.teams[0].name : actual.pick === "away" ? node.teams[1].name : null;
    const nextActual = {
      home: actual.home,
      away: actual.away,
      winner,
      status: actual.status,
      sourceStatus: actual.sourceStatus,
      sourceProvider: "espn-browser",
      sourceUpdatedAt: new Date().toISOString(),
    };
    const currentActual = state.bracketActuals?.[node.id];

    if ((nextActual.status === "final" && !winner) || !hasBracketActualChanged(currentActual, nextActual)) return;

    state.bracketActuals = {
      ...(state.bracketActuals || {}),
      [node.id]: nextActual,
    };
    changed = true;
  });

  return changed;
}

function findEspnEventForMatch(match, events) {
  return findEspnEventForTeams(match.home, match.away, events);
}

function findEspnEventForTeams(homeName, awayName, events) {
  const home = normalizeTeamName(homeName);
  const away = normalizeTeamName(awayName);

  return events.reduce((best, event) => {
    if (best) return best;

    const competition = event.competitions?.[0];
    const competitors = competition?.competitors || [];
    const apiHome = normalizeTeamName(competitors.find((item) => item.homeAway === "home")?.team?.displayName);
    const apiAway = normalizeTeamName(competitors.find((item) => item.homeAway === "away")?.team?.displayName);

    if (home === apiHome && away === apiAway) return { event, flip: false };
    if (home === apiAway && away === apiHome) return { event, flip: true };
    return null;
  }, null);
}

function normalizeEspnEvent(event, flip = false) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const homeTeam = competitors.find((item) => item.homeAway === "home");
  const awayTeam = competitors.find((item) => item.homeAway === "away");
  const apiHome = numberOrNull(homeTeam?.score);
  const apiAway = numberOrNull(awayTeam?.score);
  const stateName = competition?.status?.type?.state || event.status?.type?.state;
  const status = ESPN_FINAL_STATES.has(stateName) ? "final" : ESPN_LIVE_STATES.has(stateName) ? "live" : "scheduled";
  if (status === "scheduled" || apiHome === null || apiAway === null) return { home: null, away: null, pick: null, status };

  const home = flip ? apiAway : apiHome;
  const away = flip ? apiHome : apiAway;
  const winnerId = competition?.winner;
  const winner = competitors.find((item) => item.id === winnerId || item.winner);
  const winnerSide = winner?.homeAway || (home > away ? "home" : away > home ? "away" : null);
  const pick = winnerSide ? (flip ? (winnerSide === "home" ? "away" : "home") : winnerSide) : null;

  return {
    home,
    away,
    pick,
    tieBreaker: pick,
    status,
    sourceStatus: competition?.status?.type?.shortDetail || event.status?.type?.shortDetail || stateName || status,
  };
}

function hasActualChanged(current, next) {
  return (
    current?.home !== next.home ||
    current?.away !== next.away ||
    current?.pick !== next.pick ||
    current?.tieBreaker !== next.tieBreaker ||
    current?.status !== next.status ||
    current?.sourceStatus !== next.sourceStatus
  );
}

function hasBracketActualChanged(current, next) {
  return (
    current?.home !== next.home ||
    current?.away !== next.away ||
    current?.winner !== next.winner ||
    current?.status !== next.status ||
    current?.sourceStatus !== next.sourceStatus
  );
}

function render() {
  const rounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores, state.bracketActuals);
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
    button.disabled = state.locked || !SUBMISSIONS_OPEN;
    button.textContent = state.locked ? "Bracket Locked" : SUBMISSIONS_OPEN ? "Lock My Bracket" : "Submissions Closed";
  });
  if (elements.resetButton) {
    elements.resetButton.disabled = false;
    elements.resetButton.textContent = state.locked ? "New Draft" : "Clear Draft";
  }
  elements.lockTitle.textContent = state.locked ? "Locked bracket" : "Draft bracket";
  elements.lockCopy.textContent = state.locked
    ? `Showing ${state.player?.name || "a saved bracket"}. Locked ${formatDateTime(state.lockedAt)}.`
    : SUBMISSIONS_OPEN
      ? "Add your name, pick winners, enter scores, then lock your bracket. Make sure to click and select the team you predict to win in each bracket."
      : "New bracket submissions are closed. You can still view locked brackets by entering a submitted name.";
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
  const bracketCompleted = getCompletedBracketActuals().length;
  const tournamentPhase = getTournamentPhase(summary.completed, bracketCompleted);

  if (elements.championMetric) elements.championMetric.textContent = players.length;
  if (elements.championSource) elements.championSource.textContent = players.length === 1 ? "1 locked bracket" : `${players.length} locked brackets`;
  if (elements.pointsMetric) elements.pointsMetric.textContent = tournamentPhase;
  if (elements.pointsDetail) {
    elements.pointsDetail.textContent =
      summary.completed === 16
        ? bracketCompleted
          ? `Round of 32 complete. ${bracketCompleted} knockout match${bracketCompleted === 1 ? "" : "es"} scored.`
          : "Round of 32 complete. Quarterfinals are underway."
        : summary.completed
          ? `${summary.completed} matches with final scores`
          : "No final scores yet";
  }
  if (elements.accuracyMetric) elements.accuracyMetric.textContent = liveLeader ? liveLeader.name : "-";
  if (elements.accuracyDetail) elements.accuracyDetail.textContent = liveLeader ? `${formatNumber(liveLeader.livePoints)} live points` : "No points yet";
  if (elements.exactMetric) elements.exactMetric.textContent = projectedLeader ? projectedLeader.name : "-";
  if (elements.exactDetail) elements.exactDetail.textContent = projectedLeader ? `${formatNumber(projectedLeader.projectedPoints)} predicted points` : "Awaiting brackets";
  if (elements.completedPill) elements.completedPill.textContent = elements.lockButton ? (state.locked ? "Locked" : "Draft") : `${summary.completed}/16 final`;
}

function getTournamentPhase(roundOf32Completed, knockoutCompleted) {
  if (knockoutCompleted >= 14) return "Final";
  if (knockoutCompleted >= 12) return "Semifinals";
  if (knockoutCompleted >= 8) return "Quarterfinals";
  if (roundOf32Completed === 16) return "Quarterfinals";
  return `${roundOf32Completed}/16`;
}

function renderStats(summary, players) {
  if (!elements.qualityStats) return;

  const livePoints = players.map((player) => player.livePoints);
  const projectedPoints = players.map((player) => player.projectedPoints);
  const averageLive = livePoints.length ? livePoints.reduce((sum, value) => sum + value, 0) / livePoints.length : 0;
  const averageProjected = projectedPoints.length ? projectedPoints.reduce((sum, value) => sum + value, 0) / projectedPoints.length : 0;
  const spread = livePoints.length ? Math.max(...livePoints) - Math.min(...livePoints) : 0;
  const activeMatches = state.matches.filter((match) => match.actual.status === "live").length + getLiveBracketActuals().length;

  elements.qualityStats.innerHTML = `
    <div class="stat-line"><span>Locked brackets</span><strong>${players.length}</strong></div>
    <div class="stat-line"><span>Final matches</span><strong>${summary.completed}</strong></div>
    <div class="stat-line"><span>Live matches</span><strong>${activeMatches}</strong></div>
    <div class="stat-line"><span>Average live points</span><strong>${formatNumber(averageLive)}</strong></div>
    <div class="stat-line"><span>Average predicted points</span><strong>${formatNumber(averageProjected)}</strong></div>
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
  const submittedRounds = matchedSubmission
    ? buildBracket(matchedSubmission.state?.matches || [], matchedSubmission.state?.bracketPicks || {}, matchedSubmission.state?.bracketScores || {})
    : null;
  const actualRounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores, state.bracketActuals);
  const rows = state.matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => match.actual.status === "final" || match.actual.status === "live")
    .map(({ match, index }) => {
      const personalMatch = matchedMatches?.[index];
      const score = personalMatch ? scoreMatch(personalMatch) : null;
      const row = document.createElement("div");
      row.className = `breakdown-row ${match.actual.status === "live" ? "is-live" : "is-final"}`;
      const resultText = getResultText(match);
      const statusText = getResultStatusText(match);
      const personalText = score
        ? `Prediction ${formatPrediction(personalMatch)} | ${match.actual.status === "final" ? `${formatNumber(score.total)} pts` : "points after final whistle"}`
        : "Enter a submitted name to compare predictions.";
      row.innerHTML = `
        <div>
          <strong>Match ${match.matchNumber}: ${formatTeam(match.home)} ${resultText} ${formatTeam(match.away)}</strong>
          <small>${personalText}</small>
        </div>
        <strong class="result-pill">${statusText}</strong>
      `;
      return row;
    });
  const bracketRows = actualRounds
    .slice(1)
    .flat()
    .filter((node) => node.status === "final" || node.status === "live")
    .map((node) => {
      const personalNode = submittedRounds?.[node.round]?.find((item) => item.id === node.id);
      const score = personalNode ? scoreBracketNode(personalNode, node) : null;
      const row = document.createElement("div");
      row.className = `breakdown-row ${node.status === "live" ? "is-live" : "is-final"}`;
      const personalText = score
        ? `Prediction ${formatBracketPrediction(personalNode)} | ${node.status === "final" ? `${formatNumber(score.total)} pts` : "points after final whistle"}`
        : "Enter a submitted name to compare predictions.";
      row.innerHTML = `
        <div>
          <strong>${node.roundName}: ${formatTeam(node.teams[0].name)} ${formatBracketScore(node)} ${formatTeam(node.teams[1].name)}</strong>
          <small>${personalText}</small>
        </div>
        <strong class="result-pill">${node.status === "live" ? `Live · ${formatBracketScore(node)}` : `Final · ${formatBracketScore(node)}`}</strong>
      `;
      return row;
    });

  const intro = personalLookup && !matchedSubmission ? [emptyState(`No locked bracket found for "${personalLookup}".`)] : [];
  const allRows = [...rows, ...bracketRows];
  elements.scoreBreakdown.replaceChildren(...(allRows.length ? [...intro, ...allRows] : [emptyState("Results will appear here")]));
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
    .map((player, index, sortedPlayers) => {
      const row = document.createElement("div");
      const rank = document.createElement("span");
      const nameLink = document.createElement("a");
      const livePoints = document.createElement("span");
      const predictedPoints = document.createElement("span");

      row.className = "standing-row";
      rank.className = "standing-rank";
      rank.textContent = getSharedRank(sortedPlayers, index, "livePoints");
      nameLink.className = "standing-player-link";
      nameLink.href = `./bracket.html?view=${encodeURIComponent(player.name)}`;
      nameLink.textContent = player.name;
      livePoints.textContent = `${formatNumber(player.livePoints)} live`;
      predictedPoints.textContent = `${formatNumber(player.projectedPoints)} predicted`;
      row.append(rank, nameLink, livePoints, predictedPoints);
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
    <small>${formatNumber(leader.livePoints)} live points · ${formatNumber(leader.projectedPoints)} predicted</small>
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
    <span>Average predicted</span>
    <strong>${formatNumber(averageProjected)}</strong>
    <small>If every remaining prediction lands</small>
  `;

  const chaserList = document.createElement("div");
  chaserList.className = "chaser-list";
  chaserList.append(
    ...chasers.map((player, index) => {
      const playerIndex = index + 1;
      const row = document.createElement("div");
      row.className = "chaser-row";
      row.innerHTML = `
        <span class="standing-rank">${getSharedRank(sorted, playerIndex, "livePoints")}</span>
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
      <span class="standing-rank">${getSharedRank(sorted, index, key)}</span>
      <strong>${player.name}</strong>
      <div class="points-track"><span style="width: ${(player[key] / max) * 100}%"></span></div>
      <b>${formatNumber(player[key])}</b>
    `;
    return row;
  });

  container.replaceChildren(...rows);
}

function getSharedRank(sortedPlayers, index, key) {
  const value = sortedPlayers[index]?.[key];
  const firstIndex = sortedPlayers.findIndex((player) => player[key] === value);
  return firstIndex + 1;
}

function buildPlayers() {
  const predictionModel = buildPredictionModel(submissions);
  return submissions.map((submission) => buildSubmittedPlayer(submission, predictionModel));
}

function buildSubmittedPlayer(submission, predictionModel) {
  const submittedState = submission.state;
  const matches = getSubmittedMatches(submission);
  const submittedRounds = buildBracket(submittedState.matches || [], submittedState.bracketPicks || {}, submittedState.bracketScores || {});
  const actualRounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores, state.bracketActuals);
  const bracketScores = scoreBracketRounds(submittedRounds, actualRounds);
  const livePoints = summarizeScores(matches).total + bracketScores.total;
  const predictedPoints = matches.reduce((total, match, index) => {
    if (match.actual.status === "final") return total + scoreMatch(match).total;
    return total + getExpectedPredictionPoints(match.prediction, predictionModel[index]);
  }, bracketScores.total);
  const name = normalizeName(submission.player_name || submittedState.player?.name) || "Anonymous";

  return {
    id: submission.id,
    name,
    shortName: name.slice(0, 8),
    livePoints,
    projectedPoints: predictedPoints,
  };
}

function scoreBracketRounds(predictedRounds, actualRounds) {
  const completed = actualRounds
    .slice(1)
    .flat()
    .filter((node) => node.status === "final" && node.winner);
  const scored = completed.map((actualNode) => {
    const predictedNode = predictedRounds[actualNode.round]?.find((node) => node.id === actualNode.id);
    return scoreBracketNode(predictedNode, actualNode);
  });

  return {
    total: scored.reduce((sum, score) => sum + score.total, 0),
    completed: completed.length,
  };
}

function scoreBracketNode(predictedNode, actualNode) {
  if (!predictedNode || actualNode.status !== "final" || !actualNode.winner) return { total: 0 };

  const predictedWinner = predictedNode.winner || getWinner(numberOrNull(predictedNode.score[0]), numberOrNull(predictedNode.score[1]), predictedNode.winnerSide);
  const winner = predictedWinner === actualNode.winner;
  const alignedScores = getAlignedBracketScores(predictedNode, actualNode);
  const goalDifference = Boolean(alignedScores && alignedScores.predictedHome - alignedScores.predictedAway === alignedScores.actualHome - alignedScores.actualAway);
  const exact = Boolean(alignedScores?.teamsMatch && alignedScores.predictedHome === alignedScores.actualHome && alignedScores.predictedAway === alignedScores.actualAway);

  return {
    total: (winner ? 1 : 0) + (goalDifference ? 0.5 : 0) + (exact ? 1 : 0),
    winner,
    goalDifference,
    exact,
  };
}

function getAlignedBracketScores(predictedNode, actualNode) {
  const predictedHome = numberOrNull(predictedNode.score[0]);
  const predictedAway = numberOrNull(predictedNode.score[1]);
  const actualHome = numberOrNull(actualNode.score[0]);
  const actualAway = numberOrNull(actualNode.score[1]);

  if (predictedHome === null || predictedAway === null || actualHome === null || actualAway === null) return null;

  const predictedTeams = predictedNode.teams.map((team) => team.name);
  const actualTeams = actualNode.teams.map((team) => team.name);

  if (predictedTeams[0] === actualTeams[0] && predictedTeams[1] === actualTeams[1]) {
    return { predictedHome, predictedAway, actualHome, actualAway, teamsMatch: true };
  }

  if (predictedTeams[0] === actualTeams[1] && predictedTeams[1] === actualTeams[0]) {
    return { predictedHome, predictedAway, actualHome: actualAway, actualAway: actualHome, teamsMatch: true };
  }

  if (predictedNode.winner && predictedNode.winner === actualNode.winner) {
    const predictedWinnerIndex = predictedTeams.findIndex((team) => team === predictedNode.winner);
    const actualWinnerIndex = actualTeams.findIndex((team) => team === actualNode.winner);
    if (predictedWinnerIndex === -1 || actualWinnerIndex === -1) return null;

    const predictedWinnerGoals = predictedWinnerIndex === 0 ? predictedHome : predictedAway;
    const predictedOtherGoals = predictedWinnerIndex === 0 ? predictedAway : predictedHome;
    const actualWinnerGoals = actualWinnerIndex === 0 ? actualHome : actualAway;
    const actualOtherGoals = actualWinnerIndex === 0 ? actualAway : actualHome;

    return {
      predictedHome: predictedWinnerGoals,
      predictedAway: predictedOtherGoals,
      actualHome: actualWinnerGoals,
      actualAway: actualOtherGoals,
      teamsMatch: false,
    };
  }

  return null;
}

function buildPredictionModel(allSubmissions) {
  return state.matches.map((match, index) => {
    const model = {
      total: 0,
      winners: new Map(),
      goalDifferences: new Map(),
      scores: new Map(),
    };

    if (match.actual.status === "final") return model;

    allSubmissions.forEach((submission) => {
      const prediction = submission.state?.matches?.[index]?.prediction;
      const keys = getPredictionKeys(prediction);
      if (!keys) return;

      model.total += 1;
      addCount(model.winners, keys.winner);
      addCount(model.goalDifferences, keys.goalDifference);
      addCount(model.scores, keys.score);
    });

    return model;
  });
}

function getExpectedPredictionPoints(prediction, model) {
  const keys = getPredictionKeys(prediction);
  if (!keys || !model?.total) return 0;

  return (
    (model.winners.get(keys.winner) || 0) / model.total +
    ((model.goalDifferences.get(keys.goalDifference) || 0) / model.total) * 0.5 +
    (model.scores.get(keys.score) || 0) / model.total
  );
}

function getPredictionKeys(prediction) {
  if (!prediction) return null;

  const home = prediction.home === null || prediction.home === undefined || prediction.home === "" ? null : Number(prediction.home);
  const away = prediction.away === null || prediction.away === undefined || prediction.away === "" ? null : Number(prediction.away);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;

  const winner = prediction.pick || getPredictedWinnerFromScore(prediction) || prediction.tieBreaker;
  if (!winner) return null;

  return {
    winner,
    goalDifference: String(home - away),
    score: `${home}-${away}`,
  };
}

function addCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function getSubmittedMatches(submission) {
  const submittedMatches = submission.state?.matches || [];

  return state.matches.map((liveMatch, index) => ({
    ...liveMatch,
    prediction: submittedMatches[index]?.prediction || liveMatch.prediction,
  }));
}

function getPersonalSubmission() {
  const query = normalizeName(personalLookup).toLowerCase();
  if (!query) return null;

  return submissions.find((submission) => {
    const name = normalizeName(submission.player_name || submission.state?.player?.name).toLowerCase();
    return name === query;
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

function getResultStatusText(match) {
  const score = getResultText(match);
  if (match.actual.status === "live") return `Live · ${score}`;
  if (match.actual.status === "final") return `Final · ${score}`;
  return "Scheduled";
}

function getCompletedBracketActuals() {
  return Object.values(state.bracketActuals || {}).filter((actual) => actual.status === "final");
}

function getLiveBracketActuals() {
  return Object.values(state.bracketActuals || {}).filter((actual) => actual.status === "live");
}

function formatBracketScore(node) {
  const home = node.score[0] ?? "-";
  const away = node.score[1] ?? "-";
  return `${home}-${away}`;
}

function formatBracketPrediction(node) {
  if (!node) return "-";

  const home = node.score[0] ?? "-";
  const away = node.score[1] ?? "-";
  const pick = node.winner ? formatTeam(node.winner) : "no winner";
  return `${formatTeam(node.teams[0].name)} ${home}-${away} ${formatTeam(node.teams[1].name)}, ${pick}`;
}

function formatPrediction(match) {
  const home = match.prediction.home ?? "-";
  const away = match.prediction.away ?? "-";
  const pickedSide = match.prediction.pick || getPredictedWinnerFromScore(match.prediction);
  const pick = pickedSide ? formatTeam(match[pickedSide]) : "draw";
  return `${formatTeam(match.home)} ${home}-${away} ${formatTeam(match.away)}, ${pick}`;
}

function getPredictedWinnerFromScore(prediction) {
  const home = prediction.home === null || prediction.home === undefined || prediction.home === "" ? null : Number(prediction.home);
  const away = prediction.away === null || prediction.away === undefined || prediction.away === "" ? null : Number(prediction.away);
  if (!Number.isFinite(home) || !Number.isFinite(away) || home === away) return null;
  return home > away ? "home" : "away";
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
    selectAdvancedRoundWinnerFromScore(event.target.dataset.nodeId);
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

function selectAdvancedRoundWinnerFromScore(nodeId) {
  const score = state.bracketScores[nodeId];
  if (!score) return;

  const first = Number(score[0]);
  const second = Number(score[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second) || first === second) return;

  const rounds = buildBracket(state.matches, state.bracketPicks, state.bracketScores);
  const node = rounds.flat().find((item) => item.id === nodeId);
  const winnerIndex = first > second ? 0 : 1;
  const winner = node?.teams?.[winnerIndex]?.name;

  if (winner && winner !== "TBD") {
    state.bracketPicks[nodeId] = winner;
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
  loadBracketByName(event.target.value);
}

function loadBracketFromQuery() {
  if (!elements.bracketLookup) return;

  const params = new URLSearchParams(window.location.search);
  const requestedName = params.get("view");
  if (!requestedName) return;

  elements.bracketLookup.value = requestedName;
  loadBracketByName(requestedName);
}

function loadBracketByName(rawName) {
  const query = normalizeName(rawName).toLowerCase();
  if (!query) return;

  const submission = submissions.find((item) => {
    const name = normalizeName(item.player_name || item.state?.player?.name).toLowerCase();
    return name === query;
  });

  if (!submission) {
    if (elements.lockCopy) elements.lockCopy.textContent = `No locked bracket found for "${String(rawName || "").trim()}".`;
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

async function lockBracket() {
  if (state.locked) return;
  if (!SUBMISSIONS_OPEN) {
    if (elements.lockCopy) elements.lockCopy.textContent = "New bracket submissions are closed.";
    return;
  }
  if (elements.playerName && !state.player?.name?.trim()) {
    elements.playerName.focus();
    elements.lockCopy.textContent = "Add your name before locking your bracket.";
    return;
  }
  enforceAllPickedWinnerScores();
  state.player ||= { name: "" };
  state.player.name = normalizeName(state.player.name);
  if (elements.playerName) elements.playerName.value = state.player.name;
  state.submissionId = crypto.randomUUID();
  state.locked = true;
  state.lockedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();

  if (liveStore?.enabled) {
    setSyncStatus("Saving submission...", "syncing");
    const saved = await saveSubmission();
    if (!saved) {
      state.locked = false;
      state.lockedAt = null;
      state.updatedAt = new Date().toISOString();
      render();
      if (elements.lockCopy) {
        elements.lockCopy.textContent = "Could not save your bracket. Check the connection and try locking again.";
      }
      return;
    }
  }

  render();
  queueRemoteSave({ immediate: true });
}

async function saveSubmission() {
  if (!liveStore?.enabled) return true;

  try {
    await liveStore.saveSubmission(state);
    submissions = await liveStore.loadSubmissions();
    setSyncStatus("Submission saved", "connected");
    return true;
  } catch (error) {
    console.error(error);
    setSyncStatus("Save failed", "warning");
    return false;
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

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}

function normalizeTeamName(name) {
  const normalized = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  return TEAM_ALIASES.get(normalized) || normalized;
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
