// Mailbox rotation for bots: spread each day's emails across the sending mailboxes a bot may use (the sender's own
// mailbox and any in the workspace's pool), never above a mailbox's daily cap or warm-up ramp. A prospect always
// hears from the same mailbox (stored on the prospect), so the thread stays in one place; if that mailbox is full
// today, the follow-up waits a day instead of switching sender.
import { warmCap } from "./mailer.js";

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const day = () => new Date().toISOString().slice(0, 10);

export async function rotation(env, bot, ctx) {
  const wanted = (json(bot.mailboxes, ["main"]) || ["main"]).map(String);
  const boxes = new Map();
  if (wanted.includes("main")) {
    const main = await env.DB.prepare("SELECT email, daily_limit FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id || 0).first();
    if (main) {
      const sent = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sent_emails WHERE user_id = ?1 AND status = 'sent' AND pool_id IS NULL AND created_at >= ?2").bind(ctx.user.id, day()).first()).n;
      boxes.set("main", { key: "main", pool_id: null, email: main.email, left: Math.max(0, main.daily_limit - sent) });
    }
  }
  const ids = wanted.filter((k) => /^\d+$/.test(k)).map(Number);
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT * FROM mailbox_pool WHERE account_id = ?1 AND active = 1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`).bind(bot.account_id, ...ids).all();
    for (const r of results) {
      const sent = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sent_emails WHERE pool_id = ?1 AND status = 'sent' AND created_at >= ?2").bind(r.id, day()).first()).n;
      boxes.set(String(r.id), { key: String(r.id), pool_id: r.id, email: r.email, left: Math.max(0, warmCap(r) - sent) });
    }
  }
  return {
    size: boxes.size,
    left: () => [...boxes.values()].reduce((n, b) => n + b.left, 0),
    // The mailbox for a send: the prospect's own one if it still exists (or "wait" when it's full today), else the
    // one with the most room left. null when every mailbox is full.
    pick(pref) {
      if (pref && boxes.has(pref)) return boxes.get(pref).left > 0 ? boxes.get(pref) : "wait";
      let best = null;
      for (const b of boxes.values()) if (b.left > 0 && (!best || b.left > best.left)) best = b;
      return best;
    },
    used(b) { if (b && boxes.has(b.key)) boxes.get(b.key).left--; },
    full(b) { if (b && boxes.has(b.key)) boxes.get(b.key).left = 0; },
  };
}
