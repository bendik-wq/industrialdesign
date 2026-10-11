import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, pickPages, lines } from "../src/watch.js";

const before = `# Welcome to Belmont Physio
We have looked after Geelong families since 1998. Our principal physiotherapist Carey Wheeler leads a team of six.
Book online or call us on 03 5243 0919 to make an appointment today.
© 2025 Belmont Physio. All rights reserved.`;

test("first look: only the strong phrases already on the site count", () => {
  assert.deepEqual(detect("", before), []);
  const s = detect("", `${before}\nAfter 26 wonderful years, Carey is planning to retire at the end of next year and we are looking for the right person to take over.`);
  assert.deepEqual(s.map((x) => x.kind).sort(), ["farewell", "for_sale", "retirement"]);
});

test("a change: new retirement text and the owner's name disappearing are signals; copyright and menu noise are not", () => {
  const after = before.replace("© 2025", "© 2026").replace("Our principal physiotherapist Carey Wheeler leads a team of six.", "Our team of six physiotherapists is led by Sam Ng.") + "\nWe are hiring an experienced Practice Manager to join our team in Belmont this year.";
  const kinds = detect(before, after, { ownerName: "Carey Wheeler" }).map((x) => x.kind).sort();
  assert.deepEqual(kinds, ["hiring_manager", "owner_gone"]);
  assert.deepEqual(detect(before, before.replace("© 2025", "© 2026"), { ownerName: "Carey Wheeler" }), []);
});

test("sold already: 'now part of X group' is flagged as a negative signal", () => {
  const s = detect(before, `${before}\nBelmont Physio is now part of the Healthia Physiotherapy Group, bringing more services to Geelong.`);
  assert.equal(s[0].kind, "new_owner"); assert.equal(s[0].strength, -1);
});

test("which pages to watch: home plus about/team pages on the same site", () => {
  const p = pickPages("https://belmontphysio.com.au/", ["https://belmontphysio.com.au/about-us/", "https://belmontphysio.com.au/contact", "https://facebook.com/belmont/about", "https://www.belmontphysio.com.au/our-team#top", "https://belmontphysio.com.au/blog/post-1"]);
  assert.deepEqual(p, ["https://belmontphysio.com.au/", "https://belmontphysio.com.au/about-us", "https://www.belmontphysio.com.au/our-team"]);
  assert.ok(lines("Home\nAbout\nThis is a sentence long enough to count as content.").length === 1);
});
