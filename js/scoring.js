export function getWinner(homeGoals, awayGoals, tieBreaker = "home") {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  if (homeGoals > awayGoals) return "home";
  if (awayGoals > homeGoals) return "away";
  return tieBreaker;
}

export function scoreMatch(match) {
  const predictedHome = numberOrNull(match.prediction.home);
  const predictedAway = numberOrNull(match.prediction.away);
  const actualHome = numberOrNull(match.actual.home);
  const actualAway = numberOrNull(match.actual.away);

  if (match.actual.status !== "final" || actualHome === null || actualAway === null) {
    return {
      total: 0,
      winner: false,
      goalDifference: false,
      exact: false,
      complete: false,
    };
  }

  const hasPredictedScore = predictedHome !== null && predictedAway !== null;
  const predictedWinner = match.prediction.pick || (hasPredictedScore ? getWinner(predictedHome, predictedAway, match.prediction.tieBreaker) : null);
  const actualWinner = match.actual.pick || getWinner(actualHome, actualAway, match.actual.tieBreaker);
  const winner = Boolean(predictedWinner && predictedWinner === actualWinner);
  const goalDifference = hasPredictedScore && predictedHome - predictedAway === actualHome - actualAway;
  const exact = hasPredictedScore && predictedHome === actualHome && predictedAway === actualAway;

  return {
    total: (winner ? 1 : 0) + (goalDifference ? 0.5 : 0) + (exact ? 1 : 0),
    winner,
    goalDifference,
    exact,
    complete: true,
  };
}

export function summarizeScores(matches) {
  const completed = matches.filter((match) => match.actual.status === "final");
  const scored = completed.map((match) => scoreMatch(match));
  const total = scored.reduce((sum, score) => sum + score.total, 0);
  const winnerHits = scored.filter((score) => score.winner).length;
  const exactHits = scored.filter((score) => score.exact).length;
  const goalDiffHits = scored.filter((score) => score.goalDifference).length;
  const maxPoints = completed.length * 2.5;
  return {
    completed: completed.length,
    total,
    maxPoints,
    winnerHits,
    exactHits,
    goalDiffHits,
    accuracy: completed.length ? winnerHits / completed.length : 0,
    exactRate: completed.length ? exactHits / completed.length : 0,
    goalDiffRate: completed.length ? goalDiffHits / completed.length : 0,
    upsetIndex: 0,
  };
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
