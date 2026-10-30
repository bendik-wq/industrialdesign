#!/usr/bin/env bash
# Usage: deploy.sh <worker> <enforce|report>
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Downloads the live worker, wraps it with secure.js and
# re-uploads it keeping every binding, secret and static asset. Re-running is safe: an already-wrapped worker is
# unwrapped first (the original module is kept as-is inside the bundle).
set -euo pipefail
W=$1; MODE=$2; HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d)
API=https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$W
curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/content/v2" -D "$T/hdr" -o "$T/raw"
curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/settings" -o "$T/settings.json"
python3 -I "$HERE/build.py" "$T" "$W" "$MODE" "$HERE/secure.js"
curl -s -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API" $(cat "$T/form-args") | python3 -I -c "import json,sys; j=json.load(sys.stdin); print('deployed' if j['success'] else j['errors'])"
rm -rf "$T"
