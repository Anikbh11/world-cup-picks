export const ROUND_NAMES = ["Round of 32", "Round of 16", "Quarterfinals", "Semifinals", "Final"];
export const STATE_VERSION = 8;

export const seedMatches = [
  {
    matchNumber: 74,
    home: "Germany",
    away: "TBD 3rd A/B/C/D/F",
  },
  {
    matchNumber: 77,
    home: "France",
    away: "TBD 3rd C/D/F/G/H",
  },
  {
    matchNumber: 73,
    home: "South Africa",
    away: "Canada",
  },
  {
    matchNumber: 75,
    home: "Netherlands",
    away: "Morocco",
  },
  {
    matchNumber: 83,
    home: "Runner-up Group K",
    away: "Runner-up Group L",
  },
  {
    matchNumber: 84,
    home: "Spain",
    away: "Runner-up Group J",
  },
  {
    matchNumber: 81,
    home: "United States",
    away: "Bosnia and Herzegovina",
  },
  {
    matchNumber: 82,
    home: "Belgium",
    away: "TBD 3rd A/E/H/I/J",
  },
  {
    matchNumber: 76,
    home: "Brazil",
    away: "Japan",
  },
  {
    matchNumber: 78,
    home: "Ivory Coast",
    away: "Norway",
  },
  {
    matchNumber: 79,
    home: "Mexico",
    away: "TBD 3rd C/E/F/H/I",
  },
  {
    matchNumber: 80,
    home: "Winner Group L",
    away: "TBD 3rd E/H/I/J/K",
  },
  {
    matchNumber: 86,
    home: "Argentina",
    away: "Cabo Verde",
  },
  {
    matchNumber: 88,
    home: "Australia",
    away: "Egypt",
  },
  {
    matchNumber: 85,
    home: "Switzerland",
    away: "TBD 3rd E/F/G/I/J",
  },
  {
    matchNumber: 87,
    home: "Winner Group K",
    away: "TBD 3rd D/E/I/J/L",
  },
].map((match, index) => ({
  id: `m${match.matchNumber}`,
  round: 0,
  bracketSlot: index + 1,
  matchNumber: match.matchNumber,
  home: match.home,
  away: match.away,
  prediction: {
    home: null,
    away: null,
    pick: null,
  },
  actual: {
    home: null,
    away: null,
    status: "scheduled",
  },
  note: getMatchNote(match),
}));

export function createInitialState() {
  return {
    version: STATE_VERSION,
    submissionId: crypto.randomUUID(),
    player: {
      name: "",
    },
    locked: false,
    lockedAt: null,
    bracketPicks: {},
    bracketScores: {},
    matches: structuredClone(seedMatches),
    updatedAt: new Date().toISOString(),
  };
}

function getMatchNote(match) {
  if (!match.home.includes("TBD") && !match.away.includes("TBD") && !match.home.includes("Group") && !match.away.includes("Group")) {
    return "Confirmed matchup";
  }

  return "Waiting on final group or third-place placement";
}
