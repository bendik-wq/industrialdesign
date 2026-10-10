// Send email from the user's own mailbox, so it comes from their address and lands in their Sent folder.
// SMTP over a TCP socket (cloudflare:sockets): Gmail / Google Workspace with an app password, Microsoft 365, or any
// SMTP host. Safeguards on every send: the suppression list, a per-user daily cap, an opt-out line, the sender's
// postal address (CAN-SPAM), and a record on the target's timeline.
import { seal, open } from "./keys.js";
import { run as monidRun } from "./monid.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const aad = (userId) => `mailbox:${userId}`;

export const PRESETS = {
  gmail: { label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 465, help: "Use an app password: myaccount.google.com → Security → 2-Step Verification (must be on) → App passwords → create one called Warplan. Your normal password won't work." },
  outlook: { label: "Microsoft 365 / Outlook", host: "smtp.office365.com", port: 587, help: "Needs SMTP AUTH enabled for your mailbox (Microsoft 365 admin → user → Mail → Manage email apps → Authenticated SMTP), then your password or an app password." },
  custom: { label: "Other (SMTP)", host: "", port: 465, help: "Your provider's SMTP host and port (465 = TLS, 587 = STARTTLS) and the login for the mailbox." },
};

// ------------------------------------------------------------------ SMTP client
class Smtp {
  constructor(socket) { this.setSocket(socket); this.buf = ""; }
  setSocket(socket) { this.socket = socket; this.reader = socket.readable.getReader(); this.writer = socket.writable.getWriter(); this.dec = new TextDecoder(); this.enc = new TextEncoder(); }
  async read() {
    // A reply is one or more lines "250-..." ending with "250 ...".
    const lines = [];
    for (;;) {
      let i;
      while ((i = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: +line.slice(0, 3), text: lines.join("\n") };
      }
      const { value, done } = await this.reader.read();
      if (done) throw err(502, "The mail server closed the connection");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async cmd(line, expect) {
    await this.writer.write(this.enc.encode(`${line}\r\n`));
    const r = await this.read();
    if (expect && !expect.includes(r.code)) throw Object.assign(err(502, smtpMessage(r)), { smtp: r.code });
    return r;
  }
  async close() { try { await this.writer.write(this.enc.encode("QUIT\r\n")); } catch { /* already closed */ } try { await this.socket.close(); } catch { /* already closed */ } }
}
function smtpMessage(r) {
  const t = r.text.replace(/^\d{3}[- ]/gm, "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (r.code === 535 || r.code === 534) return /gmail|google/i.test(t) || /Application-specific password/i.test(t) ? "Google rejected the login. Use an app password (not your normal password) and check 2-Step Verification is on." : `The mail server rejected the login: ${t}`;
  if (r.code === 550 || r.code === 553) return `The mail server refused that address: ${t}`;
  return `Mail server error ${r.code}: ${t}`;
}

export async function session(box, password, fn) {
  const secure = box.port === 465;
  const { connect } = await import("cloudflare:sockets"); // Workers-only; loaded lazily so the module is testable in Node
  let socket;
  try { socket = connect({ hostname: box.host, port: box.port }, { secureTransport: secure ? "on" : "starttls", allowHalfOpen: false }); }
  catch (e) { throw err(502, `Couldn't reach ${box.host}:${box.port}`); }
  const s = new Smtp(socket);
  const timer = setTimeout(() => { s.socket.close().catch(() => {}); socket.close().catch(() => {}); }, 25000);
  try {
    let r;
    try { r = await s.read(); } catch (e) { throw err(502, `Couldn't connect to ${box.host}:${box.port}. Check the host and port.`); }
    if (r.code !== 220) throw err(502, smtpMessage(r));
    let ehlo = await s.cmd("EHLO warplan.app", [250]);
    if (!secure) {
      await s.cmd("STARTTLS", [220]);
      // The plain-text streams must be released before upgrading the connection.
      s.reader.releaseLock(); s.writer.releaseLock();
      s.buf = "";
      s.setSocket(socket.startTls());
      ehlo = await s.cmd("EHLO warplan.app", [250]);
    }
    // Use PLAIN when offered, otherwise LOGIN (Microsoft 365 only offers LOGIN/XOAUTH2).
    const authLine = ehlo.text.split("\n").find((l) => /AUTH/i.test(l)) || "";
    if (/\bPLAIN\b/i.test(authLine) || !/\bLOGIN\b/i.test(authLine)) {
      await s.cmd(`AUTH PLAIN ${b64(`\u0000${box.username}\u0000${password}`)}`, [235]);
    } else {
      await s.cmd("AUTH LOGIN", [334]);
      await s.cmd(b64(box.username), [334]);
      await s.cmd(b64(password), [235]);
    }
    return await fn(s);
  } catch (e) {
    if (e.status) throw e;
    throw err(502, `The mail server connection failed (${String(e.message || e).slice(0, 120)}). Try again.`);
  } finally {
    clearTimeout(timer);
    await s.close();
  }
}

// ------------------------------------------------------------------ MIME
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const wrap76 = (s) => s.replace(/(.{76})/g, "$1\r\n");
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const htmlEsc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export function buildMessage({ from, fromName, to, subject, text, messageId, unsubscribe }) {
  const boundary = `wp_${crypto.randomUUID()}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111">${text.split(/\n{2,}/).map((p) => `<p>${htmlEsc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>`;
  const headers = [
    `From: ${fromName ? `${encHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...(unsubscribe ? [`List-Unsubscribe: <mailto:${unsubscribe}?subject=unsubscribe>`] : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(b64(body))].join("\r\n");
  return [...headers, "", part("text/plain", text), part("text/html", html), `--${boundary}--`, ""].join("\r\n");
}

async function smtpSend(box, password, to, raw) {
  return session(box, password, async (s) => {
    await s.cmd(`MAIL FROM:<${box.email}>`, [250]);
    await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await s.cmd("DATA", [354]);
    const dotted = raw.replace(/\r\n\./g, "\r\n..");
    await s.writer.write(s.enc.encode(`${dotted}\r\n.\r\n`));
    const r = await s.read();
    if (r.code !== 250) throw err(502, smtpMessage(r));
    return r.text;
  });
}

// ------------------------------------------------------------------ mailbox settings
const cleanEmail = (e) => { const s = String(e || "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : ""; };

// A Warplan-managed inbox (AgentMail through Monid, about $1 a month): send without an app password, and replies
// are read back automatically into reply triage.
export async function createAgentInbox(env, ctx, b) {
  if (!ctx.user.id) throw err(400, "Mailboxes belong to a signed-in user");
  const username = String(b.username || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || undefined;
  const name = String(b.from_name || ctx.user.name || "").trim().slice(0, 80);
  const r = await monidRun(env, ctx, { provider: "agentmail", endpoint: "/create-inboxes", input: { body: { ...(username && { username }), ...(name && { displayName: name }) } } }, { purpose: "Create email inbox" });
  const inbox = r.output?.email || r.output?.inboxId || r.output?.inbox_id;
  if (!inbox) throw err(502, "The inbox couldn't be created. Try another name.");
  await env.DB.prepare(`INSERT INTO mailboxes (user_id, account_id, email, from_name, host, port, username, ciphertext, iv, signature, postal_address, daily_limit, verified_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'agentmail', 0, ?3, '', '', ?5, ?6, 100, ?7, ?7)
    ON CONFLICT (user_id) DO UPDATE SET email = ?3, from_name = ?4, host = 'agentmail', port = 0, username = ?3, ciphertext = '', iv = '', verified_at = ?7, updated_at = ?7`)
    .bind(ctx.user.id, ctx.accountId, inbox, name, String(b.signature || "").slice(0, 1000), String(b.postal_address || "").slice(0, 300), now()).run();
  return { ok: true, email: inbox, receipt: `Your inbox ${inbox} is ready` };
}

// Read new replies in AgentMail inboxes and hand them to reply triage (same path as sequencer replies).
export async function syncAgentInboxes(env, accountId = null, triage) {
  const { results } = await env.DB.prepare("SELECT m.user_id, m.account_id, m.email, m.updated_at, a.name AS account_name, u.name, u.email AS user_email, u.role FROM mailboxes m JOIN accounts a ON a.id = m.account_id AND a.active = 1 JOIN users u ON u.id = m.user_id WHERE m.host = 'agentmail' AND (?1 IS NULL OR m.account_id = ?1) LIMIT 200").bind(accountId).all();
  let replies = 0;
  for (const box of results) {
    const ctx = { accountId: box.account_id, user: { id: box.user_id, name: box.name, email: box.user_email, role: box.role } };
    const since = (await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = ?2").bind(box.account_id, `agentmail:${box.user_id}`).first())?.data;
    const after = since ? JSON.parse(since).after : box.updated_at;
    try {
      const r = await monidRun(env, ctx, { provider: "agentmail", endpoint: "/list-messages", input: { body: { inboxId: box.email, after, ascending: true, limit: 50 } } }, { purpose: "Check inbox" });
      const msgs = r.output?.messages || r.output?.data || [];
      let last = after;
      for (const m of msgs) {
        const from = String(m.from || m.from_ || "").match(/[^\s<>"]+@[^\s<>"]+/)?.[0]?.toLowerCase();
        last = m.timestamp || m.created_at || last;
        if (!from || from === box.email.toLowerCase()) continue;
        await triage(env, { account_id: box.account_id, account_name: box.account_name }, { lead_email: from, subject: m.subject || "", reply_text: m.text || m.extracted_text || m.preview || "" }, "agentmail");
        replies++;
      }
      await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (account_id, key) DO UPDATE SET data = ?3, updated_at = ?4").bind(box.account_id, `agentmail:${box.user_id}`, JSON.stringify({ after: last }), now()).run();
    } catch (e) { console.warn("agentmail sync", box.email, e.message); }
  }
  return { inboxes: results.length, replies };
}

export async function getMailbox(env, ctx) {
  const m = await env.DB.prepare("SELECT email, from_name, host, port, username, signature, postal_address, daily_limit, verified_at, updated_at FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id || 0).first();
  if (!m) return { connected: false, presets: PRESETS };
  const sentToday = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sent_emails WHERE user_id = ?1 AND status = 'sent' AND created_at >= ?2").bind(ctx.user.id, now().slice(0, 10)).first()).n;
  return { connected: true, ...m, sentToday, presets: PRESETS };
}

export async function saveMailbox(env, ctx, b) {
  if (!ctx.user.id) throw err(400, "Mailboxes belong to a signed-in user");
  const existing = await env.DB.prepare("SELECT * FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id).first();
  const preset = PRESETS[b.preset] || null;
  const email = cleanEmail(b.email || existing?.email || ctx.user.email);
  if (!email) throw err(400, "Enter the email address to send from");
  const host = String(b.host || preset?.host || existing?.host || "").trim().toLowerCase();
  const port = Number(b.port || preset?.port || existing?.port || 465);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw err(400, "Enter the SMTP host");
  if (![465, 587, 2525].includes(port)) throw err(400, "Use port 465 (TLS) or 587 (STARTTLS)");
  const username = String(b.username || existing?.username || email).trim();
  const password = String(b.password || "").replace(/\s+/g, ""); // Google shows app passwords in groups of four
  let sealed = existing ? { ciphertext: existing.ciphertext, iv: existing.iv } : null;
  if (password) sealed = await seal(env, password, aad(ctx.user.id));
  if (!sealed) throw err(400, "Enter the app password");
  const box = { email, host, port, username };
  // Prove the login works before saving it.
  await session(box, password || (await open(env, existing, aad(ctx.user.id))), async () => true);
  await env.DB.prepare(`INSERT INTO mailboxes (user_id, account_id, email, from_name, host, port, username, ciphertext, iv, signature, postal_address, daily_limit, verified_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
    ON CONFLICT (user_id) DO UPDATE SET email = ?3, from_name = ?4, host = ?5, port = ?6, username = ?7, ciphertext = ?8, iv = ?9, signature = ?10, postal_address = ?11, daily_limit = ?12, verified_at = ?13, updated_at = ?13`)
    .bind(ctx.user.id, ctx.accountId, email, String(b.from_name ?? existing?.from_name ?? ctx.user.name ?? "").slice(0, 80), host, port, username, sealed.ciphertext, sealed.iv,
      String(b.signature ?? existing?.signature ?? "").slice(0, 1000), String(b.postal_address ?? existing?.postal_address ?? "").slice(0, 300), Math.min(200, Math.max(1, +b.daily_limit || existing?.daily_limit || 40)), now()).run();
  return getMailbox(env, ctx);
}

export async function deleteMailbox(env, ctx) {
  await env.DB.prepare("DELETE FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id || 0).run();
  return { ok: true };
}

// ------------------------------------------------------------------ sending
export function composeBody(text, box) {
  const parts = [text.trim()];
  if (box.signature) parts.push(box.signature.trim());
  parts.push(`If you'd rather not hear from me again, just reply "no thanks" and I won't write again.${box.postal_address ? `\n${box.postal_address}` : ""}`);
  return parts.join("\n\n");
}

export async function sendEmail(env, ctx, b, hooks) {
  const box = await env.DB.prepare("SELECT * FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id || 0).first();
  if (!box) throw err(400, "Connect your mailbox first: Settings → Email");
  const to = cleanEmail(b.to);
  if (!to) throw err(400, "That recipient address doesn't look right");
  const subject = String(b.subject || "").trim().slice(0, 200);
  const text = String(b.body || "").trim().slice(0, 20000);
  if (!subject || !text) throw err(400, "Write a subject and a message");
  if (await env.DB.prepare("SELECT 1 FROM suppressions WHERE account_id = ?1 AND email = ?2").bind(ctx.accountId, to).first()) throw err(409, `${to} asked not to be contacted. Remove them from the do-not-contact list first if that's wrong.`);
  const sentToday = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sent_emails WHERE user_id = ?1 AND status = 'sent' AND created_at >= ?2").bind(ctx.user.id, now().slice(0, 10)).first()).n;
  if (sentToday >= box.daily_limit) throw err(429, `You've sent your ${box.daily_limit} emails for today. Cold email from a personal mailbox goes to spam fast above that; raise the cap in Settings → Email if you're sure.`);
  let target = null;
  if (b.target_id) {
    target = await env.DB.prepare("SELECT id, name, stage, email FROM targets WHERE id = ?1 AND account_id = ?2").bind(+b.target_id, ctx.accountId).first();
    if (!target) throw err(404, "Target not found");
  }
  const body = composeBody(text, box);
  const messageId = `<${crypto.randomUUID()}@${box.email.split("@")[1]}>`;
  const raw = buildMessage({ from: box.email, fromName: box.from_name, to, subject, text: body, messageId, unsubscribe: box.email });
  let status = "sent", error = null;
  try {
    if (box.host === "agentmail") await monidRun(env, ctx, { provider: "agentmail", endpoint: "/send-messages", input: { body: { inboxId: box.username, to: [to], subject, text: body, headers: { "List-Unsubscribe": `<mailto:${box.email}?subject=unsubscribe>` } } } }, { purpose: `Email to ${to}`, targetId: target?.id || null });
    else await smtpSend(box, await open(env, box, aad(ctx.user.id)), to, raw);
  }
  catch (e) { status = "failed"; error = e.status ? e.message : "Sending failed"; if (!e.status) console.error("smtp", e); }
  const stamp = now();
  const writes = [env.DB.prepare("INSERT INTO sent_emails (account_id, user_id, target_id, to_email, subject, body, status, error, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")
    .bind(ctx.accountId, ctx.user.id, target?.id || null, to, subject, body, status, error, messageId, stamp)];
  if (target && status === "sent") {
    writes.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'email', ?5, ?6)")
      .bind(ctx.accountId, target.id, ctx.user.id, ctx.user.name || ctx.user.email, `Emailed ${to}: “${subject}”\n\n${text.slice(0, 1500)}`, stamp));
    writes.push(env.DB.prepare("UPDATE targets SET email = CASE WHEN email = '' THEN ?3 ELSE email END, stage = CASE WHEN stage = 'sourced' THEN 'contacted' ELSE stage END, stage_at = CASE WHEN stage = 'sourced' THEN ?4 ELSE stage_at END, updated_at = ?4 WHERE id = ?1 AND account_id = ?2")
      .bind(target.id, ctx.accountId, to, stamp));
  }
  await env.DB.batch(writes);
  if (status === "failed") throw err(502, error);
  hooks?.emit("email.sent", { target_id: target?.id || null, to, subject });
  return { ok: true, to, subject, receipt: `Emailed ${to} from ${box.email}` };
}

export async function listSent(env, ctx, targetId) {
  const { results } = await env.DB.prepare("SELECT id, target_id, to_email, subject, status, error, created_at FROM sent_emails WHERE account_id = ?1 AND (?2 IS NULL OR target_id = ?2) ORDER BY id DESC LIMIT 100").bind(ctx.accountId, targetId || null).all();
  return results;
}

export async function suppress(env, ctx, email, reason = "") {
  const e = cleanEmail(email);
  if (!e) throw err(400, "Enter an email address");
  await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, ?3, ?4)").bind(ctx.accountId, e, String(reason).slice(0, 200), now()).run();
  return { ok: true };
}
export async function listSuppressions(env, ctx) {
  return (await env.DB.prepare("SELECT email, reason, created_at FROM suppressions WHERE account_id = ?1 ORDER BY created_at DESC").bind(ctx.accountId).all()).results;
}
export async function unsuppress(env, ctx, email) {
  await env.DB.prepare("DELETE FROM suppressions WHERE account_id = ?1 AND email = ?2").bind(ctx.accountId, cleanEmail(email)).run();
  return { ok: true };
}
