import { Injectable } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { exchangeForLongLivedToken, fetchLinkedInstagramAccounts, fetchTokenOwner } from "../../lib/facebookOAuth";
import { exchangeYouTubeCode, getYouTubeChannels } from "../../lib/youtube";
import { exchangeThreadsCode, exchangeForLongLivedThreadsToken, fetchThreadsProfile } from "../../lib/threads";
import { exchangeXCode, fetchXProfile } from "../../lib/x";

const META_API_VERSION = "v23.0";
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

@Injectable()
export class AuthService {
  constructor(private readonly supabaseService: SupabaseService) {}

  // Facebook OAuth-redirect callback: exchange code, save Pages + linked IG
  // under OWNER_ID. Throws Error(message) which the controller surfaces to /app.
  async handleFacebookCallback(code: string): Promise<number> {
    const tokenUrl =
      `${BASE_URL}/oauth/access_token?` +
      `client_id=${process.env.FACEBOOK_CLIENT_ID}` +
      `&client_secret=${process.env.FACEBOOK_CLIENT_SECRET}` +
      `&redirect_uri=${encodeURIComponent(process.env.FACEBOOK_REDIRECT_URI)}` +
      `&code=${code}`;

    const tokenRes = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokenData?.error?.message || "Failed to exchange code for token.");
    }

    let accessToken = tokenData.access_token;
    try {
      accessToken = await exchangeForLongLivedToken(accessToken);
    } catch (err) {
      console.warn("[facebook callback] long-lived token exchange failed:", err.message);
    }

    const pagesUrl = `${BASE_URL}/me/accounts?access_token=${accessToken}&fields=id,name,access_token,picture`;
    const pagesRes = await fetch(pagesUrl);
    const pagesData = await pagesRes.json();
    if (!pagesRes.ok) {
      throw new Error(pagesData?.error?.message || "Failed to fetch Facebook pages.");
    }

    const pages = pagesData.data || [];
    if (!pages.length) {
      throw new Error("No Facebook Pages found. Make sure you have manage permissions.");
    }

    let connectedVia: any = null;
    try {
      const owner = await fetchTokenOwner(accessToken);
      connectedVia = { ...owner, connected_at: new Date().toISOString() };
    } catch (err) {
      console.warn("[facebook callback] could not identify token owner:", err.message);
    }

    const supabase = this.supabaseService.createServiceClient();

    let savedCount = 0;
    for (const page of pages) {
      const { data: existing } = await supabase
        .from("social_accounts")
        .select("id")
        .eq("user_id", OWNER_ID)
        .eq("platform", "facebook")
        .eq("external_account_id", page.id)
        .single();

      if (existing) {
        await supabase
          .from("social_accounts")
          .update({
            access_token: page.access_token,
            display_name: page.name,
            avatar_url: page.picture?.data?.url || null,
            metadata: { source: "facebook_oauth_redirect", ...(connectedVia ? { connected_via: connectedVia } : {}) },
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("social_accounts").insert({
          user_id: OWNER_ID,
          platform: "facebook",
          external_account_id: page.id,
          display_name: page.name,
          avatar_url: page.picture?.data?.url || null,
          access_token: page.access_token,
          metadata: { source: "facebook_oauth_redirect", ...(connectedVia ? { connected_via: connectedVia } : {}) },
        });
      }
      savedCount++;
    }

    const igAccounts = await fetchLinkedInstagramAccounts(pages);
    for (const ig of igAccounts) {
      const { data: existing } = await supabase
        .from("social_accounts")
        .select("id")
        .eq("user_id", OWNER_ID)
        .eq("platform", "instagram")
        .eq("external_account_id", ig.id)
        .single();

      if (existing) {
        await supabase
          .from("social_accounts")
          .update({
            access_token: ig.access_token,
            display_name: ig.name,
            avatar_url: ig.picture,
            metadata: {
              source: "facebook_oauth_redirect",
              username: ig.username,
              fb_page_id: ig.fb_page_id,
              ...(connectedVia ? { connected_via: connectedVia } : {}),
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("social_accounts").insert({
          user_id: OWNER_ID,
          platform: "instagram",
          external_account_id: ig.id,
          display_name: ig.name,
          avatar_url: ig.picture,
          access_token: ig.access_token,
          metadata: {
            source: "facebook_oauth_redirect",
            username: ig.username,
            fb_page_id: ig.fb_page_id,
            ...(connectedVia ? { connected_via: connectedVia } : {}),
          },
        });
      }
      savedCount++;
    }

    return savedCount;
  }

  // Threads OAuth callback: exchange code → long-lived token → save the
  // profile as a social account. Returns the connected profile's username.
  async handleThreadsCallback(code: string): Promise<string> {
    const { accessToken: shortToken } = await exchangeThreadsCode(code);
    const { accessToken, expiresAt } = await exchangeForLongLivedThreadsToken(shortToken);
    const profile = await fetchThreadsProfile(accessToken);

    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase.from("social_accounts").upsert(
      {
        user_id: OWNER_ID,
        platform: "threads",
        account_type: "profile",
        external_account_id: profile.id,
        display_name: profile.name,
        avatar_url: profile.avatar,
        access_token: accessToken,
        token_expires_at: expiresAt,
        metadata: { source: "threads_oauth", username: profile.username },
      },
      { onConflict: "user_id,platform,external_account_id" },
    );
    if (error) throw new Error(error.message);

    return profile.username;
  }

  // X (Twitter) OAuth callback: exchange code (PKCE) → save the profile as a
  // social account. platform is "twitter" to match the existing UI metadata.
  async handleXCallback(code: string, codeVerifier: string): Promise<string> {
    const { accessToken, refreshToken, expiresAt } = await exchangeXCode({ code, codeVerifier });
    const profile = await fetchXProfile(accessToken);

    const supabase = this.supabaseService.createServiceClient();
    const { error } = await supabase.from("social_accounts").upsert(
      {
        user_id: OWNER_ID,
        platform: "twitter",
        account_type: "profile",
        external_account_id: profile.id,
        display_name: profile.name,
        avatar_url: profile.avatar,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        metadata: { source: "x_oauth", username: profile.username },
      },
      { onConflict: "user_id,platform,external_account_id" },
    );
    if (error) throw new Error(error.message);

    return profile.username;
  }

  // YouTube OAuth callback: exchange code, save channels under OWNER_ID.
  async handleYoutubeCallback(code: string): Promise<number> {
    const tokens = await exchangeYouTubeCode(code);
    const channels = await getYouTubeChannels({ accessToken: tokens.accessToken });

    if (!channels.length) {
      throw new Error("No YouTube channels found.");
    }

    const supabase = this.supabaseService.createServiceClient();

    for (const channel of channels) {
      const { data: existing } = await supabase
        .from("social_accounts")
        .select("id")
        .eq("user_id", OWNER_ID)
        .eq("platform", "youtube")
        .eq("external_account_id", channel.id)
        .single();

      if (existing) {
        await supabase
          .from("social_accounts")
          .update({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            display_name: channel.title,
            avatar_url: channel.thumbnail,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("social_accounts").insert({
          user_id: OWNER_ID,
          platform: "youtube",
          external_account_id: channel.id,
          display_name: channel.title,
          avatar_url: channel.thumbnail,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          metadata: { source: "youtube_oauth", subscribers: channel.subscribers, videoCount: channel.videoCount },
        });
      }
    }

    return channels.length;
  }
}
