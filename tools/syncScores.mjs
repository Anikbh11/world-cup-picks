import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FINAL_STATUSES = new Set(["FT", "AET", "PEN"]);
const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]);
const DEFAULT_STATE_ID = "world-cup-r32";
const DEFAULT_API_BASE = "https://v3.football.api-sports.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const map = await readFixtureMap();
  const mappedEntries = Object.entries(map.fixtures || {}).filter(([, entry]) => Boolean(getFixtureId(entry)));

  if (!mappedEntries.length) {
    console.log("No provider fixture IDs configured in tools/score-fixture-map.json. Nothing to sync.");
    return;
  }

  const env = readEnv();
  const state = await loadCurrentState(env);
  const updates = await fetchFixtureUpdates(env, mappedEntries);
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
    const actual = normalizeApiFootballFixture(fixture);

    if (actual) {
      updates.set(matchId, actual);
    }
  }

  return updates;
}

async function fetchApiFootballFixture(env, fixtureId) {
  const url = `${env.apiBase}/fixtures?id=${encodeURIComponent(fixtureId)}`;
  const response = await fetch(url, {
    headers: {
      "x-apisports-key": env.footballApiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Score API request failed for fixture ${fixtureId}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const fixture = payload?.response?.[0];

  if (!fixture) {
    throw new Error(`Score API returned no fixture for ${fixtureId}.`);
  }

  return fixture;
}

function normalizeApiFootballFixture(fixture) {
  const statusShort = fixture.fixture?.status?.short || "NS";
  const home = numberOrNull(fixture.goals?.home);
  const away = numberOrNull(fixture.goals?.away);
  const penaltyHome = numberOrNull(fixture.score?.penalty?.home);
  const penaltyAway = numberOrNull(fixture.score?.penalty?.away);

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
