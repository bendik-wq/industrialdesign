"""
OVO-1 — egg-shaped local-LLM appliance. Spun aluminium shell, stainless steel band and stand.

Compute: one Mini-ITX AMD Ryzen AI Max+ 395 ("Strix Halo") board with 128 GB unified LPDDR5X
(≈96 GB usable as GPU memory). It runs 70B-class dense models and 100B+ MoE models fully on-device.

Cooling is a chimney: a 140 mm fan in the fat lower end pushes air up past the vertical board and
heatsink, out of an annular slot under the floating crown. Cold air in at the bottom, warm air out
at the top, the way hot air wants to go anyway, so the fan can run slow.

Coordinate system (mm):
    Z = up, 0 = table top.  EZ = egg-local height, 0 = (virtual) bottom tip of the egg.
    -Y = rear (ports, PSU), +Y = front (heatsink side of the board).

Run:  python3 cad/llm_egg.py
"""
import math
from pathlib import Path

import cadquery as cq

OUT = Path(__file__).resolve().parent.parent / "out" / "ovo1"

# ------------------------------------------------------------ egg envelope
EGG_L = 360.0  # tip-to-tip height
EGG_B = 260.0  # max diameter
EGG_W = 25.0  # Hügelschäffer shift: max diameter sits 25 mm below mid-height (fat end down)
SHELL_T = 2.0  # spun 5052-H32 aluminium wall
EZ_BASE = 28.0  # shell is open below here: intake opening (Ø≈158)
EZ_SEAM = 150.0  # equator split: upper shell lifts off for service
EZ_CROWN = 310.0  # top opening; the crown floats above it
CROWN_LIFT = 14.0  # height of the annular exhaust slot
BAND_H = 6.0  # stainless equator band height
Z0 = 12.0  # egg tip height above the table (set by the stand)

# ------------------------------------------------------------ internals
FAN = 140.0  # 140x25 fan (Noctua NF-A14 class), ~800-1000 rpm
FAN_T = 25.0
EZ_FAN = 62.0  # fan bottom face
EZ_DECK = EZ_FAN + FAN_T  # stainless deck plate the whole core hangs from
DECK_T = 1.5
ITX = 170.0  # Mini-ITX board
PCB_T = 1.6
EZ_BOARD = 95.0  # bottom edge of the board (vertical, I/O edge down)
Y_SPINE = -25.0  # front face of the 2 mm stainless spine
STANDOFF = 6.0
Y_PCB = Y_SPINE + STANDOFF  # PCB rear face
HS = (120.0, 110.0)  # heatsink footprint on the board (X, Z)
HS_FIN_H = 48.0  # fin height off the base
EZ_HS = 125.0  # heatsink bottom
PSU = (50.8, 101.6, 30.0)  # 300 W open-frame 12 V supply (Mean Well EPP-300-12 class): X, Z, Y
EZ_PSU = 110.0
PORT_W, PORT_Z0, PORT_Z1 = 96.0, 96.0, 140.0  # rear port pocket in the lower shell
CLEAR = 3.0  # minimum internal-to-shell clearance enforced by check_clearance()


# ============================================================ egg geometry
def egg_r(ez):
    """Hügelschäffer egg: outer radius at egg-local height ez."""
    x = ez - EGG_L / 2
    v = (EGG_L**2 - 4 * x * x) / (EGG_L**2 + 8 * EGG_W * x + 4 * EGG_W**2)
    return EGG_B / 2 * math.sqrt(max(v, 0.0))


def _profile(offset=0.0, n=60):
    """(r, ez) points of the outer profile, or offset inward by `offset` along the normal."""
    pts = []
    for i in range(1, n):
        ez = EGG_L / 2 * (1 - math.cos(math.pi * i / n))  # cosine spacing: dense near the tips
        h = 0.01
        dr = (egg_r(ez + h) - egg_r(ez - h)) / (2 * h)
        nl = math.hypot(1.0, dr)
        # outward normal of (r(ez), ez) is (1, -dr)/|.|
        pts.append((egg_r(ez) - offset / nl, ez + offset * dr / nl))
    return [(0.0, offset)] + pts + [(0.0, EGG_L - offset)]


def egg_solid(offset=0.0):
    pts = _profile(offset)
    w = (
        cq.Workplane("XZ")
        .moveTo(*pts[0])
        .spline(pts[1:], tangents=[(1, 0), (-1, 0)], includeCurrent=True)
        .close()
        .revolve(360, (0, 0, 0), (0, 1, 0))
    )
    return w


def inner_r(ez):
    """Inner radius of the shell at ez (numerical, from the offset profile)."""
    pts = _profile(SHELL_T, 400)
    best = min(pts, key=lambda p: abs(p[1] - ez))
    return best[0]


def slab(ez0, ez1, r=400.0):
    return cq.Workplane("XY").workplane(offset=ez0).circle(r).extrude(ez1 - ez0)


def box_between(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0).translate(
        ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    )


def cyl_y(d, y0, y1, x, z):
    return cq.Workplane("XZ").workplane(offset=-y0).center(x, z).circle(d / 2).extrude(-(y1 - y0))


OUTER = egg_solid()
INNER = egg_solid(SHELL_T)
SHELL = OUTER.cut(INNER)


# ============================================================ shell parts (egg-local Z)
def port_pocket():
    """Recessed flat port panel in the rear of the lower shell, and the cut that makes room for it."""
    x0, x1 = -PORT_W / 2, PORT_W / 2
    y_face = -math.sqrt(egg_r(PORT_Z0) ** 2 - (PORT_W / 2) ** 2) + 6  # 6 mm inside the shell skin
    window = box_between(x0, x1, -200, y_face, PORT_Z0, PORT_Z1)
    walls = box_between(x0 - 1.5, x1 + 1.5, -200, y_face, PORT_Z0 - 1.5, PORT_Z1 + 1.5).cut(window)
    walls = walls.intersect(OUTER)
    plate = box_between(x0, x1, y_face, y_face + 1.5, PORT_Z0, PORT_Z1)
    # ports: IEC C14 inlet, 2x USB4 (USB-C), 1x USB-A, 1x 5GbE RJ45, power LED
    cuts = [
        box_between(-40, -16, y_face - 1, y_face + 3, 103, 123),  # C14 (27x19 cut-out, simplified)
        box_between(-8, 1, y_face - 1, y_face + 3, 124, 127.5),  # USB-C
        box_between(-8, 1, y_face - 1, y_face + 3, 116, 119.5),  # USB-C
        box_between(-8, 6, y_face - 1, y_face + 3, 104, 110),  # USB-A
        box_between(14, 30, y_face - 1, y_face + 3, 106, 120),  # RJ45
    ]
    for c in cuts:
        plate = plate.cut(c)
    return window, walls.union(plate), y_face


def shell_lower():
    window, pocket, _ = port_pocket()
    s = SHELL.intersect(slab(EZ_BASE, EZ_SEAM - BAND_H / 2)).cut(window).union(pocket)
    # three bayonet lugs on the inside of the seam that the upper shell twists onto
    for k in range(3):
        a = math.radians(30 + k * 120)
        r = inner_r(EZ_SEAM) - 3
        lug = box_between(-9, 9, -3, 3, EZ_SEAM - 12, EZ_SEAM - BAND_H / 2).translate((0, r, 0))
        s = s.union(lug.rotate((0, 0, 0), (0, 0, 1), math.degrees(a)))
    return s


def band():
    """Polished 316 stainless equator band (5 mm deep ring), with a 1.5 mm groove for the light ring."""
    b = OUTER.intersect(slab(EZ_SEAM - BAND_H / 2, EZ_SEAM + BAND_H / 2)).cut(egg_solid(SHELL_T + 3))
    return b.cut(light_ring())


def light_ring():
    """Opal PC light pipe in the band groove: shows status / 'thinking' (tokens/s as brightness)."""
    return OUTER.intersect(slab(EZ_SEAM - 0.75, EZ_SEAM + 0.75)).cut(egg_solid(1.2))


def shell_upper():
    s = SHELL.intersect(slab(EZ_SEAM + BAND_H / 2, EZ_CROWN))
    # three posts that carry the floating crown across the exhaust slot
    for k in range(3):
        a = math.radians(90 + k * 120)
        r = inner_r(EZ_CROWN) - 6
        post = cq.Workplane("XY").workplane(offset=EZ_CROWN - 20).center(r * math.cos(a), r * math.sin(a)).circle(4).extrude(20 + CROWN_LIFT + 4)
        s = s.union(post)
    return s


def crown():
    """Crown: the tip of the egg, lifted 14 mm. Capacitive power touch-pad on the inside."""
    c = SHELL.intersect(slab(EZ_CROWN, EGG_L + 1))
    c = c.union(INNER.intersect(slab(EZ_CROWN + 4, EZ_CROWN + 6)))  # inner diaphragm for the touch PCB
    return c.translate((0, 0, CROWN_LIFT))


def stand():
    """Egg cup: 304 stainless, spun and flared. The egg rests on three silicone pads at the intake rim."""
    ez_top = 40.0
    r_top = egg_r(ez_top) + 3
    r_floor = 112.0
    zf = -Z0 + 3  # sits on a 3 mm rubber foot ring

    def wall_r(ez):
        return r_floor + (r_top - r_floor) * (ez - zf) / (ez_top - zf)

    prof = (
        cq.Workplane("XZ")
        .polyline([(r_floor - 2, zf), (r_floor, zf), (r_top + 2, ez_top), (r_top, ez_top)])
        .close()
        .revolve(360, (0, 0, 0), (0, 1, 0))
    )
    # intake: 30 slots around the cup
    for k in range(30):
        slot = box_between(-3, 3, 60, 140, zf + 7, zf + 27).rotate((0, 0, 0), (0, 0, 1), k * 12)
        prof = prof.cut(slot)
    # three ribs out to the egg's intake rim + silicone pads (pads modelled as part of the ribs)
    for k in range(3):
        rib = box_between(egg_r(EZ_BASE) - 12, wall_r(EZ_BASE), -2, 2, EZ_BASE - 6, EZ_BASE)
        prof = prof.union(rib.rotate((0, 0, 0), (0, 0, 1), 60 + k * 120))
    # rubber foot ring
    foot = cq.Workplane("XY").workplane(offset=-Z0).circle(r_floor).circle(r_floor - 8).extrude(3)
    return prof, foot


# ============================================================ core (lifts out on the deck)
def fan():
    frame = box_between(-FAN / 2, FAN / 2, -FAN / 2, FAN / 2, EZ_FAN, EZ_FAN + FAN_T)
    frame = frame.edges("|Z").fillet(8).cut(cq.Workplane("XY").workplane(offset=EZ_FAN - 1).circle(68).extrude(FAN_T + 2))
    hub = cq.Workplane("XY").workplane(offset=EZ_FAN + 2).circle(22).extrude(FAN_T - 4)
    rotor = hub
    for k in range(7):
        blade = box_between(18, 66, -9, 9, EZ_FAN + FAN_T / 2 - 1, EZ_FAN + FAN_T / 2 + 1).rotate(
            (0, 0, EZ_FAN + FAN_T / 2), (1, 0, EZ_FAN + FAN_T / 2), 32
        )
        rotor = rotor.union(blade.rotate((0, 0, 0), (0, 0, 1), k * 360 / 7))
    # 4 struts
    for k in range(4):
        frame = frame.union(box_between(20, 70, -1.5, 1.5, EZ_FAN, EZ_FAN + 3).rotate((0, 0, 0), (0, 0, 1), 45 + k * 90))
    return frame, rotor


def filter_disc():
    """Washable stainless mesh dust filter, drops out of the bottom (magnet-held)."""
    ez = EZ_BASE + 6
    r = inner_r(ez) - 1
    f = cq.Workplane("XY").workplane(offset=ez).circle(r).extrude(3)
    for i in range(-8, 9):
        f = f.cut(box_between(-r, r, i * 9 - 2.5, i * 9 + 2.5, ez - 1, ez + 4))
    return f.union(cq.Workplane("XY").workplane(offset=ez).circle(r).circle(r - 4).extrude(3))


def deck_and_spine():
    """1.5 mm 304 stainless deck + 2 mm spine, laser cut, bent, spot-welded. Everything mounts here."""
    r = inner_r(EZ_DECK) - 4
    deck = cq.Workplane("XY").workplane(offset=EZ_DECK).circle(r).circle(FAN / 2 - 2).extrude(DECK_T)
    # cable notch and PSU pass-through at the rear
    deck = deck.cut(box_between(-30, 30, -r - 1, -FAN / 2 + 4, EZ_DECK - 1, EZ_DECK + 3))
    # 3 tabs that screw to the lower shell bosses
    for k in range(3):
        tab = box_between(-8, 8, r - 10, r, EZ_DECK, EZ_DECK + 12).rotate((0, 0, 0), (0, 0, 1), 90 + k * 120)
        deck = deck.union(tab)
    top = EZ_BOARD + ITX + 12
    spine = box_between(-75, 75, Y_SPINE - 2, Y_SPINE, EZ_DECK, top)
    for zc in (EZ_BOARD + 40, EZ_BOARD + 130):  # lightening windows
        spine = spine.cut(box_between(-55, -20, Y_SPINE - 3, Y_SPINE + 1, zc - 25, zc + 25))
        spine = spine.cut(box_between(20, 55, Y_SPINE - 3, Y_SPINE + 1, zc - 25, zc + 25))
    # Mini-ITX standoffs (hole pattern 157.48 x 154.94 mm)
    x0, z0 = -ITX / 2, EZ_BOARD
    for hx, hz in ((6.35, 10.16), (163.83, 10.16), (6.35, 165.10), (163.83, 165.10)):
        spine = spine.union(cyl_y(6, Y_SPINE, Y_PCB, x0 + hx, z0 + hz))
    return deck.union(spine)


def board():
    """Mini-ITX Strix Halo board, vertical. LPDDR5X is soldered round the SoC, so no DIMMs stick out."""
    x0 = -ITX / 2
    pcb = box_between(x0, x0 + ITX, Y_PCB, Y_PCB + PCB_T, EZ_BOARD, EZ_BOARD + ITX)
    y = Y_PCB + PCB_T
    parts = [
        box_between(-25, 25, y, y + 2.5, EZ_HS + 30, EZ_HS + 80),  # SoC package
        box_between(x0 + 2, x0 + 160, y, y + 14, EZ_BOARD - 6, EZ_BOARD + 16),  # rear I/O row (bottom edge)
        box_between(x0 + ITX - 14, x0 + ITX - 4, y, y + 10, EZ_BOARD + 70, EZ_BOARD + 120),  # power header
        box_between(x0 + 10, x0 + 90, y, y + 3, EZ_BOARD + ITX - 26, EZ_BOARD + ITX - 4),  # M.2 2280 #1
    ]
    for p in parts:
        pcb = pcb.union(p)
    return pcb


def heatsink():
    """Copper vapour-chamber base + 0.4 mm Al fins, vertical so the chimney draft runs straight up."""
    y0 = Y_PCB + PCB_T + 2.5
    hx, hz = HS
    hs = box_between(-hx / 2, hx / 2, y0, y0 + 5, EZ_HS, EZ_HS + hz)
    n = 24
    pitch = hx / n
    for i in range(n):
        x = -hx / 2 + pitch * (i + 0.5)
        hs = hs.union(box_between(x - 0.6, x + 0.6, y0 + 5, y0 + 5 + HS_FIN_H, EZ_HS, EZ_HS + hz))
    return hs


def psu():
    """300 W open-frame 12 V PSU behind the spine. 12 V straight into the board's DC input / DC-ATX."""
    px, pz, py = PSU
    return box_between(-px / 2, px / 2, Y_SPINE - 2 - 4 - py, Y_SPINE - 2 - 4, EZ_PSU, EZ_PSU + pz)


def duct():
    """0.8 mm Al baffle walls either side of the heatsink so fan air is forced through the fins."""
    y0 = Y_PCB + PCB_T
    hx, hz = HS
    y1 = y0 + 2.5 + 5 + HS_FIN_H + 1
    d = box_between(-hx / 2 - 2, -hx / 2 - 1.2, y0, y1, EZ_DECK + DECK_T, EZ_HS + hz)
    d = d.union(box_between(hx / 2 + 1.2, hx / 2 + 2, y0, y1, EZ_DECK + DECK_T, EZ_HS + hz))
    d = d.union(box_between(-hx / 2 - 2, hx / 2 + 2, y1, y1 + 0.8, EZ_DECK + DECK_T, EZ_HS + hz))
    return d


# ============================================================ checks
def check_clearance(parts):
    """Every vertex of every internal part must sit inside the shell with CLEAR margin."""
    worst = (1e9, "")
    for name, shape in parts.items():
        for v in shape.vertices().vals():
            x, y, z = v.X, v.Y, v.Z
            gap = inner_r(z) - math.hypot(x, y)
            worst = min(worst, (gap, name))
            if gap < CLEAR:
                raise SystemExit(f"CLEARANCE FAIL {name}: vertex ({x:.0f},{y:.0f},{z:.0f}) gap {gap:.1f} mm")
    print(f"clearance OK — tightest: {worst[1]} {worst[0]:.1f} mm")


# ============================================================ build
AL = cq.Color(0.80, 0.81, 0.83)
SS = cq.Color(0.62, 0.63, 0.65)


def build():
    stand_shape, foot = stand()
    fan_frame, fan_rotor = fan()
    core = {
        "fan_frame": (fan_frame, cq.Color(0.16, 0.16, 0.17)),
        "fan_rotor": (fan_rotor, cq.Color(0.22, 0.22, 0.24)),
        "filter": (filter_disc(), SS),
        "deck_spine": (deck_and_spine(), SS),
        "board": (board(), cq.Color(0.10, 0.20, 0.14)),
        "heatsink_fins": (heatsink(), cq.Color(0.85, 0.62, 0.42)),
        "duct": (duct(), cq.Color(0.70, 0.71, 0.73)),
        "psu": (psu(), cq.Color(0.25, 0.26, 0.28)),
    }
    check_clearance({k: v[0] for k, v in core.items() if k not in ("filter",)})
    shell = {
        "shell_lower": (shell_lower(), AL),
        "band": (band(), cq.Color(0.90, 0.90, 0.92)),
        "light_ring": (light_ring(), cq.Color(0.98, 0.97, 0.94)),
        "shell_upper": (shell_upper(), AL),
        "crown": (crown(), AL),
        "stand": (stand_shape, SS),
        "foot": (foot, cq.Color(0.12, 0.12, 0.12)),
    }
    return {**shell, **core}


EXPLODE = {"shell_upper": 150, "band": 75, "light_ring": 75, "crown": 240, "stand": -110, "foot": -110, "filter": -60}


def assembly(parts, exploded=False):
    assy = cq.Assembly(name="OVO-1_exploded" if exploded else "OVO-1")
    for name, (shape, color) in parts.items():
        dz = EXPLODE.get(name, 0) if exploded else 0
        assy.add(shape, name=name, color=color, loc=cq.Location(cq.Vector(0, 0, Z0 + dz)))
    return assy


if __name__ == "__main__":
    (OUT / "step").mkdir(parents=True, exist_ok=True)
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    parts = build()
    dens = {"shell_lower": 2.68, "shell_upper": 2.68, "crown": 2.68, "band": 8.0, "stand": 8.0, "deck_spine": 8.0}
    mass = 0.0
    for name, (shape, _) in parts.items():
        cq.exporters.export(shape, str(OUT / "step" / f"{name}.step"))
        cq.exporters.export(shape, str(OUT / "stl" / f"{name}.stl"), tolerance=0.2, angularTolerance=0.2)
        bb = shape.val().BoundingBox()
        vol = shape.val().Volume() / 1000
        m = vol * dens.get(name, 0) / 1000
        mass += m
        print(f"{name:14s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm  vol={vol:7.1f} cm3" + (f"  {m:5.2f} kg" if m else ""))
    print(f"metal enclosure mass ≈ {mass:.2f} kg; overall height {Z0 + EGG_L + CROWN_LIFT:.0f} mm, Ø{EGG_B:.0f} mm")
    assembly(parts).export(str(OUT / "OVO-1_assembly.step"))
    assembly(parts).export(str(OUT / "OVO-1_assembly.glb"))
    assembly(parts, exploded=True).export(str(OUT / "OVO-1_exploded.glb"))
    print("done")
