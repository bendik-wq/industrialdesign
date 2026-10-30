import sys, json, email, os
from email import policy
T, W, MODE, SECURE = sys.argv[1:5]
CONF = {
    "owners-vsl-funnel": {"perm": "camera=(), microphone=(self), geolocation=(), payment=(self \"https://js.stripe.com\"), usb=()", "frame": "'self'", "xfo": "SAMEORIGIN", "report_only": r"^$", "scripts": "head script", "hashes": ["h6D6VzTAMsJYUVVAqFwu452/qN8FcyJeOKkmsntdOnU="]},
    "cold-block": {"perm": "camera=(), microphone=(), geolocation=(), payment=(), usb=()", "frame": "'none'", "xfo": "DENY", "report_only": r"^$", "scripts": "script", "hashes": []},
}[W]
ct = [l.split(":", 1)[1].strip() for l in open(T + "/hdr") if l.lower().startswith("content-type")][0]
entry = [l.split(":", 1)[1].strip() for l in open(T + "/hdr") if l.lower().startswith("cf-entrypoint")][0]
msg = email.message_from_bytes(b"Content-Type: " + ct.encode() + b"\r\n\r\n" + open(T + "/raw", "rb").read(), policy=policy.default)
parts = {}
for p in msg.iter_parts():
    parts[p.get_filename() or p.get_param("name", header="content-disposition")] = (p.get_content_type(), p.get_payload(decode=True))
orig = entry
if entry == "_secure.js":  # already wrapped: find the module it imports
    src = parts["_secure.js"][1].decode()
    orig = src.split('import orig from "./', 1)[1].split('"', 1)[0]
wrapper = open(SECURE).read().replace("__ORIG__", orig).replace("__MODE__", MODE).replace("__PERMISSIONS__", json.dumps(CONF["perm"])).replace("__FRAME__", CONF["frame"]).replace("__XFO__", CONF["xfo"]).replace("__SCRIPTS__", CONF["scripts"]).replace("__REPORT_ONLY__", json.dumps(CONF["report_only"])).replace("__HASHES__", "".join(f"'sha256-{x}' " for x in CONF["hashes"]))
parts["_secure.js"] = ("application/javascript+module", wrapper.encode())
s = json.load(open(T + "/settings.json"))["result"]
meta = {"main_module": "_secure.js", "compatibility_date": s["compatibility_date"], "compatibility_flags": s.get("compatibility_flags", []),
        "keep_bindings": sorted({b["type"] for b in s["bindings"]}), "keep_assets": True, "bindings": []}
if s.get("observability"): meta["observability"] = s["observability"]
if s.get("logpush") is not None: meta["logpush"] = s["logpush"]
open(T + "/metadata.json", "w").write(json.dumps(meta))
args = ["-F", f"metadata=@{T}/metadata.json;type=application/json"]
for i, (name, (typ, data)) in enumerate(parts.items()):
    fn = f"{T}/part{i}"; open(fn, "wb").write(data)
    args += ["-F", f"{name}=@{fn};filename={name};type={typ}"]
open(T + "/form-args", "w").write(" ".join(args))
print(W, "entry", orig, "->", "_secure.js", MODE, "keep", meta["keep_bindings"], "modules", list(parts))
