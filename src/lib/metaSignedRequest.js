// Verify Meta's `signed_request` — the payload format used by the deauthorize
// and data-deletion callbacks.
//
// Meta POSTs `application/x-www-form-urlencoded` with a single field:
//
//     signed_request=<base64url signature>.<base64url json payload>
//
// The signature is HMAC-SHA256 of the *raw payload segment string* (not the
// decoded JSON) keyed with the app secret. Two things about that are easy to get
// wrong and both silently "work" until Meta sends a real request:
//
//   1. Sign the ENCODED segment, exactly as received. Re-encoding the decoded
//      JSON produces different bytes (key order, whitespace) and never matches.
//   2. Meta uses base64**url** (`-` and `_`, padding stripped). Node's "base64"
//      decoder tolerates this on input, but the HMAC comparison does not
//      tolerate a mangled segment, so keep the original string around.
//
// WHY VERIFY AT ALL: these endpoints must be public (Meta calls them with no
// session), and they DELETE data. Without signature checking, anyone who
// guesses the URL could post a user id and wipe that account's rows. The
// signature is the only thing standing between the endpoint and that.
//
// Docs: https://developers.facebook.com/docs/reference/login/signed-request

import { createHmac, timingSafeEqual } from "crypto";

function b64urlToBuffer(segment) {
  return Buffer.from(String(segment).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Both Meta setups in this app have their own secret, and either can be the
// signer depending on which product the user removed the app from. Trying each
// is simpler and safer than routing to per-platform endpoints and guessing
// wrong. Returns the candidate secrets in a stable order, skipping unset ones.
function candidateSecrets() {
  return [
    { name: "instagram", secret: (process.env.INSTAGRAM_APP_SECRET || "").trim() },
    { name: "facebook", secret: (process.env.FACEBOOK_CLIENT_SECRET || "").trim() },
  ].filter((c) => c.secret);
}

// Returns { ok: true, payload, signedBy } | { ok: false, error }
// Never throws: a malformed body from an unauthenticated caller is an expected
// input here, not an exceptional one.
export function parseSignedRequest(signedRequest) {
  if (!signedRequest || typeof signedRequest !== "string") {
    return { ok: false, error: "Missing signed_request." };
  }

  const dot = signedRequest.indexOf(".");
  if (dot <= 0 || dot === signedRequest.length - 1) {
    return { ok: false, error: "Malformed signed_request (expected sig.payload)." };
  }

  const encodedSig = signedRequest.slice(0, dot);
  const encodedPayload = signedRequest.slice(dot + 1);

  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(encodedPayload).toString("utf8"));
  } catch {
    return { ok: false, error: "signed_request payload is not valid JSON." };
  }

  if (payload.algorithm && String(payload.algorithm).toUpperCase() !== "HMAC-SHA256") {
    return { ok: false, error: `Unsupported signature algorithm "${payload.algorithm}".` };
  }

  const secrets = candidateSecrets();
  if (!secrets.length) {
    return { ok: false, error: "No app secret configured — cannot verify the signature." };
  }

  let expected;
  try {
    expected = b64urlToBuffer(encodedSig);
  } catch {
    return { ok: false, error: "signed_request signature is not valid base64url." };
  }

  for (const { name, secret } of secrets) {
    // Sign the encoded segment verbatim — see the note at the top.
    const actual = createHmac("sha256", secret).update(encodedPayload).digest();
    // timingSafeEqual throws on a length mismatch, so guard it.
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { ok: true, payload, signedBy: name };
    }
  }

  return { ok: false, error: "signed_request signature did not match any configured app secret." };
}
