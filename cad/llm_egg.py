"""
OVO-1 — local-LLM appliance shaped as an egg lying on its side: a flattened oval body that floats
on a hidden plinth. Aluminium body, stainless steel underside, plinth and tail nozzle.

Nothing on the top or the flanks: no vents, no buttons, no logo cut-outs. All of the function is on the
two ends you don't look at:
    - air IN  through a fine grille in the belly, under the nose (in shadow)
    - air OUT through the tail: a polished stainless nozzle lip with a dark recessed grille and a light ring
    - ports on the back face of the plinth, under the tail overhang
Air runs nose to tail in one straight line, like a jet engine: grille -> 120 mm fan -> heatsink -> PSU -> tail.

Compute: one Mini-ITX AMD Ryzen AI Max+ 395 ("Strix Halo") board with 128 GB unified LPDDR5X,
mounted flat on a stainless tray, heatsink fins running nose to tail.

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
EGG_L = 440.0  # nose to tail
EGG_B = 270.0  # max width
EGG_W = 30.0  # Hügelschäffer shift: widest point 30 mm ahead of mid-length (blunt nose, long tail)
K = 0.68  # height / width of every cross-section: flattened oval, max height ≈ 184 mm
SHELL_T = 2.5  # wall measured at the flanks; at the crown it is SHELL_T*K ≈ 1.7 mm
Z_CUT = -64.0  # flat belly plane: the shell is open below here, closed by the stainless belly plate
PLINTH_H = 18.0  # the egg floats this high above the table
Z_AXIS = PLINTH_H - Z_CUT  # egg axis height above the table
X_TAIL = 380.0  # tail opening (exhaust nozzle)
LIP = 6.0  # stainless nozzle lip length

# ------------------------------------------------------------ internals
FAN = 120.0  # 120x25 PWM fan, axis along X (Noctua NF-A12x25 class)
FAN_T = 25.0
X_FAN = 108.0
Z_FAN = 0.0  # fan centre height
PSU = (30.0, 101.6, 50.8)  # 300 W open-frame 12 V (Mean Well EPP-300-12 class), standing on edge: X, Y, Z
X_PSU, Z_PSU = 316.0, -30.0  # behind the board, in the exhaust stream
ITX = 170.0
PCB_T = 1.6
X_BOARD = 138.0  # front edge of the board
Z_PCB = -41.6  # underside of the PCB
Z_TRAY = -52.0  # stainless tray underside
HS = (110.0, 120.0)  # heatsink footprint (X, Y), centred on the SoC
HS_FIN_H = 45.0
GRILLE_X = (46.0, 105.0)  # intake slots in the belly plate, ahead of the fan
CLEAR = 3.0  # minimum part-to-shell clearance enforced by check_clearance()


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
        .revolve(360, (0, 0, 0), (0, 1, 0))  # about local Y = global Z
        .rotate((0, 0, 0), (0, 1, 0), 90)  # egg axis Z -> X
    )
    return cq.Workplane("XY").add(_scale_z(rev.val().wrapped, K))


_INNER_PTS = sorted(_profile(SHELL_T, 400), key=lambda p: p[1])


def inner_ab(x):
    """Inner semi-axes (half-width, half-height) of the shell at station x."""
    a = min(_INNER_PTS, key=lambda p: abs(p[1] - x))[0]
    return a, a * K


def box_between(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0).translate(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))


def slab_x(x0, x1):
    return box_between(x0, x1, -300, 300, -300, 300)


def slab_z(z0, z1):
    return box_between(-10, EGG_L + 10, -300, 300, z0, z1)


def cyl_x(d, x0, x1, y, z):
    return cq.Workplane("YZ").workplane(offset=x0).center(y, z).circle(d / 2).extrude(x1 - x0)


OUTER = egg_solid()
INNER = egg_solid(SHELL_T)
SHELL = OUTER.cut(INNER)


# ============================================================ exterior
def shell_upper():
    """Upper half, deep-drawn 5052 aluminium (opening = widest section, so it comes off the punch)."""
    return SHELL.intersect(slab_z(0, 300)).cut(slab_x(X_TAIL - LIP, EGG_L + 10))


def shell_lower():
    """Lower half: same, open at the flat belly. Meets the upper half on a 0.3 mm hairline at the equator."""
    s = SHELL.intersect(slab_z(Z_CUT, 0)).cut(slab_x(X_TAIL - LIP, EGG_L + 10))
    # four internal bosses the belly plate screws into
    for x in (115.0, 330.0):
        a, b = inner_ab(x)
        y = a * math.sqrt(max(1 - (Z_CUT / b) ** 2, 0)) - 6
        for sy in (-1, 1):
            s = s.union(cq.Workplane("XY").workplane(offset=Z_CUT).center(x, sy * y).circle(5).extrude(10))
    return s


def nozzle():
    """Polished 316 stainless tail lip: the only bright detail on the product."""
    return OUTER.intersect(slab_x(X_TAIL - LIP, X_TAIL)).cut(egg_solid(SHELL_T + 1.5))


def _ellipse_x(x0, x1, a, b):
    """Flat elliptical plate across the body between stations x0 and x1 (every section is an ellipse)."""
    return cq.Workplane("YZ").workplane(offset=x0).ellipse(a, b).extrude(x1 - x0)


def exhaust_grille():
    """Dark PVD stainless grille recessed 18 mm inside the nozzle: horizontal louvres, reads as a shadow."""
    x0 = X_TAIL - 20
    a, b = inner_ab(x0 + 1.5)
    g = _ellipse_x(x0, x0 + 1.5, a - 0.5, b - 0.5)
    slots = None
    for i in range(-19, 20):
        sl = box_between(x0 - 1, x0 + 3, -a + 6, a - 6, i * 3.0 - 1.0, i * 3.0 + 1.0)
        slots = sl if slots is None else slots.union(sl)
    g = g.cut(slots.intersect(_ellipse_x(x0 - 2, x0 + 4, a - 4.5, b - 4.5)))
    return g


def light_ring():
    """Opal light pipe just inside the nozzle lip: glows with generation speed."""
    x0 = X_TAIL - LIP - 3
    a, b = inner_ab(x0 + 2)
    return _ellipse_x(x0, x0 + 2, a - 0.5, b - 0.5).cut(_ellipse_x(x0 - 1, x0 + 3, a - 3, b - 3))


def belly_plate():
    """1.5 mm 304 stainless, dark PVD. Closes the flat underside; carries the intake grille."""
    p = INNER.intersect(slab_z(Z_CUT, Z_CUT + 1.5)).translate((0, 0, -0.0))
    # fine intake slots under the nose, ahead of the fan
    for i in range(-18, 19):
        p = p.cut(box_between(GRILLE_X[0], GRILLE_X[1], i * 4.0 - 1.3, i * 4.0 + 1.3, Z_CUT - 1, Z_CUT + 3))
    return p


def plinth():
    """Solid 304 stainless puck, set far in from the edge so the body seems to float. Ports on its back."""
    xc, ax, ay = 225.0, 80.0, 52.0
    p = (
        cq.Workplane("XY")
        .workplane(offset=Z_CUT - PLINTH_H)
        .center(xc, 0)
        .ellipse(ax, ay)
        .extrude(PLINTH_H)
        .edges("<Z")
        .fillet(3)
    )
    x_back = xc + ax - 10
    p = p.cut(box_between(x_back, xc + ax + 1, -60, 60, Z_CUT - PLINTH_H - 1, Z_CUT + 1))
    z0 = Z_CUT - PLINTH_H
    ports = [
        (-34, -22, 4, 13),  # IEC C7 (figure-8) inlet
        (-14, -5, 6, 9.5),  # USB4 (USB-C)
        (-2, 7, 6, 9.5),  # USB4 (USB-C)
        (14, 30, 3, 16),  # 5GbE RJ45
    ]
    for y0, y1, h0, h1 in ports:
        p = p.cut(box_between(x_back - 12, x_back + 1, y0, y1, z0 + h0, z0 + h1))
    return p


def foot():
    """Silicone pad under the plinth."""
    return cq.Workplane("XY").workplane(offset=Z_CUT - PLINTH_H - 0.01).center(225, 0).ellipse(74, 46).extrude(1.0)


# ============================================================ core
def tray():
    """1.5 mm 304 stainless tray: board standoffs, PSU and fan brackets. Screws to the shell bosses."""
    # outline = the shell's own inner contour, offset in, so the tray follows the egg
    t = egg_solid(SHELL_T + CLEAR + 3).intersect(slab_z(Z_TRAY, Z_TRAY + 1.5)).intersect(slab_x(X_FAN + FAN_T, X_BOARD + ITX + 6))
    # fan bracket: upright plate with the fan bore
    br = box_between(X_FAN + FAN_T, X_FAN + FAN_T + 1.5, -64, 64, Z_FAN - 62, Z_FAN + 62)
    br = br.cut(cyl_x(FAN - 4, X_FAN + FAN_T - 1, X_FAN + FAN_T + 3, 0, Z_FAN))
    t = t.union(br)
    # Mini-ITX standoffs (157.48 x 154.94 pattern)
    for hx, hy in ((10.16, 6.35), (165.10, 6.35), (10.16, 163.83), (165.10, 163.83)):
        t = t.union(
            cq.Workplane("XY").workplane(offset=Z_TRAY + 1.5).center(X_BOARD + hx, -ITX / 2 + hy).circle(3).extrude(Z_PCB - Z_TRAY - 1.5)
        )
    return t


def board():
    y0 = -ITX / 2
    pcb = box_between(X_BOARD, X_BOARD + ITX, y0, y0 + ITX, Z_PCB, Z_PCB + PCB_T)
    z = Z_PCB + PCB_T
    xc = X_BOARD + ITX / 2
    parts = [
        box_between(xc - 25, xc + 25, -25, 25, z, z + 2.5),  # SoC
        box_between(X_BOARD + ITX - 18, X_BOARD + ITX + 4, y0 + 4, y0 + 160, z, z + 14),  # rear I/O edge, toward the tail
        box_between(X_BOARD + 10, X_BOARD + 90, y0 + 4, y0 + 26, z, z + 3),  # M.2 2280
        box_between(X_BOARD + 4, X_BOARD + 14, 40, 80, z, z + 10),  # power header
    ]
    for p in parts:
        pcb = pcb.union(p)
    return pcb


def heatsink():
    """Vapour-chamber base + 0.4 mm Al fins running nose-to-tail."""
    xc = X_BOARD + ITX / 2
    hx, hy = HS
    z0 = Z_PCB + PCB_T + 2.5
    hs = box_between(xc - hx / 2, xc + hx / 2, -hy / 2, hy / 2, z0, z0 + 5)
    n = 26
    for i in range(n):
        y = -hy / 2 + hy / n * (i + 0.5)
        hs = hs.union(box_between(xc - hx / 2, xc + hx / 2, y - 0.6, y + 0.6, z0 + 5, z0 + 5 + HS_FIN_H))
    return hs


def duct():
    """0.8 mm Al shroud: fan outlet -> heatsink fins -> tail. No air bypasses the fins."""
    xc = X_BOARD + ITX / 2
    hx, hy = HS
    z_top = Z_PCB + PCB_T + 2.5 + 5 + HS_FIN_H + 1
    x0, x1 = X_FAN + FAN_T + 1.5, xc + hx / 2
    d = box_between(x0, x1, -hy / 2 - 2, -hy / 2 - 1.2, Z_PCB + PCB_T, z_top)
    d = d.union(box_between(x0, x1, hy / 2 + 1.2, hy / 2 + 2, Z_PCB + PCB_T, z_top))
    d = d.union(box_between(x0, x1, -hy / 2 - 2, hy / 2 + 2, z_top, z_top + 0.8))
    return d


def fan():
    x0 = X_FAN
    frame = box_between(x0, x0 + FAN_T, -FAN / 2, FAN / 2, Z_FAN - FAN / 2, Z_FAN + FAN / 2).edges("|X").fillet(7)
    frame = frame.cut(cyl_x(FAN - 4, x0 - 1, x0 + FAN_T + 1, 0, Z_FAN))
    for k in range(4):
        frame = frame.union(
            box_between(x0 + FAN_T - 3, x0 + FAN_T, -1.5, 1.5, 20, 58).translate((0, 0, Z_FAN)).rotate((0, 0, Z_FAN), (1, 0, Z_FAN), 45 + 90 * k)
        )
    rotor = cyl_x(40, x0 + 2, x0 + FAN_T - 2, 0, Z_FAN)
    for k in range(7):
        blade = box_between(x0 + FAN_T / 2 - 1, x0 + FAN_T / 2 + 1, -8, 8, 16, 56).translate((0, 0, Z_FAN))
        xm = x0 + FAN_T / 2
        blade = blade.rotate((xm, 0, Z_FAN), (xm, 0, Z_FAN + 1), 30)  # blade pitch
        rotor = rotor.union(blade.rotate((0, 0, Z_FAN), (1, 0, Z_FAN), k * 360 / 7))
    return frame, rotor


def psu():
    px, py, pz = PSU
    return box_between(X_PSU, X_PSU + px, -py / 2, py / 2, Z_PSU, Z_PSU + pz)


# ============================================================ checks
def check_clearance(parts):
    """Every vertex of every internal part must sit inside the shell's inner surface with CLEAR margin."""
    worst = (1e9, "")
    for name, shape in parts.items():
        for v in shape.vertices().vals():
            a, b = inner_ab(v.X)
            a, b = a - CLEAR, b - CLEAR
            f = (v.Y / a) ** 2 + (v.Z / b) ** 2 if a > 0 and b > 0 else 9
            gap = (1 - math.sqrt(f)) * min(a, b) if f < 9 else -99  # approximate radial gap beyond CLEAR
            worst = min(worst, (gap + CLEAR, name))
            if f > 1:
                raise SystemExit(f"CLEARANCE FAIL {name}: vertex ({v.X:.0f},{v.Y:.0f},{v.Z:.0f})")
    print(f"clearance OK — tightest: {worst[1]} ≈{worst[0]:.1f} mm")


def intake_area():
    """Open area of the belly grille that actually sits under the shell opening (cm²)."""
    g = belly_plate()
    full = INNER.intersect(slab_z(Z_CUT, Z_CUT + 1.5)).intersect(slab_x(*GRILLE_X))
    return (full.val().Volume() - g.intersect(slab_x(*GRILLE_X)).val().Volume()) / 1.5 / 100


def exhaust_area():
    x0 = X_TAIL - 20
    a, b = inner_ab(x0 + 1.5)
    full = math.pi * (a - 0.5) * (b - 0.5) * 1.5
    return (full - exhaust_grille().val().Volume()) / 1.5 / 100


# ============================================================ build
AL = cq.Color(0.80, 0.81, 0.83)
SS_POL = cq.Color(0.92, 0.92, 0.94)
SS_DARK = cq.Color(0.18, 0.18, 0.20)


def build():
    fan_frame, fan_rotor = fan()
    core = {
        "tray": (tray(), cq.Color(0.62, 0.63, 0.65)),
        "board": (board(), cq.Color(0.10, 0.20, 0.14)),
        "heatsink_fins": (heatsink(), cq.Color(0.85, 0.62, 0.42)),
        "duct": (duct(), cq.Color(0.70, 0.71, 0.73)),
        "fan_frame": (fan_frame, cq.Color(0.16, 0.16, 0.17)),
        "fan_rotor": (fan_rotor, cq.Color(0.22, 0.22, 0.24)),
        "psu": (psu(), cq.Color(0.25, 0.26, 0.28)),
    }
    check_clearance({k: v[0] for k, v in core.items()})
    ext = {
        "shell_upper": (shell_upper(), AL),
        "shell_lower": (shell_lower(), AL),
        "nozzle": (nozzle(), SS_POL),
        "light_ring": (light_ring(), cq.Color(0.96, 0.97, 1.0)),
        "exhaust_grille": (exhaust_grille(), SS_DARK),
        "belly_plate": (belly_plate(), SS_DARK),
        "plinth": (plinth(), cq.Color(0.30, 0.30, 0.32)),
        "foot": (foot(), cq.Color(0.08, 0.08, 0.08)),
    }
    return {**ext, **core}


EXPLODE = {"shell_upper": (0, 180), "belly_plate": (0, -90), "plinth": (0, -150), "foot": (0, -150)}


def assembly(parts, exploded=False):
    assy = cq.Assembly(name="OVO-1_exploded" if exploded else "OVO-1")
    for name, (shape, color) in parts.items():
        dx, dz = EXPLODE.get(name, (0, 0)) if exploded else (0, 0)
        assy.add(shape, name=name, color=color, loc=cq.Location(cq.Vector(dx, 0, Z_AXIS + dz)))
    return assy


if __name__ == "__main__":
    import shutil

    for d in ("step", "stl"):
        shutil.rmtree(OUT / d, ignore_errors=True)
        (OUT / d).mkdir(parents=True)
    parts = build()
    dens = {"shell_upper": 2.68, "shell_lower": 2.68, "nozzle": 8.0, "exhaust_grille": 8.0, "belly_plate": 8.0, "plinth": 8.0, "tray": 8.0}
    mass = 0.0
    for name, (shape, _) in parts.items():
        cq.exporters.export(shape, str(OUT / "step" / f"{name}.step"))
        cq.exporters.export(shape, str(OUT / "stl" / f"{name}.stl"), tolerance=0.2, angularTolerance=0.2)
        bb = shape.val().BoundingBox()
        vol = shape.val().Volume() / 1000
        m = vol * dens.get(name, 0) / 1000
        mass += m
        print(f"{name:14s} {bb.xlen:6.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm  vol={vol:7.1f} cm3" + (f"  {m:5.2f} kg" if m else ""))
    print(f"intake open area ≈ {intake_area():.0f} cm²   exhaust open area ≈ {exhaust_area():.0f} cm²")
    print(f"metal enclosure mass ≈ {mass:.2f} kg; overall {EGG_L:.0f} L x {EGG_B:.0f} W x {Z_AXIS + EGG_B / 2 * K:.0f} H mm")
    assembly(parts).export(str(OUT / "OVO-1_assembly.step"))
    assembly(parts).export(str(OUT / "OVO-1_assembly.glb"))
    assembly(parts, exploded=True).export(str(OUT / "OVO-1_exploded.glb"))
    print("done")
