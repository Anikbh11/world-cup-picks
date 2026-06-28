import { ROUND_NAMES } from "./data.js?v=20";
import { getWinner, numberOrNull } from "./scoring.js?v=20";

const ROUND_SIZES = [16, 8, 4, 2, 1];

export function buildBracket(matches, bracketPicks = {}, bracketScores = {}) {
  const rounds = ROUND_SIZES.map((size, round) =>
    Array.from({ length: size }, (_, index) => ({
      id: `${round}-${index}`,
      round,
      roundName: ROUND_NAMES[round],
      label: round === 0 ? `M${index + 1}` : `${ROUND_NAMES[round]} ${index + 1}`,
      status: "predicted",
      teams: [{ name: "TBD" }, { name: "TBD" }],
      winner: null,
      score: [null, null],
    })),
  );

  rounds[0] = matches.map((match, index) => {
    const preferred = match.actual.status === "final" || match.actual.status === "live" ? match.actual : match.prediction;
    const winnerSide = resolveWinner(match);
    const winnerName = winnerSide ? match[winnerSide] : null;

    return {
      id: match.id,
      round: 0,
      roundName: ROUND_NAMES[0],
      label: `M${match.matchNumber}`,
      status: match.actual.status === "final" ? "final" : match.actual.status === "live" ? "live" : "predicted",
      teams: [{ name: match.home }, { name: match.away }],
      winner: winnerName,
      winnerSide,
      score: [numberOrNull(preferred.home), numberOrNull(preferred.away)],
    };
  });

  for (let round = 1; round < rounds.length; round += 1) {
    rounds[round] = rounds[round].map((node, index) => {
      const first = rounds[round - 1][index * 2];
      const second = rounds[round - 1][index * 2 + 1];
      const teams = [{ name: first?.winner || "TBD" }, { name: second?.winner || "TBD" }];
      const pick = bracketPicks[node.id];
      const pickStillValid = teams.some((team) => team.name === pick && team.name !== "TBD");
      const winner = pickStillValid ? pick : null;

      return {
        ...node,
        status: first?.status === "final" && second?.status === "final" ? "final" : "predicted",
        teams,
        winner,
        winnerSide: winner ? (winner === teams[0].name ? "home" : "away") : null,
        score: bracketScores[node.id] || [null, null],
      };
    });
  }

  return rounds;
}

export function getProjectedChampion(rounds) {
  const finalNode = rounds.at(-1)?.[0];
  return finalNode?.winner || null;
}

export function getChampionSignals(matches) {
  const signals = new Map();
  matches.forEach((match) => {
    const winnerSide = resolveWinner(match);
    if (!winnerSide) return;
    const name = match[winnerSide];
    signals.set(name, (signals.get(name) || 0) + 1);
  });

  return Array.from(signals, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 7);
}

function resolveWinner(match) {
  const actualHome = numberOrNull(match.actual.home);
  const actualAway = numberOrNull(match.actual.away);
  const predictionHome = numberOrNull(match.prediction.home);
  const predictionAway = numberOrNull(match.prediction.away);

  if ((match.actual.status === "final" || match.actual.status === "live") && actualHome !== null && actualAway !== null) {
    if (match.actual.pick) {
      return match.actual.pick;
    }

    return getWinner(actualHome, actualAway, match.actual.tieBreaker);
  }

  if (match.prediction.pick) {
    return match.prediction.pick;
  }

  if (predictionHome !== null && predictionAway !== null) {
    return getWinner(predictionHome, predictionAway, match.prediction.tieBreaker);
  }

  return null;
}
