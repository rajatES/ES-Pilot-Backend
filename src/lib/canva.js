import { createServiceSupabase } from "./supabaseServer";

// Canva Connect API helpers. Each teammate connects THEIR OWN Canva account:
// tokens are stored per profile in user_integrations and refreshed silently.
// Requires (see README-integrations.md):
//   CANVA_CLIENT_ID / CANVA_CLIENT_SECRET — from a Canva Connect app
//   CANVA_REDIRECT_URI — must match the app's redirect URL exactly

const CANVA_AUTH_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
export const CANVA_API = "https://api.canva.com/rest/v1";
export const CANVA_SCOPES = "design:meta:read design:content:read asset:read";

export function canvaConfigured() {
  return !!(process.env.CANVA_CLIENT_ID && process.env.CANVA_CLIENT_SECRET);
}

export function canvaRedirectUri(origin) {
  return process.env.CANVA_REDIRECT_URI || `${origin}/api/auth/canva/callback`;
}

export function buildCanvaAuthUrl({ state, codeChallenge, origin }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CANVA_CLIENT_ID,
    redirect_uri: canvaRedirectUri(origin),
    scope: CANVA_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  return `${CANVA_AUTH_URL}?${params}`;
}

async function tokenRequest(form) {
  const basic = Buffer.from(`${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(CANVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams(form)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || data?.error || "Canva token request failed.");
  return data;
}

export async function exchangeCanvaCode({ code, codeVerifier, origin }) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: canvaRedirectUri(origin)
  });
}

export async function saveCanvaTokens(profileId, tokens) {
  const supabase = createServiceSupabase();
  const { error } = await supabase.from("user_integrations").upsert(
    {
      profile_id: profileId,
      provider: "canva",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    },
    { onConflict: "profile_id,provider" }
  );
  if (error) throw new Error(`Couldn't save Canva connection: ${error.message}`);
}

// Returns a valid access token for this profile, refreshing if it's about to
// expire. Returns null when the user hasn't connected Canva (or refresh failed
// — e.g. they revoked access — in which case they just reconnect).
export async function getCanvaAccessToken(profileId) {
  const supabase = createServiceSupabase();
  const { data: row } = await supabase
    .from("user_integrations")
    .select("access_token, refresh_token, expires_at")
    .eq("profile_id", profileId)
    .eq("provider", "canva")
    .maybeSingle();
  if (!row?.refresh_token) return null;

  if (row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60_000) {
    return row.access_token;
  }
  try {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token });
    await saveCanvaTokens(profileId, tokens);
    return tokens.access_token;
  } catch {
    return null;
  }
}
