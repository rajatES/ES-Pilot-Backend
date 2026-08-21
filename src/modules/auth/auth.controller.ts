import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import * as crypto from "crypto";
import { Public } from "../../auth/public.decorator";
import { AuthService } from "./auth.service";
import { buildCanvaAuthUrl, canvaConfigured, exchangeCanvaCode, saveCanvaTokens } from "../../lib/canva";
import { getYouTubeAuthUrl } from "../../lib/youtube";

// After the OAuth dance completes we return the browser to the FRONTEND app,
// not the backend. The provider redirect_uri (FACEBOOK_/YOUTUBE_/CANVA_REDIRECT_URI)
// must point at THIS backend's callback routes.
const frontend = () => process.env.FRONTEND_URL || "http://localhost:3000";
const backendOrigin = (req: Request) => `${req.protocol}://${req.get("host")}`;

// The exact permission set this app uses — every one is exercised by real code
// (Page publishing, IG publishing/comments, insights sync, Business-portfolio
// page discovery). Submit precisely this list for App Review; the frontend's
// FB.login scope must stay identical.
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "read_insights",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
].join(",");

@Public()
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ── Facebook ─────────────────────────────────────────────────────────────
  // NOTE: the original /start enforced admin/Group-Head via the session cookie.
  // With Bearer-only auth there's no session on a top-level browser navigation,
  // so that gate now lives in the frontend (it hides the Connect button). The
  // callback still writes under the single shared OWNER_ID.
  @Get("facebook/start")
  facebookStart(@Res() res: Response) {
    const clientId = process.env.FACEBOOK_CLIENT_ID;
    const redirectUri = process.env.FACEBOOK_REDIRECT_URI || "http://localhost:4000/api/auth/facebook/callback";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      // Keep in lockstep with the JS SDK FB.login scope in the frontend and
      // with the permissions submitted for App Review — asking for anything
      // the app doesn't actually call (e.g. messaging) gets a review rejected.
      scope: FACEBOOK_SCOPES,
      response_type: "code",
      state: Math.random().toString(36).slice(2),
      auth_type: "reauthenticate",
    });
    return res.redirect(`https://www.facebook.com/v23.0/dialog/oauth?${params}`);
  }

  @Get("facebook/callback")
  async facebookCallback(
    @Query("code") code: string,
    @Query("error") error: string,
    @Query("error_description") errorDescription: string,
    @Res() res: Response,
  ) {
    const app = `${frontend()}/app`;
    if (error) return res.redirect(`${app}?error=Facebook auth failed: ${errorDescription || error}`);
    if (!code) return res.redirect(`${app}?error=No authorization code received from Facebook.`);

    try {
      const savedCount = await this.auth.handleFacebookCallback(code);
      return res.redirect(`${app}?success=Connected ${savedCount} account(s) (Facebook Pages and Instagram)`);
    } catch (err) {
      console.error("[facebook callback] error:", err.message);
      return res.redirect(`${app}?error=Connection failed: ${err.message}`);
    }
  }

  // ── Threads ──────────────────────────────────────────────────────────────
  // No routes: Threads is connected through Postiz, not our own OAuth. Meta's
  // Threads API needs a separate app plus review, which we never completed, so
  // the native start/callback pair (and lib/threads.js behind it) was retired.
  // Channels are imported from the Postiz workspace instead — see
  // modules/postiz. Nothing here should be re-added without also restoring a
  // native publish path; `publish_via` is what decides which one runs.

  // ── YouTube ──────────────────────────────────────────────────────────────
  @Get("youtube/start")
  youtubeStart(@Res() res: Response) {
    return res.redirect(getYouTubeAuthUrl());
  }

  @Get("youtube/callback")
  async youtubeCallback(@Query("code") code: string, @Query("error") error: string, @Res() res: Response) {
    const app = `${frontend()}/app`;
    if (error) return res.redirect(`${app}?error=YouTube authorization failed: ${error}`);
    if (!code) return res.redirect(`${app}?error=No authorization code received.`);

    try {
      const count = await this.auth.handleYoutubeCallback(code);
      return res.redirect(`${app}?youtube=connected&channels=${count}`);
    } catch (err) {
      console.error("[youtube callback] error:", err.message);
      return res.redirect(`${app}?error=YouTube connection failed: ${err.message}`);
    }
  }

  // ── X / Twitter ─────────────────────────────────────────────────────────
  // No routes: X publishes through Postiz now. The native PKCE pair went away
  // with lib/x.js — posting on X needs a paid API tier we never bought, so the
  // native path never published anything. Postiz already holds a working X
  // authorization; channels are imported from there (modules/postiz).

  // ── Canva (per-user, PKCE) ───────────────────────────────────────────────
  // Per-user tokens need to know WHICH teammate. With no session cookie on a
  // top-level navigation, the frontend passes its own profile id as ?uid=; the
  // id is folded into the OAuth `state` and recovered in the callback. The PKCE
  // verifier + state live in short-lived cookies on the backend origin.
  @Get("canva/start")
  canvaStart(@Query("uid") uid: string, @Req() req: Request, @Res() res: Response) {
    if (!canvaConfigured()) {
      return res.redirect(`${frontend()}/app?canva=error`);
    }
    if (!uid) return res.redirect(`${frontend()}/login`);

    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = `${uid}~${crypto.randomBytes(16).toString("base64url")}`;

    const cookieOpts = { httpOnly: true as const, sameSite: "lax" as const, path: "/", maxAge: 600_000 };
    res.cookie("canva_verifier", verifier, cookieOpts);
    res.cookie("canva_state", state, cookieOpts);

    return res.redirect(buildCanvaAuthUrl({ state, codeChallenge: challenge, origin: backendOrigin(req) }));
  }

  @Get("canva/callback")
  async canvaCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const savedState = req.cookies?.canva_state;
    const verifier = req.cookies?.canva_verifier;

    const done = (param: string) => {
      res.clearCookie("canva_state");
      res.clearCookie("canva_verifier");
      return res.redirect(`${frontend()}/app?canva=${param}`);
    };

    if (!code || !state || !savedState || state !== savedState || !verifier) {
      return done("error");
    }

    const uid = String(state).split("~")[0];
    if (!uid) return done("error");

    try {
      const tokens = await exchangeCanvaCode({ code, codeVerifier: verifier, origin: backendOrigin(req) });
      await saveCanvaTokens(uid, tokens);
      return done("connected");
    } catch (err) {
      console.error("[canva] token exchange failed:", err.message);
      return done("error");
    }
  }
}
