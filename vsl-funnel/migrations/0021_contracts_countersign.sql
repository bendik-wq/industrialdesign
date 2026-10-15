-- Our side signs before sending (countersignature), test sends, and contracts not tied to a lead.
ALTER TABLE contracts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD COLUMN our_signer TEXT;
ALTER TABLE contracts ADD COLUMN our_signature TEXT;
ALTER TABLE contracts ADD COLUMN our_signature_kind TEXT;
ALTER TABLE contracts ADD COLUMN our_signed_at INTEGER;
ALTER TABLE contracts ADD COLUMN our_signer_ip TEXT;
