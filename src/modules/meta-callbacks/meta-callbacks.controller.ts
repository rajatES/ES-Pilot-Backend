import { Body, Controller, Get, Post } from "@nestjs/common";
import { MetaCallbacksService } from "./meta-callbacks.service";
import { Public } from "../../auth/public.decorator";

// Meta-initiated callbacks. @Public because Meta calls these server-to-server
// with no session — authentication is the signed_request HMAC instead, checked
// in lib/metaSignedRequest.js. Never add a JWT guard here or Meta's calls 401.
//
// Paste these into the Meta App Dashboard:
//   Deauthorize callback URL  -> https://<backend>/api/meta/deauthorize
//   Data deletion request URL -> https://<backend>/api/meta/data-deletion
//
// Both live under one controller because both arrive in the same format and
// concern the same lifecycle, and both apply to BOTH Meta setups in this app
// (Facebook Login and Instagram Login) — the verifier tries each app secret.
@Public()
@Controller("meta")
export class MetaCallbacksController {
  constructor(private readonly callbacks: MetaCallbacksService) {}

  // Where the status link in the data-deletion response points. The frontend
  // page is the human-readable half; this exists so the callback's `url` is
  // valid even if the frontend origin is unset.
  private frontend() {
    return process.env.FRONTEND_URL || "http://localhost:3000";
  }

  // POST /api/meta/deauthorize
  // Body: application/x-www-form-urlencoded, signed_request=<sig>.<payload>
  //
  // Always answers 200. Meta retries a failed callback, and there is no retry
  // that would make an unverifiable request acceptable — so a rejection is
  // logged and acknowledged rather than turned into a retry loop.
  @Post("deauthorize")
  async deauthorize(@Body() body: any) {
    await this.callbacks.deauthorize(body?.signed_request);
    return { ok: true };
  }

  // POST /api/meta/data-deletion
  // MUST return { url, confirmation_code } — Meta validates the shape, and a
  // plain 200 or an HTML page counts as a failed request.
  @Post("data-deletion")
  dataDeletion(@Body() body: any) {
    return this.callbacks.dataDeletion(body?.signed_request, this.frontend());
  }

  // Opening either callback in a browser is the natural thing to try when
  // pasting it into the dashboard, and a bare 404 there reads as "wrong URL".
  // These GETs exist only to say the endpoint is live and POST-only.
  @Get("deauthorize")
  deauthorizeInfo() {
    return {
      ok: true,
      endpoint: "meta-deauthorize",
      method: "POST",
      expects: "application/x-www-form-urlencoded with a signed_request field",
      note: "This URL is called by Meta, not by a browser. Paste it into App Dashboard as the Deauthorize callback URL.",
    };
  }

  @Get("data-deletion")
  dataDeletionInfo() {
    return {
      ok: true,
      endpoint: "meta-data-deletion",
      method: "POST",
      expects: "application/x-www-form-urlencoded with a signed_request field",
      returns: { url: "<status page>", confirmation_code: "<code>" },
      note: "This URL is called by Meta, not by a browser. Paste it into App Dashboard as the Data deletion request URL. The human-readable instructions page is /data-deletion on the frontend.",
    };
  }
}
