import { createInitialState } from "../js/data.js";
import { getWinner } from "../js/scoring.js";
import { SUPABASE_CONFIG } from "../js/config.js";

const MOCK_NAMES = [
  "Anik",
  "Rhea",
  "Kabir",
  "Maya",
  "Jonas",
  "Lea",
  "Sam",
  "Nina",
  "Arjun",
  "Tara",
  "Oskar",
  "Mina",
  "Dev",
  "Elena",
  "Noah",
  "Isha",
  "Luca",
  "Sara",
  "Vik",
  "Asha",
];

const MOCK_RESULTS = [
  [2, 0, "final"],
  [1, 1, "final", "home"],
  [1, 2, "final"],
  [3, 1, "final"],
  [0, 1, "final"],
  [2, 2, "final", "home"],
  [2, 1, "final"],
  [1, 0, "final"],
  [3, 2, "final"],
  [0, 2, "final"],
  [1, 1, "live", "away"],
  [2, 0, "live"],
  [0, 0, "live", "home"],
  [null, null, "scheduled"],
  [null, null, "scheduled"],
  [null, null, "scheduled"],
];

const API_BASE = `${SUPABASE_CONFIG.url}/rest/v1`;
const headers = {
  apikey: SUPABASE_CONFIG.anonKey,
  Authorization: `Bearer ${SUPABASE_CONFIG.anonKey}`,
  "Content-Type": "application/json",
};

const liveState = createInitialState();
liveState.player.name = "Mock admin";
liveState.matches = liveState.matches.map((match, index) => {
  const [home, away, status, tieBreaker] = MOCK_RESULTS[index];
  const pick = status === "scheduled" ? null : getWinner(home, away, tieBreaker);

  return {
    ...match,
    actual: {
      home,
      away,
      pick,
      status,
      tieBreaker,
    },
  };
});
liveState.updatedAt = new Date().toISOString();

const submissions = MOCK_NAMES.map((name, playerIndex) => {
  const state = createInitialState();
  state.player.name = `Mock ${name}`;
  state.locked = true;
  state.lockedAt = new Date(Date.now() - (MOCK_NAMES.length - playerIndex) * 60_000).toISOString();
  state.updatedAt = state.lockedAt;
  state.matches = state.matches.map((match, matchIndex) => ({
    ...match,
    prediction: makePrediction(matchIndex, playerIndex),
  }));
  state.bracketPicks = makeBracketPicks(playerIndex, state.matches);
  state.bracketScores = makeBracketScores(playerIndex);

  return {
    id: deterministicUuid(playerIndex + 1),
    player_name: state.player.name,
    state,
    locked_at: state.lockedAt,
    updated_at: state.updatedAt,
  };
});

await upsert("bracket_states", [
  {
    id: SUPABASE_CONFIG.stateId,
    state: liveState,
    updated_at: liveState.updatedAt,
  },
]);
await upsert("bracket_submissions", submissions);

console.log(`Seeded ${submissions.length} mock bracket submissions.`);
console.log(`Seeded ${liveState.matches.filter((match) => match.actual.status === "final").length} final and ${liveState.matches.filter((match) => match.actual.status === "live").length} live match results.`);

function makePrediction(matchIndex, playerIndex) {
  const [actualHome, actualAway, status, tieBreaker] = MOCK_RESULTS[matchIndex];
  const baseHome = actualHome ?? 1 + ((matchIndex + playerIndex) % 3);
  const baseAway = actualAway ?? (matchIndex + playerIndex) % 2;
  const drift = ((playerIndex + matchIndex) % 5) - 2;
  const home = Math.max(0, baseHome + (drift > 0 ? 1 : 0) - (playerIndex % 7 === 0 ? 1 : 0));
  const away = Math.max(0, baseAway + (drift < 0 ? 1 : 0) - (playerIndex % 6 === 0 ? 1 : 0));
  const upset = (playerIndex + matchIndex) % 6 === 0;
  const actualPick = status === "scheduled" ? getWinner(baseHome, baseAway, tieBreaker) : getWinner(actualHome, actualAway, tieBreaker);
  const pick = upset ? flipPick(actualPick) : getWinner(home, away, tieBreaker) || actualPick;

  return {
    home,
    away,
    pick,
  };
}

function makeBracketPicks(playerIndex, matches) {
  const firstRoundWinners = matches.map((match) => match[match.prediction.pick] || match.home);
  const round16 = pairWinners(firstRoundWinners, playerIndex);
  const quarters = pairWinners(round16, playerIndex + 1);
  const semis = pairWinners(quarters, playerIndex + 2);
  const final = pairWinners(semis, playerIndex + 3);

  return {
    "1-0": round16[0],
    "1-1": round16[1],
    "1-2": round16[2],
    "1-3": round16[3],
    "1-4": round16[4],
    "1-5": round16[5],
    "1-6": round16[6],
    "1-7": round16[7],
    "2-0": quarters[0],
    "2-1": quarters[1],
    "2-2": quarters[2],
    "2-3": quarters[3],
    "3-0": semis[0],
    "3-1": semis[1],
    "4-0": final[0],
  };
}

function makeBracketScores(playerIndex) {
  return Object.fromEntries(
    Array.from({ length: 15 }, (_, index) => {
      const round = index < 8 ? 1 : index < 12 ? 2 : index < 14 ? 3 : 4;
      const roundIndex = round === 1 ? index : round === 2 ? index - 8 : round === 3 ? index - 12 : 0;
      return [`${round}-${roundIndex}`, [1 + ((playerIndex + index) % 3), (playerIndex + index) % 2]];
    }),
  );
}

function pairWinners(teams, seed) {
  const winners = [];
  for (let index = 0; index < teams.length; index += 2) {
    winners.push((seed + index) % 3 === 0 ? teams[index + 1] : teams[index]);
  }
  return winners;
}

function flipPick(pick) {
  return pick === "home" ? "away" : "home";
}

function deterministicUuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

async function upsert(table, rows) {
  const response = await fetch(`${API_BASE}/${table}?on_conflict=id`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(`${table} upsert failed: ${response.status} ${await response.text()}`);
  }
}
