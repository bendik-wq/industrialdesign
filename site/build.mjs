// Builds the static Pages site into site/dist from the repo's README, docs, renders and CAD outputs.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, "..");
const DIST = join(SITE, "dist");

const PRODUCTS = [
  {
    slug: "aero-1",
    name: "AERO-1",
    tagline: "High-efficiency wall-mounted AC indoor unit",
    summary: "Oversized 3-slab A-coil and a slow cross-flow fan shrink the temperature lift, chasing 2–3× today's average COP.",
    markdown: "README.md",
    strip: [/^# .*\n/m, /^\| Hero[\s\S]*?\n\n/m],
    model: "out/AERO-1_assembly.glb",
    orbit: "-120deg 75deg auto",
    hero: "renders/hero.png",
    renders: ["hero", "exploded_internals", "section", "rear", "underside"].map((n) => `renders/${n}.png`),
    bom: "docs/BOM.csv",
    downloads: [
      ["Assembly", ["out/AERO-1_assembly.step", "out/AERO-1_assembly.glb"]],
      ["STEP parts", "out/step"],
      ["STL parts", "out/stl"],
    ],
  },
  {
    slug: "sweep-1",
    name: "SWEEP-1",
    tagline: "Waterless self-powered cleaning robot for solar rows",
    summary: "One motor and one line shaft drive both ends of the row, so it can't rack. Targets about $12k per MW, with no water or crew.",
    markdown: "docs/SWEEP-1.md",
    strip: [/^# .*\n/m, /^!\[\]\(\.\.\/renders\/sweep1\/hero\.png\)\n/m],
    model: "out/sweep1/SWEEP-1_on_row.glb",
    orbit: "-30deg 55deg auto",
    hero: "renders/sweep1/hero.png",
    renders: ["hero", "side_on_row", "robot_close"].map((n) => `renders/sweep1/${n}.png`),
    downloads: [
      ["Assembly", ["out/sweep1/SWEEP-1_on_row.step", "out/sweep1/SWEEP-1_on_row.glb"]],
      ["STEP parts", "out/sweep1/step"],
      ["STL parts", "out/sweep1/stl"],
    ],
  },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const title = (p) => basename(p).replace(/\.[^.]+$/, "").replace(/_/g, " ");
const size = (p) => {
  const b = statSync(join(ROOT, p)).size;
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
};
const listFiles = (entry) =>
  Array.isArray(entry) ? entry : readdirSync(join(ROOT, entry)).sort().map((f) => `${entry}/${f}`);

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function renderMarkdown(p) {
  let md = readFileSync(join(ROOT, p.markdown), "utf8");
  for (const re of p.strip) md = md.replace(re, "");
  md = md
    .replaceAll("](../renders/", "](renders/")
    .replaceAll("](docs/SWEEP-1.md)", "](sweep-1)");
  return marked.parse(md);
}

function bomTable(p) {
  if (!p.bom) return "";
  const [head, ...rows] = parseCsv(readFileSync(join(ROOT, p.bom), "utf8")).filter((r) => r.length > 1);
  const cols = ["part_no", "name", "qty", "material", "process", "source"].map((c) => head.indexOf(c));
  return `
    <section id="bom">
      <div class="section-head"><h2>Bill of materials</h2><a class="pill" href="${p.bom}" download>BOM.csv</a></div>
      <div class="table-wrap"><table class="bom">
        <thead><tr>${cols.map((i) => `<th>${esc(head[i].replace("_", " "))}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${cols.map((i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
    </section>`;
}

function downloads(p) {
  return `
    <section id="files">
      <div class="section-head"><h2>CAD files</h2></div>
      <div class="downloads">
        ${p.downloads.map(([label, entry]) => `
          <div class="dl-group">
            <h3>${label}</h3>
            <ul>${listFiles(entry).map((f) => `
              <li><a href="${f}" download><span>${esc(title(f))}</span><span class="ext">${f.split(".").pop().toUpperCase()}</span><span class="size">${size(f)}</span></a></li>`).join("")}
            </ul>
          </div>`).join("")}
      </div>
    </section>`;
}

const layout = (pageTitle, description, body, { modelViewer = false } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%2315181d%22/%3E%3Cpath d=%22M8 22h16M8 16h10M8 10h16%22 stroke=%22%23e8a04a%22 stroke-width=%223%22 stroke-linecap=%22round%22/%3E%3C/svg%3E">
<link rel="stylesheet" href="/assets/site.css">
${modelViewer ? '<script type="module" src="/assets/model-viewer.min.js"></script>' : ""}
</head>
<body>
<header class="top">
  <a class="mark" href="./">industrial<b>design</b></a>
  <nav>${PRODUCTS.map((p) => `<a href="${p.slug}">${p.name}</a>`).join("")}</nav>
</header>
${body}
<footer class="foot">
  <p>Concept-stage designs. Parametric CAD in CadQuery / OpenCascade; renders from a headless three.js rig.</p>
</footer>
<dialog id="lightbox"><img alt=""><button aria-label="Close">×</button></dialog>
<script>
  const box = document.getElementById("lightbox");
  document.querySelectorAll("[data-zoom]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); box.querySelector("img").src = a.href; box.showModal();
  }));
  box.addEventListener("click", () => box.close());
</script>
</body>
</html>`;

function productPage(p) {
  const body = `
<main class="product">
  <section class="intro">
    <p class="eyebrow">Concept design</p>
    <h1>${p.name}</h1>
    <p class="lede">${esc(p.tagline)}</p>
    <nav class="jump"><a href="#model">3D model</a><a href="#renders">Renders</a><a href="#design">Design notes</a>${p.bom ? '<a href="#bom">BOM</a>' : ""}<a href="#files">CAD files</a></nav>
  </section>
  <section id="model" class="viewer">
    <model-viewer src="${p.model}" poster="${p.hero}" alt="${p.name} 3D assembly" camera-orbit="${p.orbit}" camera-controls auto-rotate auto-rotate-delay="1500" rotation-per-second="12deg" shadow-intensity="0.6" exposure="1" environment-image="neutral" interaction-prompt="none"></model-viewer>
    <p class="hint">Drag to orbit · scroll or pinch to zoom · <a href="${p.model}" download>GLB ${size(p.model)}</a></p>
  </section>
  <section id="renders">
    <div class="section-head"><h2>Renders</h2></div>
    <div class="gallery">${p.renders.map((r) => `
      <a href="${r}" data-zoom><img src="${r}" alt="${esc(p.name)} ${esc(title(r))}" loading="lazy"><span>${esc(title(r))}</span></a>`).join("")}
    </div>
  </section>
  <article id="design" class="prose">${renderMarkdown(p)}</article>
  ${bomTable(p)}
  ${downloads(p)}
</main>`;
  return layout(`${p.name} · industrialdesign`, `${p.name}: ${p.tagline}`, body, { modelViewer: true });
}

function indexPage() {
  const body = `
<main class="home">
  <section class="intro">
    <p class="eyebrow">Industrial design portfolio</p>
    <h1>Hardware concepts, modeled in code</h1>
    <p class="lede">Parametric CAD with real STEP exports, so a manufacturer or vendor can open every part in SolidWorks, Fusion or Creo.</p>
  </section>
  <section class="cards">${PRODUCTS.map((p) => `
    <a class="card" href="${p.slug}">
      <img src="${p.hero}" alt="${p.name} render">
      <div><h2>${p.name}</h2><p class="tag">${esc(p.tagline)}</p><p>${esc(p.summary)}</p><span class="go">View design →</span></div>
    </a>`).join("")}
  </section>
</main>`;
  return layout("industrialdesign", "Concept-stage industrial designs with parametric CAD, renders and STEP files.", body);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, "assets"), { recursive: true });
for (const dir of ["renders", "out", "docs"]) cpSync(join(ROOT, dir), join(DIST, dir), { recursive: true });
cpSync(join(SITE, "node_modules/@google/model-viewer/dist/model-viewer.min.js"), join(DIST, "assets/model-viewer.min.js"));
cpSync(join(SITE, "site.css"), join(DIST, "assets/site.css"));
writeFileSync(join(DIST, "index.html"), indexPage());
for (const p of PRODUCTS) writeFileSync(join(DIST, `${p.slug}.html`), productPage(p));
writeFileSync(join(DIST, "404.html"), layout("Not found · industrialdesign", "Page not found.", `
<main><section class="intro"><p class="eyebrow">404</p><h1>Page not found</h1><p class="lede"><a href="/">Back to all designs</a></p></section></main>`));
writeFileSync(join(DIST, "_headers"), [
  "/assets/*\n  Cache-Control: public, max-age=86400",
  "/out/*\n  Cache-Control: public, max-age=3600",
  "/renders/*\n  Cache-Control: public, max-age=3600",
].join("\n") + "\n");

console.log(`Built ${relative(ROOT, DIST)}: index + ${PRODUCTS.map((p) => p.slug).join(", ")}`);
