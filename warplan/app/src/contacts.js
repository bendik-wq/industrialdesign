// Contacts per target: what the contact finder discovered, plus anything typed in. The best email and phone are
// copied onto the target itself when it has none yet.
import { findContacts } from "./enrich.js";
import { getTarget } from "./pipeline.js";

const now = () => new Date().toISOString();

export async function listContacts(env, ctx, targetId) {
  const { results } = await env.DB.prepare("SELECT id, kind, value, label, source, confidence, created_at FROM contacts WHERE account_id = ?1 AND target_id = ?2 ORDER BY CASE WHEN label LIKE '%(owner)%' AND confidence != 'guess' THEN 0 WHEN kind = 'email' AND confidence != 'guess' THEN 1 WHEN kind = 'phone' THEN 2 ELSE 3 END, CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id").bind(ctx.accountId, targetId).all();
  return results;
}

export async function enrichTarget(env, ctx, targetId, keys) {
  const t = await getTarget(env, ctx, targetId);
  const r = await findContacts(t, keys);
  const stamp = now();
  const stmts = r.contacts.map((c) => env.DB.prepare("INSERT OR IGNORE INTO contacts (account_id, target_id, kind, value, label, source, confidence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(ctx.accountId, t.id, c.kind, c.value, c.label || "", c.source || "", c.confidence || "medium", stamp));
  const bestEmail = (r.contacts.find((c) => c.owner) || r.contacts.find((c) => c.kind === "email" && c.confidence !== "guess"))?.value;
  const bestPhone = r.contacts.find((c) => c.kind === "phone")?.value;
  stmts.push(env.DB.prepare("UPDATE targets SET email = CASE WHEN email = '' AND ?3 IS NOT NULL THEN ?3 ELSE email END, phone = CASE WHEN phone = '' AND ?4 IS NOT NULL THEN ?4 ELSE phone END, website = CASE WHEN website = '' AND ?5 != '' THEN ?5 ELSE website END, updated_at = ?6 WHERE id = ?1 AND account_id = ?2")
    .bind(t.id, ctx.accountId, bestEmail || null, bestPhone || null, r.domain && !t.website ? `https://${r.domain}` : "", stamp));
  const emails = r.contacts.filter((c) => c.kind === "email" && c.confidence !== "guess").length, phones = r.contacts.filter((c) => c.kind === "phone").length, guesses = r.contacts.filter((c) => c.confidence === "guess").length;
  stmts.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6)")
    .bind(ctx.accountId, t.id, ctx.user.id || null, ctx.user.name || ctx.user.email, `Contact finder: ${emails} email${emails === 1 ? "" : "s"}, ${phones} phone${phones === 1 ? "" : "s"}${guesses ? `, ${guesses} guessed owner address${guesses === 1 ? "" : "es"}` : ""}${r.pages.length ? ` (read ${r.pages.length} page${r.pages.length === 1 ? "" : "s"} of ${r.domain})` : t.website ? " (the website didn't load)" : " (no website on file)"}.`, stamp));
  await env.DB.batch(stmts);
  return { target_id: t.id, domain: r.domain, pages: r.pages, found: r.contacts, receipt: `Found ${emails} email${emails === 1 ? "" : "s"} and ${phones} phone${phones === 1 ? "" : "s"} for ${t.name}${guesses ? ` (+${guesses} guessed owner addresses)` : ""}` };
}

export async function addContact(env, ctx, targetId, b) {
  await getTarget(env, ctx, targetId);
  const kind = b.kind === "phone" ? "phone" : "email";
  const value = String(b.value || "").trim().slice(0, 200);
  if (!value) throw Object.assign(new Error("Enter the email or phone"), { status: 400 });
  await env.DB.prepare("INSERT OR IGNORE INTO contacts (account_id, target_id, kind, value, label, source, confidence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'Added by hand', 'high', ?6)")
    .bind(ctx.accountId, targetId, kind, kind === "email" ? value.toLowerCase() : value, String(b.label || "").slice(0, 100), now()).run();
  return listContacts(env, ctx, targetId);
}

export async function deleteContact(env, ctx, targetId, id) {
  await env.DB.prepare("DELETE FROM contacts WHERE id = ?1 AND target_id = ?2 AND account_id = ?3").bind(id, targetId, ctx.accountId).run();
  return { ok: true };
}
