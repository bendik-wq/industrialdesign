import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, ownerGuesses } from "../src/enrich.js";
import { buildMessage, composeBody } from "../src/mailer.js";

test("contact extraction: mailto, obfuscated, cloudflare-protected, tel and labelled phones", () => {
  const cf = (email) => { const key = 0x42; return key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join(""); };
  const html = `<a href="mailto:Post@Firma.no?subject=hi">x</a> <a data-cfemail="${cf("eier@firma.no")}">[email protected]</a>
    ola [at] firma [dot] no · logo@2x.png · noreply@firma.no <a href="tel:+47%2022%2033%2044%2055">ring</a> Tlf: 22 33 44 55 · Telefon: 900 11 222
    <a href="/kontakt">Kontakt</a> <a href="https://other.com/contact">x</a>`;
  const r = extract(html, "https://firma.no/");
  assert.deepEqual([...r.emails.keys()].sort(), ["eier@firma.no", "ola@firma.no", "post@firma.no"]);
  assert.equal(r.phones.size, 2, [...r.phones.keys()].join(" / ")); // +47 22 33 44 55 deduplicated with 22 33 44 55
  assert.deepEqual(r.links, ["https://firma.no/kontakt"]);
});

test("owner email guesses handle Nordic letters and need a full name", () => {
  assert.deepEqual(ownerGuesses("Bjørn Ødegård", "firma.no").slice(0, 2), ["bjorn@firma.no", "bjorn.odegard@firma.no"]);
  assert.deepEqual(ownerGuesses("Cher", "firma.no"), []);
  assert.deepEqual(ownerGuesses("Ola Nordmann", ""), []);
});

test("email body gets the signature, an opt-out line and the postal address", () => {
  const b = composeBody("Hi Frank,\n\nCould we talk?", { signature: "Bendik\nAsym Capital", postal_address: "Storgata 1, 0155 Oslo" });
  assert.match(b, /^Hi Frank/);
  assert.match(b, /Bendik\nAsym Capital/);
  assert.match(b, /no thanks/);
  assert.match(b, /Storgata 1, 0155 Oslo$/);
});

test("MIME message: encoded UTF-8 subject and name, both parts base64, list-unsubscribe", () => {
  const raw = buildMessage({ from: "bendik@asym.capital", fromName: "Bendik Ø", to: "eier@firma.no", subject: "Spørsmål om Firma AS", text: "Hei!\n\nÆ Ø Å", messageId: "<x@asym.capital>", unsubscribe: "bendik@asym.capital" });
  assert.match(raw, /^From: =\?UTF-8\?B\?.+\?= <bendik@asym\.capital>\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?.+\?=\r\n/);
  assert.match(raw, /List-Unsubscribe: <mailto:bendik@asym\.capital\?subject=unsubscribe>/);
  assert.equal((raw.match(/Content-Transfer-Encoding: base64/g) || []).length, 2);
  const textPart = raw.split("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0];
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(textPart.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))), "Hei!\n\nÆ Ø Å");
  assert.ok(raw.split("\r\n").every((l) => l.length <= 998), "SMTP line length");
});
