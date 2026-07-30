// Meta Graph /insights fetch that survives an invalid metric in a batch.
//
// Meta returns a 400 for the WHOLE request if ANY requested metric is invalid
// for the object (metrics vary by post type + Graph version), which would
// otherwise wipe every metric in the batch — the classic "likes/comments show
// but reach/views are blank" symptom. On that specific error we retry each
// metric on its own and merge whatever succeeds.
//
// Ported from the es-page-registry meta.service (fetchInsightsResilient), using
// fetch instead of axios. Never throws — insights are always optional to the
// caller; returns the `data` array (possibly empty).
export async function fetchInsightsResilient(graphBase, objectId, metrics, accessToken, extraParams = "") {
  const build = (csv) =>
    `${graphBase}/${objectId}/insights?` +
    [`metric=${csv}`, extraParams, `access_token=${accessToken}`].filter(Boolean).join("&");

  try {
    const res = await fetch(build(metrics.join(",")));
    const data = await res.json();
    if (res.ok) return preferLifetime(data?.data || []);
    const err = data?.error;
    // Only an invalid-metric error is salvageable by dropping the bad name(s).
    const invalidMetric = err?.code === 100 && /valid insights metric/i.test(err?.message || "");
    if (!invalidMetric) return []; // permissions / other error — nothing to salvage
  } catch {
    return [];
  }

  const merged = [];
  for (const metric of metrics) {
    try {
      const res = await fetch(build(metric));
      const data = await res.json();
      if (res.ok && data?.data) merged.push(...data.data);
    } catch {
      /* skip this metric */
    }
  }
  return preferLifetime(merged);
}

// The new "media view" metrics (post_media_view, post_total_media_view_unique,
// …) can come back as TWO entries for one name — a `lifetime` total and a `day`
// series whose values[0] is just the first day in the window. Callers read
// values[0], so collapse duplicates to one entry per metric, keeping the
// lifetime total when present. Order-independent (don't trust Meta's ordering).
function preferLifetime(rows) {
  const byName = new Map();
  for (const r of rows) {
    const existing = byName.get(r.name);
    if (!existing || (r.period === "lifetime" && existing.period !== "lifetime")) {
      byName.set(r.name, r);
    }
  }
  return [...byName.values()];
}
