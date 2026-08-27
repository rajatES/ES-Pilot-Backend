import { Injectable } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { exchangeForLongLivedToken, fetchLinkedInstagramAccounts, fetchTokenOwner } from "../../lib/facebookOAuth";
import { exchangeYouTubeCode, getYouTubeChannels } from "../../lib/youtube";
import {
  exchangeForLongLivedInstagramToken,
  exchangeInstagramCode,
  fetchInstagramProfile,
  isProfessionalAccount,
} from "../../lib/instagramOAuth";
import { detectSport } from "../../lib/sports";

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

  // Instagram Login callback — the direct path, no Facebook Page involved.
  //
  // Writes ONE row: platform "instagram", publish_via "native" (our token, our
  // publish path), and the marker `metadata.instagram.login = "instagram"`,
  // which is what makes lib/instagram.js talk to graph.instagram.com instead of
  // graph.facebook.com. Everything downstream — composer, previews,
  // platformRules, insights, deletion sync — needs no knowledge of this.
  //
  // Note the id caveat: the Instagram-Login user id is NOT the same id the
  // Facebook path stores for the same physical account, so connecting an
  // account both ways yields two rows that the unique constraint won't catch.
  // We detect that here on username and convert the row in place rather than
  // leaving a duplicate in the picker.
  async handleInstagramCallback(code: string): Promise<{ displayName: string; username: string | null }> {
    const { accessToken: shortLived } = await exchangeInstagramCode(code);

    // A 60-day token is the whole point — a short-lived one would strand the
    // account in an hour, so a failure here is fatal, not a warning.
    const { accessToken, expiresIn } = await exchangeForLongLivedInstagramToken(shortLived);

    const profile = await fetchInstagramProfile(accessToken);

    // Meta will happily issue a token for a personal profile and only fail at
    // publish time with something opaque. Say the real thing now.
    if (!isProfessionalAccount(profile.accountType)) {
      throw new Error(
        `@${profile.username || profile.igUserId} is a personal Instagram account, which no API can publish to. ` +
          `Switch it to a Creator or Business account in the Instagram app (Settings → Account type and tools), then reconnect.`,
      );
    }

    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
    const supabase = this.supabaseService.createServiceClient();

    const metadata = {
      source: "instagram_login_oauth",
      username: profile.username,
      instagram: {
        // The ONLY marker for the Instagram-Login path. lib/instagram.js reads
        // exactly this to choose its Graph host — don't rename it without
        // updating instagramGraphBase().
        login: "instagram",
        account_type: profile.accountType,
        connected_at: new Date().toISOString(),
      },
    };

    // Same physical account already connected through the Facebook Page path?
    // Different external id, same username — take the row over rather than
    // adding a second one, so the composer doesn't list the account twice.
    const { data: sameUsername } = await supabase
      .from("social_accounts")
      .select("id, external_account_id, metadata")
      .eq("user_id", OWNER_ID)
      .eq("platform", "instagram");

    const supersedes = (sameUsername || []).find(
      (a: any) =>
        profile.username &&
        a.metadata?.username === profile.username &&
        a.external_account_id !== profile.igUserId,
    );

    const { data: existing } = await supabase
      .from("social_accounts")
      .select("id, category")
      .eq("user_id", OWNER_ID)
      .eq("platform", "instagram")
      .eq("external_account_id", profile.igUserId)
      .single();

    const row = {
      access_token: accessToken,
      refresh_token: null,
      token_expires_at: expiresAt,
      display_name: profile.name,
      avatar_url: profile.avatar,
      followers: profile.followers,
      publish_via: "native",
      account_type: "profile",
      // A fresh authorization is the fix for a row flagged as unable to
      // publish, so clear the flag (mirrors confirmPages / the Postiz import).
      publishing_ok: true,
      metadata,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      await supabase.from("social_accounts").update(row).eq("id", existing.id);
    } else if (supersedes) {
      // Converting the Facebook-linked row: its external id must move to the
      // Instagram-Login id too, or publishing would post with the new token
      // against the old id.
      await supabase
        .from("social_accounts")
        .update({ ...row, external_account_id: profile.igUserId })
        .eq("id", supersedes.id);
      console.log(
        `[instagram login] converted existing row for @${profile.username} from the Facebook-Page path to direct Instagram Login.`,
      );
    } else {
      await supabase.from("social_accounts").insert({
        user_id: OWNER_ID,
        platform: "instagram",
        external_account_id: profile.igUserId,
        category: detectSport(profile.name),
        ...row,
      });
    }

    return { displayName: profile.name, username: profile.username };
  }

  // Threads has no OAuth handler here any more — it connects through Postiz,
  // which owns that token. See modules/postiz for the channel import.

  // X has no OAuth handler here any more — it connects through Postiz, which
  // owns that token. See modules/postiz for the channel import.

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
