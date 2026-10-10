// AI usage metering and limits. Every AI call is recorded per workspace; calls on the platform's keys are capped per
// day so one workspace can't run up the platform bill. Workspaces on their own Anthropic key are not capped by us.
const err = (status, message) => Object.assign(new Error(message), { status });

// Rough list prices in USD per million tokens, for the usage page's cost estimate only.
const PRICES = {
  "claude-opus-5-5": [5, 25], "claude-sonnet-5-5": [3, 15], "claude-haiku-5-5": [1, 5],
};
const priceFor = (model) => PRICES[Object.keys(PRICES).find((k) => String(model).startsWith(k))] || [0, 0];

export const DAILY_PLATFORM_CALLS = 300; // per workspace per day on platform keys
export const PER_MINUTE = 20; // per user, any key: stops runaway loops and scripts

export async function checkLimits(env, ai, ctx) {
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const dayStart = new Date().toISOString().slice(0, 10);
  const [perUser, perDay] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM usage WHERE user_id = ?1 AND created_at > ?2").bind(ctx.user.id || 0, minuteAgo),
    env.DB.prepare("SELECT COUNT(*) AS n FROM usage WHERE account_id = ?1 AND own_key = 0 AND created_at >= ?2").bind(ctx.accountId, dayStart),
  ]);
  if (perUser.results[0].n >= PER_MINUTE) throw err(429, "That's a lot of requests in a minute. Give it a moment.");
  if (!ai.ownKey && perDay.results[0].n >= DAILY_PLATFORM_CALLS)
    throw err(429, `Your workspace has used today's ${DAILY_PLATFORM_CALLS} included AI calls. Connect your own Anthropic key under Settings → Integrations for unlimited use.`);
}

export async function record(env, ai, ctx, feature, out) {
  if (!out?.usage) return;
  await env.DB.prepare("INSERT INTO usage (account_id, user_id, feature, model, input_tokens, output_tokens, cached_tokens, own_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(ctx.accountId, ctx.user.id || null, feature, String(out.model || "?"), out.usage.input | 0, out.usage.output | 0, out.usage.cached | 0, ai.ownKey ? 1 : 0, new Date().toISOString())
    .run().catch((e) => console.warn("usage record failed", e.message));
}

// Metered features with no token counts (voice): check the limits, then count one call.
export async function meter(env, ai, ctx, feature, ownKey = ai.ownKey) {
  await checkLimits(env, { ...ai, ownKey }, ctx);
  await record(env, { ...ai, ownKey }, ctx, feature, { model: feature, usage: { input: 0, output: 0, cached: 0 } });
}

export async function summary(env, ctx, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const dayStart = new Date().toISOString().slice(0, 10);
  const [byFeature, byDay, today] = await env.DB.batch([
    env.DB.prepare(`SELECT feature, model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cached_tokens) AS cached, SUM(own_key) AS own
      FROM usage WHERE account_id = ?1 AND created_at >= ?2 GROUP BY feature, model ORDER BY calls DESC`).bind(ctx.accountId, since),
    env.DB.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS calls FROM usage WHERE account_id = ?1 AND created_at >= ?2 GROUP BY day ORDER BY day").bind(ctx.accountId, since),
    env.DB.prepare("SELECT COUNT(*) AS n FROM usage WHERE account_id = ?1 AND own_key = 0 AND created_at >= ?2").bind(ctx.accountId, dayStart),
  ]);
  const rows = byFeature.results.map((r) => {
    const [pin, pout] = priceFor(r.model);
    // Cache reads bill at a tenth of the input price.
    const cost = ((r.input || 0) * pin + (r.cached || 0) * pin * 0.1 + (r.output || 0) * pout) / 1e6;
    return { ...r, cost: Math.round(cost * 100) / 100 };
  });
  return {
    days, rows, byDay: byDay.results,
    totals: rows.reduce((t, r) => ({ calls: t.calls + r.calls, input: t.input + (r.input || 0), output: t.output + (r.output || 0), cached: t.cached + (r.cached || 0), cost: Math.round((t.cost + r.cost) * 100) / 100 }), { calls: 0, input: 0, output: 0, cached: 0, cost: 0 }),
    platformToday: today.results[0].n, platformDailyLimit: DAILY_PLATFORM_CALLS,
  };
}
