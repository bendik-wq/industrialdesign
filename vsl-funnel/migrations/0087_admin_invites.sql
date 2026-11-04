-- Guest access to Funnel HQ (src/admin/guest.ts): the owner makes a link for one person, that person opens
-- Funnel HQ read-only without the admin password, and the owner can revoke it at any time.
-- Only a SHA-256 hash of the link's secret is stored; the link itself is shown once, when it is made.
-- Additive only.
CREATE TABLE IF NOT EXISTS admin_invites (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,               -- who it is for, in the owner's words
  role          TEXT NOT NULL DEFAULT 'viewer', -- viewer (read-only); the only role today
  mask_pii      INTEGER NOT NULL DEFAULT 1,  -- 1 = names shortened, emails / phones masked, notes and transcripts hidden
  token_hash    TEXT NOT NULL UNIQUE,        -- hex SHA-256 of the secret in the link
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER,
  uses          INTEGER NOT NULL DEFAULT 0   -- sign-ins through the link plus Funnel HQ page loads
);
CREATE INDEX IF NOT EXISTS idx_admin_invites_active ON admin_invites(revoked_at, expires_at);

-- Every request a guest makes (method and path only, never bodies or query strings; the IP as a keyed hash).
CREATE TABLE IF NOT EXISTS admin_invite_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id  TEXT NOT NULL,
  at         INTEGER NOT NULL,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER,
  ip_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_invite_log_invite ON admin_invite_log(invite_id, at);
