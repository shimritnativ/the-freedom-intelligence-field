// lib/anthropicCosts.js
//
// Fetches usage cost from Anthropic's Organization Admin API. Requires an
// admin-tier API key (set as ANTHROPIC_ADMIN_API_KEY env var in Vercel).
// A regular `sk-ant-api03-...` key WILL NOT work here — Anthropic restricts
// the cost report to admin keys only.
//
// Returns total USD spent across the requested time window, summed across
// every workspace and model. Conversion to EUR happens in the caller using
// the same fx rate the launch tracker uses for the other ops costs.
//
// Endpoint reference:
//   https://docs.claude.com/en/api/admin-api/usage-cost/get-cost-report
// Falls back to returning 0 + an error message if the env var is missing
// or the API call fails, so a misconfiguration never breaks Real Profit.

const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report";

export async function fetchAnthropicSpendUsd({ startingAt, endingAt }) {
  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) {
    return {
      totalUsd: 0,
      ok: false,
      reason: "ANTHROPIC_ADMIN_API_KEY env var is not set in Vercel.",
    };
  }
  if (!adminKey.startsWith("sk-ant-admin")) {
    return {
      totalUsd: 0,
      ok: false,
      reason: "ANTHROPIC_ADMIN_API_KEY does not look like an admin key (expected sk-ant-admin... prefix). Regular API keys cannot read cost data.",
    };
  }

  try {
    const url = new URL(ANTHROPIC_COST_REPORT_URL);
    url.searchParams.set("starting_at", startingAt);
    url.searchParams.set("ending_at", endingAt);
    url.searchParams.set("bucket_width", "1d");

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": adminKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        totalUsd: 0,
        ok: false,
        reason: `anthropic_admin_${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = await res.json();
    // Response shape (per Anthropic docs):
    //   { data: [{ starting_at, ending_at, results: [{ amount, currency, ... }] }, ...] }
    // We sum every `amount` across every bucket and every result row. Anthropic
    // bills in USD; the `currency` field on each result row confirms this.
    let totalUsd = 0;
    for (const bucket of (json.data || [])) {
      for (const result of (bucket.results || [])) {
        const amount = Number(result.amount || 0);
        if (Number.isFinite(amount)) totalUsd += amount;
      }
    }

    return {
      totalUsd,
      ok: true,
      reason: null,
    };
  } catch (err) {
    return {
      totalUsd: 0,
      ok: false,
      reason: err?.message || String(err),
    };
  }
}
