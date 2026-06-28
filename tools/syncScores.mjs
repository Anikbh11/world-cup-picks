import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FINAL_STATUSES = new Set(["FT", "AET", "PEN"]);
const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]);
const DEFAULT_STATE_ID = "world-cup-r32";
const DEFAULT_API_BASE = "https://v3.football.api-sports.io";
const TBD_PATTERN = /\b(TBD|Runner-up|Winner Group)\b/i;
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
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const map = await readFixtureMap();
  const mappedEntries = Object.entries(map.fixtures || {}).filter(([, entry]) => Boolean(getFixtureId(entry)));

  if (!mappedEntries.length && !map.competition) {
    console.log("No fixture IDs or competition lookup configured. Nothing to sync.");
    return;
  }

  const env = readEnv();
  const state = await loadCurrentState(env);
  const resolvedEntries = mappedEntries.length ? mappedEntries : await discoverFixtureEntries(env, map, state);

  if (!resolvedEntries.length) {
    console.log("No fixtures could be matched from API-Football yet. Nothing to sync.");
    return;
  }

  const updates = await fetchFixtureUpdates(env, resolvedEntries);
  const changed = applyUpdates(state, updates);

  if (!changed.length) {
    console.log("Score sync finished. No match changes found.");
    return;
  }

  state.updatedAt = new Date().toISOString();

  if (dryRun) {
    console.log("Dry run. These changes would be applied:");
    console.table(changed);
    return;
  }

  await saveState(env, state);
  console.log(`Score sync finished. Updated ${changed.length} match(es).`);
  console.table(changed);
}

function readEnv() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const footballApiKey = process.env.FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY;

  if (!supabaseUrl) throw new Error("Missing SUPABASE_URL.");
  if (!serviceRoleKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
  if (!footballApiKey) throw new Error("Missing FOOTBALL_API_KEY.");

  return {
    supabaseUrl: supabaseUrl.replace(/\/$/, ""),
    serviceRoleKey,
    footballApiKey,
    stateId: process.env.SUPABASE_STATE_ID || DEFAULT_STATE_ID,
    apiBase: (process.env.FOOTBALL_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""),
    leagueId: process.env.FOOTBALL_LEAGUE_ID || null,
    season: process.env.FOOTBALL_SEASON || null,
  };
}

async function readFixtureMap() {
  const mapPath = path.join(__dirname, "score-fixture-map.json");
  return JSON.parse(await fs.readFile(mapPath, "utf8"));
}

function getFixtureId(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "string" || typeof entry === "number") return entry;
  return entry.fixtureId || entry.id || null;
}

async function discoverFixtureEntries(env, map, state) {
  const competition = {
    ...(map.competition || {}),
    leagueId: env.leagueId || map.competition?.leagueId || null,
    season: env.season || map.competition?.season || null,
  };

  if (!competition.season) {
    console.log("No FOOTBALL_SEASON or competition.season configured for fixture discovery.");
    return [];
  }

  const leagueId = competition.leagueId || await discoverLeagueId(env, competition);
  if (!leagueId) {
    console.log(`No API-Football league found for "${competition.leagueSearch || "World Cup"}" season ${competition.season}.`);
    return [];
  }

  const fixtures = await fetchCompetitionFixtures(env, { ...competition, leagueId });
  const resolved = [];
  const unresolved = [];

  for (const match of state.matches || []) {
    const matchCandidate = findFixtureForMatch(match, fixtures);
    if (matchCandidate) {
      resolved.push([match.id, { fixtureId: matchCandidate.fixture.fixture.id, flip: matchCandidate.flip }]);
    } else if (!hasPlaceholderTeam(match)) {
      unresolved.push(`${match.id}: ${match.home} vs ${match.away}`);
    }
  }

  console.log(`Discovered ${resolved.length} fixture ID(s) from API-Football.`);
  if (unresolved.length) {
    console.log(`Could not auto-match ${unresolved.length} known fixture(s): ${unresolved.join("; ")}`);
  }
  if (!resolved.length) {
    logFixtureCandidates(fixtures);
  }

  return resolved;
}

function logFixtureCandidates(fixtures) {
  if (!fixtures.length) {
    console.log("API-Football returned no fixtures for the configured league, season, and date range.");
    return;
  }

  console.log("API-Football fixtures returned for this config:");
  fixtures.slice(0, 40).forEach((fixture) => {
    const id = fixture.fixture?.id || "-";
    const date = fixture.fixture?.date || "-";
    const round = fixture.league?.round || "-";
    const status = fixture.fixture?.status?.short || "-";
    const home = fixture.teams?.home?.name || "-";
    const away = fixture.teams?.away?.name || "-";
    console.log(`${id}: ${home} vs ${away} | ${date} | ${round} | ${status}`);
  });
}

async function discoverLeagueId(env, competition) {
  const search = competition.leagueSearch || "World Cup";
  const params = new URLSearchParams({ search, season: String(competition.season) });
  const payload = await fetchApiFootball(env, `/leagues?${params}`);
  const leagues = payload?.response || [];
  const exact = leagues.find((item) => normalizeTeamName(item.league?.name) === normalizeTeamName(search));
  const worldCup = leagues.find((item) => normalizeTeamName(item.league?.name).includes("world cup"));
  return (exact || worldCup || leagues[0])?.league?.id || null;
}

async function fetchCompetitionFixtures(env, competition) {
  const params = new URLSearchParams({
    league: String(competition.leagueId),
    season: String(competition.season),
  });

  if (competition.from) params.set("from", competition.from);
  if (competition.to) params.set("to", competition.to);
  if (competition.round) params.set("round", competition.round);

  const payload = await fetchApiFootball(env, `/fixtures?${params}`);
  return payload?.response || [];
}

function findFixtureForMatch(match, fixtures) {
  if (hasPlaceholderTeam(match)) return null;

  const home = normalizeTeamName(match.home);
  const away = normalizeTeamName(match.away);

  return fixtures.reduce((best, fixture) => {
    if (best) return best;

    const apiHome = normalizeTeamName(fixture.teams?.home?.name);
    const apiAway = normalizeTeamName(fixture.teams?.away?.name);

    if (home === apiHome && away === apiAway) return { fixture, flip: false };
    if (home === apiAway && away === apiHome) return { fixture, flip: true };
    return null;
  }, null);
}

function hasPlaceholderTeam(match) {
  return TBD_PATTERN.test(match.home) || TBD_PATTERN.test(match.away);
}

async function loadCurrentState(env) {
  const rows = await supabaseFetch(
    env,
    `/rest/v1/bracket_states?id=eq.${encodeURIComponent(env.stateId)}&select=state`,
  );
  const state = rows?.[0]?.state;

  if (!state?.matches?.length) {
    throw new Error(`No bracket state found for ${env.stateId}. Open the site once or create the bracket_states row first.`);
  }

  return state;
}

async function saveState(env, state) {
  await supabaseFetch(env, "/rest/v1/bracket_states", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      id: env.stateId,
      state,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function fetchFixtureUpdates(env, mappedEntries) {
  const updates = new Map();

  for (const [matchId, entry] of mappedEntries) {
    const fixtureId = getFixtureId(entry);
    const fixture = await fetchApiFootballFixture(env, fixtureId);
    const actual = normalizeApiFootballFixture(fixture, Boolean(entry.flip));

    if (actual) {
      updates.set(matchId, actual);
    }
  }

  return updates;
}

async function fetchApiFootballFixture(env, fixtureId) {
  const payload = await fetchApiFootball(env, `/fixtures?id=${encodeURIComponent(fixtureId)}`);
  const fixture = payload?.response?.[0];

  if (!fixture) {
    throw new Error(`Score API returned no fixture for ${fixtureId}.`);
  }

  return fixture;
}

async function fetchApiFootball(env, endpoint) {
  const response = await fetch(`${env.apiBase}${endpoint}`, {
    headers: {
      "x-apisports-key": env.footballApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Score API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function normalizeApiFootballFixture(fixture, flip = false) {
  const statusShort = fixture.fixture?.status?.short || "NS";
  const apiHome = numberOrNull(fixture.goals?.home);
  const apiAway = numberOrNull(fixture.goals?.away);
  const home = flip ? apiAway : apiHome;
  const away = flip ? apiHome : apiAway;
  const apiPenaltyHome = numberOrNull(fixture.score?.penalty?.home);
  const apiPenaltyAway = numberOrNull(fixture.score?.penalty?.away);
  const penaltyHome = flip ? apiPenaltyAway : apiPenaltyHome;
  const penaltyAway = flip ? apiPenaltyHome : apiPenaltyAway;

  if (home === null || away === null) {
    return {
      home: null,
      away: null,
      pick: null,
      status: LIVE_STATUSES.has(statusShort) ? "live" : "scheduled",
      sourceStatus: statusShort,
      sourceUpdatedAt: new Date().toISOString(),
    };
  }

  const status = FINAL_STATUSES.has(statusShort) ? "final" : LIVE_STATUSES.has(statusShort) ? "live" : "scheduled";
  const regulationPick = getPickFromScore(home, away);
  const penaltyPick = getPickFromScore(penaltyHome, penaltyAway);
  const pick = regulationPick || (statusShort === "PEN" ? penaltyPick : null);

  return {
    home,
    away,
    pick,
    tieBreaker: pick,
    status,
    penaltyHome,
    penaltyAway,
    sourceStatus: statusShort,
    sourceUpdatedAt: new Date().toISOString(),
  };
}

function applyUpdates(state, updates) {
  const changed = [];

  state.matches = state.matches.map((match) => {
    const actual = updates.get(match.id);
    if (!actual) return match;

    const nextMatch = {
      ...match,
      actual: {
        ...match.actual,
        ...actual,
      },
    };

    if (!sameActual(match.actual, nextMatch.actual)) {
      changed.push({
        match: match.id,
        fixture: `${match.home} vs ${match.away}`,
        status: nextMatch.actual.status,
        score: formatScore(nextMatch.actual),
        winner: nextMatch.actual.pick || "-",
      });
    }

    return nextMatch;
  });

  return changed;
}

function sameActual(left, right) {
  const keys = ["home", "away", "pick", "tieBreaker", "status", "penaltyHome", "penaltyAway", "sourceStatus"];
  return keys.every((key) => left?.[key] === right?.[key]);
}

function getPickFromScore(home, away) {
  if (home === null || away === null || home === away) return null;
  return home > away ? "home" : "away";
}

function normalizeTeamName(value) {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  return TEAM_ALIASES.get(normalized) || normalized;
}

function formatScore(actual) {
  const score = `${actual.home ?? "-"}-${actual.away ?? "-"}`;
  if (actual.penaltyHome !== null && actual.penaltyAway !== null) {
    return `${score} pens ${actual.penaltyHome}-${actual.penaltyAway}`;
  }
  return score;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function supabaseFetch(env, endpoint, options = {}) {
  const response = await fetch(`${env.supabaseUrl}${endpoint}`, {
    ...options,
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
