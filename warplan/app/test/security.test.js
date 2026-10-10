import { test } from "node:test";
import assert from "node:assert/strict";
import { publicUrl } from "../src/net.js";

test("outbound URLs: public hosts only", () => {
  for (const bad of ["https://169.254.169.254/latest", "http://127.0.0.1", "http://2130706433/", "http://0x7f.1/", "http://[::1]/", "https://localhost/x", "https://db.internal/", "http://intranet/", "https://user:pw@example.com/", "https://example.com:22/", "javascript:alert(1)", "file:///etc/passwd"])
    assert.equal(publicUrl(bad), null, bad);
  assert.equal(publicUrl("http://example.com", { httpsOnly: true }), null);
  for (const ok of ["https://hooks.zapier.com/abc", "http://www.capitalcityheating.com/", "https://example.co.uk:443/x"]) assert.ok(publicUrl(ok), ok);
});

import { forbidden } from "../src/monid.js";
test("no AI or automated outbound calls through Monid", () => {
  for (const [p, e] of [["saperly", "/place-calls"], ["saperly", "/provision-numbers"], ["blockrun.ai", "/api/v1/voice/call"], ["bland.ai", "/v1/calls"], ["anything", "/ringless-voicemail"], ["saperly", "/send-messages"]]) assert.ok(forbidden(p, e), `${p} ${e}`);
  for (const [p, e] of [["agentmail", "/send-messages"], ["recall", "/meetings/record"], ["hunterio", "/email-finder"], ["dataforseo", "/google-business/reviews"]]) assert.equal(forbidden(p, e), null, `${p} ${e}`);
});
