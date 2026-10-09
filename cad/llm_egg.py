"""
OVO-1 — local-LLM appliance: a sealed, water-cooled aluminium egg lying on its side.

The body is one closed, unbroken oval (flattened to K = 0.6) with a single hairline seam. There are no
openings on the top, the flanks, the nose or the tail. It rests on a narrow stainless keel, so it seems to
hover.

Cooling is a water loop:
    pump -> SoC cold plate -> upper shell jacket -> lower shell jacket -> belly radiator -> pump
    - SILENT mode: the shell IS the radiator. Both halves are double-walled "pillow plates" with a 3 mm water
      gap, so ~0.3 m² of anodized aluminium sheds heat by convection + radiation. Fans off, ~55 W.
    - BOOST mode: room air comes in under the nose and under the tail, runs along a tunnel over a flat belly
      radiator, and two slim 80 mm fans push it down through the core and out of the belly either side of the
      keel. Fresh air in front/back, warm air out left/right, every opening faces the desk. Full 120 W.

Coordinate system (mm), body-local:
    X = along the egg, 0 = nose tip, EGG_L = tail tip.   Y = width.   Z = up, 0 = egg axis.
The assembly lifts the body by Z_AXIS so the table is at Z=0.

Run:  python3 cad/llm_egg.py
"""
import math
from pathlib import Path

import cadquery as cq
from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
from OCP.gp import gp_GTrsf

OUT = Path(__file__).resolve().parent.parent / "out" / "ovo1"

# ------------------------------------------------------------ envelope
EGG_L = 470.0  # nose to tail
EGG_B = 270.0  # max width
EGG_W = 30.0  # Hügelschäffer shift: widest point 30 mm ahead of mid-length (blunt nose, long tail)
K = 0.60  # height / width of every cross-section: max height ≈ 162 mm
SHELL_T = 2.0  # outer skin (flanks; crown = SHELL_T*K)
GAP = 3.0  # water gap of the pillow-plate jacket
LINER_T = 1.0  # inner skin of the jacket
WALL = SHELL_T + GAP + LINER_T  # everything inside must clear this
Z_CUT = -62.0  # flat belly plane: the shell is open below here, closed by the stainless belly plate
KEEL_H = 18.0  # the egg floats this high above the table
Z_AXIS = KEEL_H - Z_CUT
JACKET_X = (12.0, 460.0)  # jacket extent along the body
SEAM_GAP = 2.5  # jacket stops this far either side of the equator seam

# ------------------------------------------------------------ internals (bottom to top)
Z_FAN = -50.0  # underside of the two 80x15 slim fans
FAN, FAN_T = 80.0, 15.0
Z_DECK = Z_FAN + FAN_T  # fan deck: seals the radiator so air must go through it
RAD = (160.0, 90.0, 25.0)  # belly radiator core X, Y, Z (≈ the face area of a 120 mm radiator)
X_RAD = 150.0
Z_TRAY = 4.0  # tray = ceiling of the air tunnel, floor of the electronics bay
ITX = 170.0
PCB_T = 1.6
X_BOARD = 150.0
Z_PCB = Z_TRAY + 1.5 + 6.0
PSU = (30.0, 101.6, 50.8)  # 300 W open-frame 12 V, on edge in the exhaust plenum: X, Y, Z
X_PSU, Z_PSU = 330.0, -28.0
PUMP_D, PUMP_L = 50.0, 90.0  # pump + reservoir cylinder, lying across the nose
X_PUMP, Z_PUMP = 92.0, 0.0
KEEL = (150.0, 56.0)  # keel length, width
X_KEEL = 160.0
EXHAUST_X = (154.0, 306.0)  # belly slots under the fans, either side of the keel: hot air leaves sideways
INTAKE_NOSE = (100.0, 141.0)  # belly slots under the nose
INTAKE_TAIL = (324.0, 368.0)  # belly slots under the tail
CLEAR = 3.0


# ============================================================ egg geometry
def egg_r(x):
    """Half-width of the body at station x (Hügelschäffer egg, blunt end at x=0)."""
    u = x - EGG_L / 2
    v = (EGG_L**2 - 4 * u * u) / (EGG_L**2 + 8 * EGG_W * u + 4 * EGG_W**2)
    return EGG_B / 2 * math.sqrt(max(v, 0.0))


def _profile(offset=0.0, n=60):
    pts = []
    for i in range(1, n):
        x = EGG_L / 2 * (1 - math.cos(math.pi * i / n))
        h = 0.01
        dr = (egg_r(x + h) - egg_r(x - h)) / (2 * h)
        nl = math.hypot(1.0, dr)
        pts.append((egg_r(x) - offset / nl, x + offset * dr / nl))
    return [(0.0, offset)] + pts + [(0.0, EGG_L - offset)]


def _scale_z(shape, k):
    gt = gp_GTrsf()
    gt.SetValue(3, 3, k)
    return cq.Shape.cast(BRepBuilderAPI_GTransform(shape, gt, True).Shape())


def egg_solid(offset=0.0):
    """Body solid: revolve the egg about X, then squash the cross-section to K."""
    pts = _profile(offset)
    rev = (
        cq.Workplane("XZ")
        .moveTo(*pts[0])
        .spline(pts[1:], tangents=[(1, 0), (-1, 0)], includeCurrent=True)
        .close()
        .revolve(360, (0, 0, 0), (0, 1, 0))
        .rotate((0, 0, 0), (0, 1, 0), 90)  # egg axis Z -> X
    )
    return cq.Workplane("XY").add(_scale_z(rev.val().wrapped, K))


_INNER_PTS = sorted(_profile(WALL, 400), key=lambda p: p[1])


def inner_ab(x):
    """Inner semi-axes (half-width, half-height) of the jacket liner at station x."""
    a = min(_INNER_PTS, key=lambda p: abs(p[1] - x))[0]
    return a, a * K


def box_between(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0).translate(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))


def slab_x(x0, x1):
    return box_between(x0, x1, -300, 300, -300, 300)


def slab_z(z0, z1):
    return box_between(-10, EGG_L + 10, -300, 300, z0, z1)


def cyl_y(d, y0, y1, x, z):
    return cq.Workplane("XZ").workplane(offset=-y0).center(x, z).circle(d / 2).extrude(-(y1 - y0))


OUTER = egg_solid()
SKIN_IN = egg_solid(SHELL_T)
WATER_IN = egg_solid(SHELL_T + GAP)
LINER_IN = egg_solid(WALL)


def _halves(solid):
    upper = solid.intersect(slab_z(0, 300))
    lower = solid.intersect(slab_z(Z_CUT, 0))
    return upper, lower


def _jacket_zone():
    """Where the jacket runs: most of the body, stopping short of the seam, the belly and the ends."""
    z = slab_z(SEAM_GAP, 300).union(slab_z(Z_CUT + 4, -SEAM_GAP))
    return z.intersect(slab_x(*JACKET_X))


# ============================================================ exterior (closed body)
def _slit_zone():
    return slab_z(-0.6, 0.6).intersect(slab_x(EGG_L - 75, EGG_L - 15))


def shell_upper():
    """Outer skin, upper half: deep-drawn 5052 aluminium. Closed nose to tail."""
    return _halves(OUTER.cut(SKIN_IN))[0].cut(_slit_zone())


def shell_lower():
    """Outer skin, lower half, open only at the flat belly."""
    s = _halves(OUTER.cut(SKIN_IN))[1].cut(_slit_zone())
    for x in (125.0, 355.0):  # belly plate screw bosses
        a = egg_r(x) - SHELL_T
        b = a * K
        y = a * math.sqrt(max(1 - (Z_CUT / b) ** 2, 0)) - 6
        for sy in (-1, 1):
            s = s.union(cq.Workplane("XY").workplane(offset=Z_CUT).center(x, sy * y).circle(4.5).extrude(8), clean=False)
    return s


def light_slit():
    """60 mm opal light pipe in the seam at the tail: the only light. Glows with generation speed."""
    return OUTER.intersect(_slit_zone()).cut(egg_solid(1.5))


def jacket_water():
    """The 3 mm water layer between outer skin and liner (shown so the section reads)."""
    return SKIN_IN.cut(WATER_IN).intersect(_jacket_zone())


def jacket_liner():
    """1 mm aluminium inner skin, dimple-welded to the outer skin every 25 mm (pillow plate)."""
    return WATER_IN.cut(LINER_IN).intersect(_jacket_zone())


def belly_plate():
    """1.5 mm 304 stainless, dark PVD. Intake slots under nose and tail, exhaust slots either side of the keel."""
    p = SKIN_IN.intersect(slab_z(Z_CUT, Z_CUT + 1.5))
    cuts = []
    for i in range(-20, 21):
        y = i * 4.0
        for x0, x1 in (INTAKE_NOSE, INTAKE_TAIL):
            cuts.append(box_between(x0, x1, y - 1.3, y + 1.3, Z_CUT - 1, Z_CUT + 3))
        if abs(y) > KEEL[1] / 2 + 4:
            cuts.append(box_between(EXHAUST_X[0], EXHAUST_X[1], y - 1.3, y + 1.3, Z_CUT - 1, Z_CUT + 3))
    c = cuts[0]
    for k in cuts[1:]:
        c = c.union(k)
    return p.cut(c)


def keel():
    """Solid 304 stainless keel, set in from every edge so the body hovers. Ports on its back end."""
    kl, kw = KEEL
    x0, x1 = X_KEEL, X_KEEL + kl
    z0 = Z_CUT - KEEL_H
    k = box_between(x0, x1, -kw / 2, kw / 2, z0, Z_CUT).edges("|Z").fillet(kw / 2 - 0.5).edges("<Z").fillet(3)
    k = k.cut(box_between(x1 - 8, x1 + 1, -kw / 2 - 1, kw / 2 + 1, z0 - 1, Z_CUT + 1))  # flat back face
    ports = [(-27, -15, 4, 13), (-13, -4, 6, 9.5), (-2, 7, 6, 9.5), (10, 26, 2, 16)]  # C7, USB4, USB4, RJ45
    for y0, y1, h0, h1 in ports:
        k = k.cut(box_between(x1 - 20, x1 - 7, y0, y1, z0 + h0, z0 + h1))
    return k


def foot():
    kl, kw = KEEL
    return box_between(X_KEEL + 6, X_KEEL + kl - 14, -kw / 2 + 4, kw / 2 - 4, Z_CUT - KEEL_H - 1, Z_CUT - KEEL_H).edges("|Z").fillet(kw / 2 - 5)


# ============================================================ cooling + core
def contour_plate(z0, z1, x0, x1, inset):
    """Flat plate cut to the liner's own contour, `inset` mm inside it."""
    return egg_solid(WALL + inset).intersect(slab_z(z0, z1)).intersect(slab_x(x0, x1))


def fans():
    f = None
    for k in range(2):
        x0 = X_RAD + k * FAN
        fr = box_between(x0, x0 + FAN, -FAN / 2, FAN / 2, Z_FAN, Z_FAN + FAN_T).edges("|Z").fillet(5)
        fr = fr.cut(cq.Workplane("XY").workplane(offset=Z_FAN - 1).center(x0 + FAN / 2, 0).circle(FAN / 2 - 2).extrude(FAN_T + 2))
        hub = cq.Workplane("XY").workplane(offset=Z_FAN + 1).center(x0 + FAN / 2, 0).circle(14).extrude(FAN_T - 2)
        for j in range(7):
            bl = box_between(x0 + FAN / 2 + 12, x0 + FAN / 2 + 37, -5, 5, Z_FAN + 6, Z_FAN + 8)
            bl = bl.rotate((x0 + FAN / 2 + 25, 0, Z_FAN + 7), (x0 + FAN / 2 + 26, 0, Z_FAN + 7), 30)
            hub = hub.union(bl.rotate((x0 + FAN / 2, 0, 0), (x0 + FAN / 2, 0, 1), j * 360 / 7))
        u = fr.union(hub)
        f = u if f is None else f.union(u)
    return f


def fan_deck():
    """Seals the air tunnel at the radiator so no air bypasses the core."""
    rx, ry, _ = RAD
    d = contour_plate(Z_DECK, Z_DECK + 1.5, X_RAD - 4, X_RAD + rx + 8, CLEAR + 1)
    return d.cut(box_between(X_RAD, X_RAD + rx, -ry / 2, ry / 2, Z_DECK - 1, Z_DECK + 3))


def baffles():
    """Front and rear walls of the exhaust plenum under the fan deck: exhaust can't mix with the intake bays."""
    rx = RAD[0]
    f = contour_plate(Z_CUT + 1.5, Z_DECK, X_RAD - 6, X_RAD - 4.5, CLEAR + 1)
    return f.union(contour_plate(Z_CUT + 1.5, Z_DECK, X_RAD + rx + 8, X_RAD + rx + 9.5, CLEAR + 1))


def radiator():
    """Aluminium flat-tube radiator (all-aluminium wetted loop: no galvanic corrosion)."""
    rx, ry, rz = RAD
    r = box_between(X_RAD, X_RAD + rx, -ry / 2, ry / 2, Z_DECK, Z_DECK + rz)
    for x in (X_RAD - 10, X_RAD + rx):  # end tanks
        r = r.union(box_between(x, x + 10, -ry / 2 - 2, ry / 2 + 2, Z_DECK, Z_DECK + rz))
    return r


def tray():
    """1.5 mm 304 stainless: ceiling of the air tunnel, floor of the board bay. Mini-ITX standoffs."""
    t = contour_plate(Z_TRAY, Z_TRAY + 1.5, X_RAD - 6, X_BOARD + ITX + 6, CLEAR + 1)
    for hx, hy in ((10.16, 6.35), (165.10, 6.35), (10.16, 163.83), (165.10, 163.83)):
        t = t.union(cq.Workplane("XY").workplane(offset=Z_TRAY + 1.5).center(X_BOARD + hx, -ITX / 2 + hy).circle(3).extrude(Z_PCB - Z_TRAY - 1.5))
    return t


def board():
    y0 = -ITX / 2
    pcb = box_between(X_BOARD, X_BOARD + ITX, y0, y0 + ITX, Z_PCB, Z_PCB + PCB_T)
    z = Z_PCB + PCB_T
    parts = [
        box_between(X_BOARD + ITX - 18, X_BOARD + ITX + 2, y0 + 4, y0 + 160, z, z + 14),  # I/O edge
        box_between(X_BOARD + 10, X_BOARD + 90, y0 + 4, y0 + 26, z, z + 3),  # M.2 2280
        box_between(X_BOARD + 4, X_BOARD + 14, 40, 80, z, z + 10),  # power header
    ]
    for p in parts:
        pcb = pcb.union(p)
    return pcb


def cold_plate():
    """Skived-fin aluminium cold plate on the SoC, with inlet/outlet barbs."""
    xc = X_BOARD + ITX / 2
    z = Z_PCB + PCB_T + 2.5
    c = box_between(xc - 38, xc + 38, -38, 38, z, z + 12).edges("|Z").fillet(6)
    for y in (-20, 20):
        c = c.union(cq.Workplane("XY").workplane(offset=z + 12).center(xc + 26, y).circle(5).extrude(10))
    return c


def pump():
    """DC pump + 150 ml reservoir in one cylinder across the nose; fill port under the belly."""
    return cyl_y(PUMP_D, -PUMP_L / 2, PUMP_L / 2, X_PUMP, Z_PUMP)


def psu():
    px, py, pz = PSU
    return box_between(X_PSU, X_PSU + px, -py / 2, py / 2, Z_PSU, Z_PSU + pz)


# ============================================================ checks
def check_clearance(parts):
    """Every vertex of every internal part must sit inside the jacket liner with CLEAR margin."""
    worst = (1e9, "")
    for name, shape in parts.items():
        for v in shape.vertices().vals():
            a, b = inner_ab(v.X)
            a, b = a - CLEAR, b - CLEAR
            f = (v.Y / a) ** 2 + (v.Z / b) ** 2 if a > 0 and b > 0 else 9
            worst = min(worst, ((1 - math.sqrt(min(f, 1))) * min(a, b) + CLEAR, name))
            if f > 1:
                raise SystemExit(f"CLEARANCE FAIL {name}: vertex ({v.X:.0f},{v.Y:.0f},{v.Z:.0f})")
    print(f"clearance OK — tightest: {worst[1]} ≈{worst[0]:.1f} mm")


def slot_area(x0, x1, plate):
    full = SKIN_IN.intersect(slab_z(Z_CUT, Z_CUT + 1.5)).intersect(slab_x(x0, x1)).val().Volume()
    return (full - plate.intersect(slab_x(x0, x1)).val().Volume()) / 1.5 / 100


def skin_area():
    """Outer skin area backed by the water jacket (m²) — the passive radiator."""
    faces = OUTER.intersect(_jacket_zone()).faces().vals()
    outer = [f for f in faces if f.geomType() not in ("PLANE",)]
    return sum(f.Area() for f in outer) / 1e6


# ============================================================ build
AL = cq.Color(0.80, 0.81, 0.83)
SS_DARK = cq.Color(0.18, 0.18, 0.20)


def build():
    core = {
        "pump": (pump(), cq.Color(0.20, 0.21, 0.23)),
        "fans": (fans(), cq.Color(0.16, 0.16, 0.17)),
        "radiator": (radiator(), cq.Color(0.68, 0.70, 0.73)),
        "fan_deck": (fan_deck(), cq.Color(0.55, 0.56, 0.58)),
        "baffles": (baffles(), cq.Color(0.55, 0.56, 0.58)),
        "tray": (tray(), cq.Color(0.62, 0.63, 0.65)),
        "board": (board(), cq.Color(0.10, 0.20, 0.14)),
        "cold_plate": (cold_plate(), cq.Color(0.72, 0.74, 0.77)),
        "psu": (psu(), cq.Color(0.25, 0.26, 0.28)),
    }
    check_clearance({k: v[0] for k, v in core.items() if k not in ("fan_deck", "baffles", "tray")})
    ext = {
        "shell_upper": (shell_upper(), AL),
        "shell_lower": (shell_lower(), AL),
        "jacket_water": (jacket_water(), cq.Color(0.15, 0.45, 0.85)),
        "jacket_liner": (jacket_liner(), cq.Color(0.70, 0.71, 0.73)),
        "light_slit": (light_slit(), cq.Color(0.96, 0.97, 1.0)),
        "belly_plate": (belly_plate(), SS_DARK),
        "keel": (keel(), cq.Color(0.30, 0.30, 0.32)),
        "foot": (foot(), cq.Color(0.08, 0.08, 0.08)),
    }
    return {**ext, **core}


EXPLODE = {"shell_upper": 160, "jacket_water": 0, "jacket_liner": 0, "belly_plate": -90, "keel": -150, "foot": -150}


def assembly(parts, exploded=False):
    assy = cq.Assembly(name="OVO-1_exploded" if exploded else "OVO-1")
    for name, (shape, color) in parts.items():
        if exploded and name in ("jacket_water", "jacket_liner"):
            continue  # they ride with the shells; hidden in the exploded view for clarity
        dz = EXPLODE.get(name, 0) if exploded else 0
        assy.add(shape, name=name, color=color, loc=cq.Location(cq.Vector(0, 0, Z_AXIS + dz)))
    return assy


if __name__ == "__main__":
    import shutil

    for d in ("step", "stl"):
        shutil.rmtree(OUT / d, ignore_errors=True)
        (OUT / d).mkdir(parents=True)
    parts = build()
    dens = {"shell_upper": 2.68, "shell_lower": 2.68, "jacket_liner": 2.68, "jacket_water": 1.04, "belly_plate": 8.0, "keel": 8.0, "tray": 8.0}
    mass = 0.0
    for name, (shape, _) in parts.items():
        cq.exporters.export(shape, str(OUT / "step" / f"{name}.step"))
        cq.exporters.export(shape, str(OUT / "stl" / f"{name}.stl"), tolerance=0.2, angularTolerance=0.2)
        bb = shape.val().BoundingBox()
        vol = shape.val().Volume() / 1000
        m = vol * dens.get(name, 0) / 1000
        mass += m
        print(f"{name:14s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm  vol={vol:7.1f} cm3" + (f"  {m:5.2f} kg" if m else ""))
    bp = parts["belly_plate"][0]
    intake = slot_area(*INTAKE_NOSE, bp) + slot_area(*INTAKE_TAIL, bp)
    print(f"intake open ≈ {intake:.0f} cm² (nose + tail)   exhaust open ≈ {slot_area(*EXHAUST_X, bp):.0f} cm²")
    print(f"water-backed skin ≈ {skin_area():.3f} m²   jacket water ≈ {parts['jacket_water'][0].val().Volume() / 1e6:.2f} L")
    print(f"enclosure + water mass ≈ {mass:.2f} kg; overall {EGG_L:.0f} L x {EGG_B:.0f} W x {Z_AXIS + EGG_B / 2 * K:.0f} H mm")
    assembly(parts).export(str(OUT / "OVO-1_assembly.step"))
    assembly(parts).export(str(OUT / "OVO-1_assembly.glb"))
    assembly(parts, exploded=True).export(str(OUT / "OVO-1_exploded.glb"))
    print("done")
