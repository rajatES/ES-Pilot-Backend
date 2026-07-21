// Server-side Meta Graph helpers — mirrors the proven flow from the
// EssentiallyAnalytics production backend (meta.service.ts), plus a
// Business Portfolio fallback for pages that don't show in /me/accounts.

const META_API_VERSION = "v23.0";
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// Exchange a short-lived user token (from the JS SDK FB.login popup)
// for a long-lived user token (~60 days).
export async function exchangeForLongLivedToken(shortLivedToken) {
  const url =
    `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${process.env.FACEBOOK_CLIENT_ID}` +
    `&client_secret=${process.env.FACEBOOK_CLIENT_SECRET}` +
    `&fb_exchange_token=${shortLivedToken}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || "Long-lived token exchange failed.");
  }
  return data.access_token;
}

// Identify the Facebook user a token belongs to — lets us tag every
// connected Page with its source account so pages from multiple FB
// accounts can coexist and be disconnected per-account.
export async function fetchTokenOwner(accessToken) {
  const res = await fetch(`${BASE_URL}/me?fields=id,name,picture&access_token=${accessToken}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data?.error?.message || "Could not identify the Facebook account.");
  }
  return {
    fb_user_id: data.id,
    fb_user_name: data.name,
    avatar: data.picture?.data?.url || null
  };
}

// For each Page, find a linked Instagram Business/Creator account.
// IG posting uses the linked Page's access token.
export async function fetchLinkedInstagramAccounts(pages) {
  const igAccounts = [];
  for (const page of pages) {
    try {
      const url = `${BASE_URL}/${page.id}?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${page.access_token}`;
      const res = await fetch(url);
      const data = await res.json();
      const ig = data.instagram_business_account;
      if (ig?.id) {
        igAccounts.push({
          id: ig.id,
          name: ig.name || ig.username || page.name,
          username: ig.username,
          picture: ig.profile_picture_url || null,
          access_token: page.access_token,
          platform: "instagram",
          fb_page_id: page.id
        });
      }
    } catch (e) {
      console.log(`[Meta] IG lookup failed for page ${page.id}:`, e.message);
    }
  }
  return igAccounts;
}

// Resolve every Page the user can manage — classic Pages (via /me/accounts)
// AND Business Portfolio Pages (via /me/businesses → owned/client pages).
export async function fetchPermanentPageTokens(accessToken) {
  const byId = new Map();

  // --- Source 1: classic /me/accounts (paginated) ---
  let url = `${BASE_URL}/me/accounts?fields=id,name,access_token,picture&limit=100&access_token=${accessToken}`;
  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.error("[Meta] me/accounts error:", data.error.message);
      break;
    }
    for (const p of data.data || []) byId.set(p.id, p);
    url = data.paging?.next || null;
  }
  console.log(`[Meta] me/accounts returned ${byId.size} page(s).`);

  // --- Source 2: Business Portfolio owned + client pages ---
  try {
    const bizRes = await fetch(`${BASE_URL}/me/businesses?fields=id,name&limit=100&access_token=${accessToken}`);
    const bizData = await bizRes.json();

    if (bizData.error) {
      console.log("[Meta] me/businesses error:", bizData.error.message);
    }

    for (const biz of bizData.data || []) {
      for (const edge of ["owned_pages", "client_pages"]) {
        let bUrl = `${BASE_URL}/${biz.id}/${edge}?fields=id,name,access_token,picture&limit=100&access_token=${accessToken}`;
        while (bUrl) {
          const res = await fetch(bUrl);
          const data = await res.json();
          if (data.error) {
            console.log(`[Meta] ${biz.name}/${edge} error:`, data.error.message);
            break;
          }
          for (const p of data.data || []) {
            if (!byId.has(p.id)) byId.set(p.id, p);
          }
          bUrl = data.paging?.next || null;
        }
      }
    }
    console.log(`[Meta] after business portfolios: ${byId.size} page(s) total.`);
  } catch (e) {
    console.log("[Meta] business lookup failed:", e.message);
  }

  // --- Ensure every page has a usable page access token ---
  const pages = [];
  for (const page of byId.values()) {
    let token = page.access_token;
    if (!token) {
      // Business-owned pages often omit the token in listings — fetch it directly.
      try {
        const res = await fetch(`${BASE_URL}/${page.id}?fields=access_token,name,picture&access_token=${accessToken}`);
        const data = await res.json();
        token = data.access_token;
        if (!page.picture && data.picture) page.picture = data.picture;
      } catch (e) {
        console.log(`[Meta] could not fetch token for page ${page.id}:`, e.message);
      }
    }
    if (token) {
      pages.push({ ...page, access_token: token });
    } else {
      console.log(`[Meta] skipping page ${page.name} (${page.id}) — no access token.`);
    }
  }

  return pages;
}
