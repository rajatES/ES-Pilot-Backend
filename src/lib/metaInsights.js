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
    if (res.ok) return data?.data || [];
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
  return merged;
}
