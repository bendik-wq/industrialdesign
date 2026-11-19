"""Generate ads/index.html (the review page) from the scripts. Run after a build."""
import html, importlib.util, os, re, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); ADS = os.path.dirname(HERE)
ORDER = [
 ("x1_they_had_the_chance", "Pattern break", "Doing nothing is the most expensive decision an owner makes. The winners bought their rivals."),
 ("a1_one_in_one", "Flagship", "Every owner's exit is somebody's entry, and that somebody can be you."),
 ("h04_every_sign", "Belief", "The businesses on your street are inventory, and private equity already knows it."),
 ("h05_one_hundred", "Belief", "One business is one point of failure. A group spreads the risk and sells for more."),
 ("h06_how_many", "Belief", "You don't have to build every business from scratch."),
 ("h07_ten_years", "Belief", "The next ten years of growth can be bought, not repeated."),
 ("h08_saturdays", "Belief", "Hours don't scale a business. Acquisitions do."),
 ("h09_the_house", "Belief", "Buying a business is as normal as buying a house. Lenders fund the cash flow."),
 ("h10_banks_lend", "Mechanism", "You don't need a huge deposit. Banks reject structures, not buyers."),
 ("h11_seller_finances", "Mechanism", "The seller can fund your purchase of their business."),
 ("h12_who_gets_this", "Mechanism", "The best businesses never list. They go to whoever asks first."),
 ("h13_keys", "Identity", "One business is a job you own. Several is a group."),
 ("a2_buy_the_years", "Belief", "Time can be bought from the owner who already spent it."),
 ("a3_competitor", "Cutdown", "Your competitor's customers are an acquisition, not a threat."),
]
def load(p):
    s = importlib.util.spec_from_file_location("m", p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
def dur(p):
    try: return float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",p],capture_output=True,text=True).stdout)
    except Exception: return 0
cards = []
for n, tag, belief in ORDER:
    m = load(os.path.join(ADS, "scripts", n + ".py"))
    hook = []
    for g in m.SCRIPT:
        t = g.get("card") or g.get("sub")
        if not t: continue
        hook.append(t)
        if len(" ".join(hook)) > 70 or g.get("hit") and len(hook) > 1: break
    d = dur(os.path.join(ADS, "out", "web", n + ".mp4"))
    ln = f"{int(d//60)}:{int(d%60):02d}" if d else "rendering"
    cards.append(f'''  <article class="ad">
    <div class="phone"><video src="{n}.mp4" poster="{n}.jpg" controls playsinline preload="none"></video></div>
    <div class="brief">
      <div class="meta"><span class="tag">{tag}</span><span>{ln}</span><span>9:16</span></div>
      <h2>{html.escape(m.TITLE)}</h2>
      <p class="hook">{html.escape(" ".join(hook))}</p>
      <p class="belief"><span>Installs</span>{html.escape(belief)}</p>
    </div>
  </article>''')
page = open(os.path.join(HERE, "index_template.html")).read().replace("<!--CARDS-->", "\n".join(cards)).replace("<!--COUNT-->", str(len(ORDER)))
open(os.path.join(ADS, "index.html"), "w").write(page)
print("index.html with", len(ORDER), "ads")
