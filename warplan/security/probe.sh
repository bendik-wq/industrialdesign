#!/usr/bin/env bash
# Non-destructive black-box checks of the live Warplan and funnel Workers. No credentials needed or used.
# Usage: bash probe.sh [base-url]   Exit code 1 if any check fails.
B="${1:-https://warplan.bendik-50e.workers.dev}"; FUN="https://data-vsl.bendik-50e.workers.dev"; fails=0
ok() { printf "  ok    %s\n" "$1"; }; bad() { printf "  FAIL  %s\n" "$1"; fails=$((fails+1)); }
h=$(curl -sI "$B/login")
for x in content-security-policy strict-transport-security x-frame-options x-content-type-options referrer-policy permissions-policy; do echo "$h" | grep -qi "^$x:" && ok "header $x" || bad "header $x missing"; done
echo "$h" | grep -qi "script-src 'self';" && ok "CSP script-src self only" || bad "CSP script-src not strict"
for p in /api/targets /api/runs /api/findings /api/inbox /api/usage /api/integrations /api/board/suggestions /mcp /api; do
  c=$(curl -s -o /dev/null -w "%{http_code}" "$B$p"); [ "$c" = 401 ] && ok "unauthenticated $p → 401" || bad "unauthenticated $p → $c"; done
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/login" -H "Origin: https://evil.example" -H "Content-Type: application/json" -d '{}'); [ "$c" = 403 ] && ok "cross-origin POST refused" || bad "cross-origin POST → $c"
b=$(curl -s -X POST "$B/api/login" -H "Origin: $B" -H "Content-Type: application/json" -d '{bad'); echo "$b" | grep -qiE "stack|at .*\.js|TypeError|SyntaxError" && bad "error body leaks internals: $b" || ok "malformed JSON handled without leaking"
for f in /.dev.vars /schema.sql /src/index.js /wrangler.jsonc /js/app.js.map /.git/config; do c=$(curl -s -o /dev/null -w "%{http_code}" "$B$f"); [[ "$c" =~ ^(302|401|403|404)$ ]] && ok "no $f ($c)" || bad "$f served ($c)"; done
c=$(curl -s "$B/hooks/room/$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)"); echo "$c" | grep -q "isn't valid" && ok "random seller token rejected" || bad "seller token check: $c"
fh=$(curl -sI "$FUN/"); for x in content-security-policy x-frame-options strict-transport-security; do echo "$fh" | grep -qi "^$x:" && ok "funnel header $x" || bad "funnel header $x missing"; done
c=$(curl -s -o /dev/null -w "%{http_code}" "$FUN/admin/leads.csv"); [ "$c" = 401 ] && ok "funnel admin needs login" || bad "funnel admin → $c"
echo; [ $fails = 0 ] && echo "All checks passed" || echo "$fails check(s) failed"; exit $((fails > 0))
