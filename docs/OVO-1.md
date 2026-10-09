# OVO-1: sealed, water-cooled local-LLM appliance, an egg lying on its side (hardware)

![](../renders/ovo1/hero.png)

| Profile | Tail | Underside (all the breathing) | Section (water jacket in blue) |
|---|---|---|---|
| ![](../renders/ovo1/profile.png) | ![](../renders/ovo1/tail.png) | ![](../renders/ovo1/underside.png) | ![](../renders/ovo1/section.png) |

A quiet desk object that runs large language models fully offline. It is a long, low aluminium pebble:

- 470 mm long, 270 mm wide, 161 mm tall
- about 5.5 kg with the water and electronics in
- this revision is **hardware only**; the software stack comes next (see the end of this page)

## Design intent

**Closed.** The body is one unbroken oval. There is no opening on the top, the flanks, the nose or the tail. The only
lines on it are:
- the 0.3 mm hairline seam at the equator
- a 60 mm light slit set into that seam near the tail, which glows while the model is generating

**Hovering.** It rests on a narrow stainless keel set in from every edge, so from any normal viewing angle you can't
see what holds it up.

**Water-cooled skin.** The aluminium body is not just a cover, it is the radiator. Both shell halves are double-walled
"pillow plates" with a 3 mm water gap. Coolant from the processor flows through the whole skin before it goes anywhere
else.

| Function | Where | How it stays invisible |
|---|---|---|
| Passive cooling | The whole skin | 0.21 m² of water-backed, anodized aluminium |
| Air in (boost only) | Belly, under the nose and under the tail | Fine slots in a dark stainless belly plate, in the body's shadow |
| Air out (boost only) | Belly, either side of the keel | Warm air leaves sideways along the desk, away from the intakes |
| Ports | Back end of the keel | IEC C7 (figure-8) mains, 2 × USB4, 5GbE |
| Status | Light slit in the tail seam | Opal light pipe, only lit when working |
| Power | Button on the keel back; wake by tapping the shell (accelerometer) | |

## Envelope

| | |
|---|---|
| Shape | Hügelschäffer egg, 470 mm nose to tail, widest point 30 mm ahead of mid-length. Every cross-section is an ellipse with height/width **K = 0.60** |
| Overall | 470 L × 270 W × 161 H mm (was 440 × 270 × 174 at K = 0.68) |
| Outer skin | 2.0 mm 5052-H32 aluminium, two halves. Deep-drawn, CNC-trimmed, bead-blasted, anodized (the anodize also raises emissivity to ~0.8, which doubles radiated heat compared with bare aluminium) |
| Water jacket | 3 mm gap, 1.0 mm aluminium liner, dimple-welded to the skin every 25 mm, edges laser-welded. 0.48 L of water |
| Belly plate | 1.5 mm 304 stainless, dark PVD, with intake and exhaust slots |
| Keel | Solid 304 stainless, 150 × 56 × 18 mm. Its weight keeps the centre of mass low; sideways tip-over angle ≈ 22° |
| Enclosure + water mass | 3.8 kg (from CAD volumes) |

## Cooling: one water loop, three modes

```
pump → SoC cold plate → upper skin jacket → lower skin jacket → belly radiator → pump
```

The whole wetted path is aluminium: skin, liner, cold plate, radiator. Mixing copper and aluminium in one loop corrodes
the aluminium. The coolant is 30% propylene glycol with a corrosion inhibitor.

**What a sealed skin can do.** At the skin, natural convection gives ~4 W/m²·K and radiation (ε 0.8) gives ~5.3, so
about 9.5 W/m²·K in total. For the skin to stay at or below 45 °C in a 25 °C room:

```
Q = h · A · ΔT = 9.5 × 0.21 × 20 ≈ 40 W   (plus a few W from the unjacketed ends)
```

That is the honest limit of a fully closed box this size. The full machine makes ~155 W under sustained generation, so
it gets three modes:

| Mode | Fans | Heat it can hold | When |
|---|---|---|---|
| **Silent** | Off | ~45 W continuous | Idle, light chat, serving small models |
| **Silent burst** | Off | 155 W for ~6–7 min | The water and metal store ~4.7 kJ/K, so a 10 K rise absorbs ~47 kJ |
| **Whisper / Boost** | 2 × 80 mm slim fans at ~800 / ~2,000 rpm | ~110 W / full 155 W | Long generations, big prompts |

**Boost airflow.**
1. Room air comes in under the nose and the tail (≈ 57 cm² of slots).
2. It runs along a tunnel over the belly radiator.
3. The fans push it down through the 160 × 90 × 25 mm core.
4. It leaves through ≈ 90 cm² of slots either side of the keel.

The fan deck and two baffles seal the tunnel, so no air bypasses the core and exhaust can't loop back into the intakes.
At boost the radiator has to take ~110 W, because the skin keeps taking its ~45 W. At a 12 K air rise that needs ~16 CFM.

| | Air speed at 16 CFM |
|---|---|
| Intake slots | ~1.3 m/s |
| Exhaust slots | ~0.85 m/s |

The skin stays warm to the touch in boost: water at ~38–42 °C means a skin at about 38–40 °C.

## Compute: why Strix Halo

For a local LLM the bottleneck is **memory size and memory bandwidth**, not FLOPs. Each generated token streams every
active weight through memory once. So:

```
tokens/s  ≈  effective memory bandwidth  ÷  bytes of active weights per token
```

| Option | Memory for the model | Bandwidth | Power | Fits an egg? |
|---|---|---|---|---|
| **AMD Ryzen AI Max+ 395 (Strix Halo), Mini-ITX, 128 GB** | up to ~96 GB as GPU memory | 256 GB/s | 120 W sustained | **Yes, chosen** |
| NVIDIA GB10 (DGX Spark class), 128 GB | ~120 GB | 273 GB/s | ~140 W | Not sold as a bare board |
| RTX 5090 desktop | 32 GB | 1.8 TB/s | 575 W GPU alone | No: too hot, too little memory for 70B |
| Apple M-series Ultra | up to 512 GB | ~800 GB/s | ~200 W | No: not available as a module |

Strix Halo is the only 128 GB unified-memory part sold as a standard Mini-ITX board (for example the Framework Desktop
mainboard). It drops straight onto the tray's Mini-ITX standoffs, and its single hot spot suits one cold plate.

**Expected speed.** These are bandwidth-bound estimates at ~75% of 256 GB/s, Q4 weights, single user. They are not measured.

| Model | Active weights | ≈ tokens/s |
|---|---|---|
| Llama 3.3 70B (dense) | ~42 GB | 4–5 |
| Qwen3 32B (dense) | ~20 GB | 9–10 |
| gpt-oss-120b (MoE, ~5B active) | ~3 GB/token | 35–50 |
| Qwen3 30B-A3B (MoE) | ~2 GB/token | 60–80 |

Mixture-of-experts models are the sweet spot. They need the 128 GB to *hold* the model, but read only a few GB per token.

## Internal layout

![](../renders/ovo1/core.png)

Bottom to top:

1. **Belly plate.** Intake slots front and back, exhaust slots in the middle.
2. **Fans and fan deck.** Two 80 × 15 mm slim fans, under a contoured stainless deck.
3. **Radiator.** Aluminium flat-tube radiator, 160 × 90 × 25 mm, with end tanks.
4. **Tray.** Stainless, cut to the jacket liner's own contour. It is the ceiling of the air tunnel and the floor of the
   board bay.
5. **Board.** Mini-ITX Strix Halo, flat on 6 mm standoffs. Its I/O edge faces the tail, and short leads run to the
   keel ports.
6. **Cold plate.** Skived-fin aluminium, 76 × 76 × 12 mm, on the SoC.
7. **Pump.** Pump and 150 ml reservoir in one Ø50 × 90 mm cylinder across the nose. The fill port is under the belly.
8. **PSU.** 300 W open-frame 12 V, on edge in the tail bay, where incoming air cools it.

`cad/llm_egg.py` checks every build: every vertex of every internal part must sit at least 3 mm inside the **jacket
liner**, or the build fails. Current tightest gap: the board, ≈ 12.8 mm.

## Cost (rough, ~1k units, not yet quoted)

| Item | USD |
|---|---|
| Strix Halo Mini-ITX board, 128 GB | 1,700–2,000 |
| NVMe SSD, 2 TB | 150 |
| 300 W PSU, 2 × 80 mm slim fans | 60 |
| Pump and reservoir, cold plate, radiator, coolant | 90 |
| Pillow-plate shell halves: skin + liner, dimple and seam welding, leak test, anodize | 240 |
| Stainless belly plate, keel, tray, deck, baffles | 85 |
| Leads, light pipe, LED/accelerometer/leak-sensor PCB, harness | 50 |
| Assembly, fill, test | 50 |
| **Total** | **≈ $2.4–2.7k** |

The board is still ~70% of the cost. The water-cooled enclosure is ~$450.

## Risks and open items before a prototype

1. **Water in a desktop electronics product.** This is the biggest risk. Mitigations:
   - a welded, all-aluminium loop with no hose clamps (only two O-ring quick-disconnects, at the cold plate)
   - helium leak test of every jacket
   - a leak sensor on the belly plate that shuts the machine down
   - the electronics bay sits above the water's lowest point, but drips can still reach the board, so the board gets
     conformal coating
2. **Forming the pillow plate.** The skin and liner must be drawn, then welded and inflated (hydro-formed) into the
   jacket, without marking the outer surface. Find a supplier who already makes pillow plates or welded double-wall
   aluminium (cookware, battery cold plates). Fallback: bond flattened aluminium tubes inside a single-wall skin.
   That gives less area, about 30 W passive.
3. **Fan noise in boost.** 80 mm slim fans at ~2,000 rpm are the loudest thing in the design (~30–35 dBA est.). If
   that is too loud, there are two options. Use a thicker 35 mm core, which leaves ~4 mm under the tray and needs the
   stack re-checked. Or move the PSU into the nose beside the pump, which frees the tail bay for a third fan.
4. **Board power input.** Confirm the board's input (24-pin ATX vs 12 V DC). If it needs ATX, add a DC-ATX converter in
   the tail bay.
5. **Electrical safety (IEC 62368-1).** The C7 inlet has no earth pin, so this is a Class II design. The PSU needs
   reinforced insulation to all of the metal, including the water loop. The alternative is an earthed C5 inlet, with
   the skin, liner, tray and radiator bonded to protective earth. Decide before choosing the PSU.
6. **Render artifact.** The tail-tip spot in the renders comes from the mesh converging at the pole. The CAD surface is
   smooth there (checked against the egg formula to within 0.7 mm).

## Next: software (not in this revision)

- Linux with ROCm
- llama.cpp / vLLM serving an OpenAI-compatible API on the LAN
- mDNS discovery (`ovo.local`)
- a daemon that drives the tail light slit from the generation rate, and picks silent, whisper or boost cooling from
  water temperature and load

## Files

- `cad/llm_egg.py`: parametric model. Length, width, flattening `K`, belly cut, jacket gap and every internal position
  are parameters at the top. The build runs the interference check (against the jacket liner) and prints the intake and
  exhaust open areas, the water-backed skin area and the jacket water volume.
- `out/ovo1/step/*.step`: one STEP per part.
- `out/ovo1/OVO-1_assembly.step` / `.glb`: full colored assembly. `OVO-1_exploded.glb`: exploded view.
- `out/ovo1/stl/*.stl`: files for 3D-printed fit-check prototypes.
- `docs/OVO-1_BOM.csv`: bill of materials.
- Renders: `SET=ovo1 PW=$(npm root -g)/playwright node tools/render.mjs`
