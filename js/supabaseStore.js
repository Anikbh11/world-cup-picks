import { SUPABASE_CONFIG } from "./config.js?v=37";
import { STATE_VERSION } from "./data.js?v=37";

const PLACEHOLDER_VALUES = new Set(["", "YOUR_SUPABASE_URL", "YOUR_SUPABASE_ANON_KEY"]);

export async function createLiveStore() {
  if (!isConfigured()) {
    return {
      enabled: false,
      status: "Local mode",
      load: async () => null,
      save: async () => {},
      loadSubmissions: async () => [],
      saveSubmission: async () => {},
      subscribe: () => {},
      subscribeSubmissions: () => {},
    };
  }

  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const client = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);

  return {
    enabled: true,
    status: "Supabase connected",
    async load() {
      const { data, error } = await client
        .from(SUPABASE_CONFIG.table)
        .select("state")
        .eq("id", SUPABASE_CONFIG.stateId)
        .maybeSingle();

      if (error) throw error;
      return data?.state ?? null;
    },
    async save(state) {
      const { error } = await client.from(SUPABASE_CONFIG.table).upsert({
        id: SUPABASE_CONFIG.stateId,
        state,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;
    },
    async loadSubmissions() {
      const { data, error } = await client
        .from("bracket_submissions")
        .select("id, player_name, state, locked_at, updated_at")
        .order("locked_at", { ascending: true });

      if (error) throw error;
      return (data ?? []).filter(isActiveSubmission);
    },
    async saveSubmission(state) {
      const playerName = normalizeName(state.player?.name) || "Anonymous";
      const submissionState = {
        ...state,
        player: {
          ...(state.player || {}),
          name: playerName,
        },
      };
      const { error } = await client.from("bracket_submissions").insert({
        id: state.submissionId,
        player_name: playerName,
        state: submissionState,
        locked_at: state.lockedAt,
        updated_at: new Date().toISOString(),
      });

      if (error) throw error;
    },
    subscribe(onState) {
      const channel = client
        .channel("bracket-state-sync")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: SUPABASE_CONFIG.table,
            filter: `id=eq.${SUPABASE_CONFIG.stateId}`,
          },
          (payload) => {
            if (payload.new?.state) onState(payload.new.state);
          },
        )
        .subscribe();

      return () => client.removeChannel(channel);
    },
    subscribeSubmissions(onSubmissionsChanged) {
      const channel = client
        .channel("bracket-submission-sync")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "bracket_submissions",
          },
          () => onSubmissionsChanged(),
        )
        .subscribe();

      return () => client.removeChannel(channel);
    },
  };
}

function isConfigured() {
  return !PLACEHOLDER_VALUES.has(SUPABASE_CONFIG.url) && !PLACEHOLDER_VALUES.has(SUPABASE_CONFIG.anonKey);
}

function isMockSubmission(submission) {
  return (submission.player_name || submission.state?.player?.name || "").toLowerCase().startsWith("mock ");
}

function isActiveSubmission(submission) {
  return !isMockSubmission(submission) && submission.state?.version === STATE_VERSION;
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ");
}
