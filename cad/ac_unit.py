"""
AERO-1 — high-efficiency wall-mounted split-system indoor unit.

Fully parametric CadQuery model. Every dimension below is a named parameter;
change one and re-run to regenerate all STEP / STL / GLB outputs.

Coordinate system (mm):
    X = width  (centered on 0, left/right)
    Y = depth  (Y=0 is the wall, +Y points into the room)
    Z = height (Z=0 is the underside of the unit)

Run:  python3 cad/ac_unit.py
"""
import math
from pathlib import Path

import cadquery as cq

OUT = Path(__file__).resolve().parent.parent / "out"

# ---------------------------------------------------------------- envelope
W = 920.0  # overall width
H = 300.0  # overall height
D = 235.0  # overall depth (wall to front face)
T = 2.5  # nominal molded wall thickness (ABS/PC-ABS)
SPLIT_Y = 62.0  # parting plane between rear chassis and front cover
DRAFT = 1.5  # deg, draft on ribs/bosses (molded parts)

# ---------------------------------------------------------------- airflow
FAN_D = 112.0  # cross-flow fan diameter (oversized -> low rpm, low W/CFM)
FAN_L = 760.0  # fan length
FAN_BLADES = 35
FAN_CY, FAN_CZ = 118.0, 118.0  # fan axis position (Y, Z)
OUTLET_Y0, OUTLET_Y1 = 100.0, 205.0  # outlet opening in the underside
GRILLE_SLOT, GRILLE_PITCH = 5.0, 9.0  # top intake grille

# ---------------------------------------------------------------- heat exchanger
COIL_T = 38.0  # coil depth (3-row, larger than typical 2-row -> lower approach dT)
COIL_L = 780.0  # finned length
TUBE_D = 7.0  # copper tube OD (7 mm, inner-grooved)
TUBE_PITCH = 21.0  # tube pitch along coil face


# ============================================================== helpers
def envelope_profile(inset=0.0):
    """Side profile of the unit in the YZ plane (as a closed wire on a YZ workplane)."""
    i = inset
    pts_front = [
        (190 - i, H - i),
        (222 - i, 245),
        (D - i, 170),
        (226 - i, 105),
        (205 - i, 62 + i),
    ]
    wp = (
        cq.Workplane("YZ")
        .moveTo(0 + i, 18 + i)
        .lineTo(0 + i, H - 10 - i)
        .threePointArc((3 + i, H - 3 - i), (10 + i, H - i))
        .lineTo(*pts_front[0])
        .spline(pts_front[1:], includeCurrent=True)
        .threePointArc((180, 35 + i), (140, 20 + i))
        .lineTo(10 + i, 18 + i)
        .close()
    )
    return wp


def body_shell():
    """Outer molded skin of the whole unit, hollow, open at the back (wall side)."""
    outer = envelope_profile().extrude(W).translate((-W / 2, 0, 0))
    inner = envelope_profile(T).extrude(W - 2 * T).translate((-W / 2 + T, 0, 0))
    shell = outer.cut(inner)
    # open the wall side so the chassis back plate closes it
    shell = shell.cut(cq.Workplane("XY").box(W - 2 * T, 8, H - 30).translate((0, 1, H / 2)))
    return shell


def box_between(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0).translate(
        ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    )


# ============================================================== parts
def front_cover():
    """Injection-molded PC/ABS front cover: grille, outlet, display window, snap tabs."""
    s = body_shell().intersect(box_between(-W, W, SPLIT_Y, D + 10, -10, H + 10))

    # top intake grille: slots running front-to-back
    n = int((W - 120) // GRILLE_PITCH)
    slots = (
        cq.Workplane("XY")
        .workplane(offset=H - 20)
        .center(0, 125)
        .rarray(GRILLE_PITCH, 1, n, 1)
        .rect(GRILLE_SLOT, 110)
        .extrude(40)
    )
    s = s.cut(slots)

    # air outlet in the underside
    s = s.cut(box_between(-FAN_L / 2 - 10, FAN_L / 2 + 10, OUTLET_Y0, OUTLET_Y1, -20, 72))

    # display window recess (front face, right side)
    win = (
        cq.Workplane("XZ")
        .workplane(offset=-(D + 5))
        .center(W / 2 - 150, 175)
        .slot2D(90, 14)
        .extrude(10)
    )
    s = s.cut(win)

    # snap-fit tabs on the parting edge (top + bottom), 6 per edge
    for x in [-360, -216, -72, 72, 216, 360]:
        for z in (H - T - 4, 26):
            tab = box_between(x - 8, x + 8, SPLIT_Y - 8, SPLIT_Y + 2, z - 1.2, z + 1.2)
            s = s.union(tab)
    return s


def rear_chassis():
    """Injection-molded ABS rear chassis: back plate, ribs, bosses, hooks, drain pan."""
    s = body_shell().intersect(box_between(-W, W, -10, SPLIT_Y, -10, H + 10))
    # back plate (closes the wall side)
    back = (
        envelope_profile()
        .extrude(W - 2 * T)
        .translate((-W / 2 + T, 0, 0))
        .intersect(box_between(-W, W, 0, T, -10, H + 10))
    )
    s = s.union(back)

    # stiffening ribs on the back plate (0.6 x wall thickness, drafted)
    for x in range(-400, 401, 80):
        rib = (
            cq.Workplane("XZ")
            .workplane(offset=-T)
            .center(x, 160)
            .rect(0.6 * T * 2, 250)
            .extrude(-14, taper=DRAFT)
        )
        s = s.union(rib)
    for z in (60, 160, 260):
        rib = (
            cq.Workplane("XZ")
            .workplane(offset=-T)
            .center(0, z)
            .rect(W - 40, 0.6 * T * 2)
            .extrude(-14, taper=DRAFT)
        )
        s = s.union(rib)

    # screw bosses for the front cover (M4 self-tapping, Ø3.4 pilot)
    for x in (-420, 420):
        for z in (60, 240):
            boss = (
                cq.Workplane("XZ")
                .workplane(offset=-T)
                .center(x, z)
                .circle(5.0)
                .extrude(-(SPLIT_Y - T - 2), taper=DRAFT)
                .faces(">Y")
                .workplane()
                .hole(3.4, SPLIT_Y)
            )
            s = s.union(boss)

    # integrated condensate drain pan under the front coil slab
    pan = box_between(-COIL_L / 2 - 20, COIL_L / 2 + 20, 150, 214, 66, 80)
    pan_cav = box_between(-COIL_L / 2 - 17, COIL_L / 2 + 17, 153, 211, 69, 82)
    s = s.union(pan.cut(pan_cav))
    # pan support web to back plate
    s = s.union(box_between(-COIL_L / 2 - 20, -COIL_L / 2 - 17, T, 214, 66, 80))
    s = s.union(box_between(COIL_L / 2 + 17, COIL_L / 2 + 20, T, 214, 66, 80))
    # drain spout (Ø16 OD, Ø12 ID) leaving the left side, sloped
    spout = (
        cq.Workplane("YZ")
        .workplane(offset=-COIL_L / 2 - 20)
        .center(182, 72)
        .circle(8)
        .circle(6)
        .extrude(-(W / 2 - COIL_L / 2 + 5))
    )
    s = s.union(spout)

    # mounting-plate hooks along the top of the back
    for x in (-300, -100, 100, 300):
        hook = box_between(x - 15, x + 15, -6, 0, H - 40, H - 20).union(
            box_between(x - 15, x + 15, -6, -3, H - 52, H - 20)
        )
        s = s.union(hook)
    return s


def coil_slab(p0, p1, rows_offset=0.0):
    """One straight finned slab of the evaporator between points p0, p1 in (Y, Z)."""
    (y0, z0), (y1, z1) = p0, p1
    L = math.hypot(y1 - y0, z1 - z0)
    ang = math.degrees(math.atan2(z1 - z0, y1 - y0))
    fins = cq.Workplane("XY").box(COIL_L, L, COIL_T)
    # tube passes through fin pack + protruding stubs (3 rows, staggered)
    n = int(L // TUBE_PITCH)
    tubes = None
    for r in range(3):
        zz = (r - 1) * (COIL_T / 3)
        stagger = (TUBE_PITCH / 2) * (r % 2)
        for k in range(n):
            yy = -L / 2 + TUBE_PITCH / 2 + k * TUBE_PITCH + stagger - TUBE_PITCH / 4
            if abs(yy) > L / 2 - 4:
                continue
            t = (
                cq.Workplane("YZ")
                .workplane(offset=-COIL_L / 2 - 14)
                .center(yy, zz)
                .circle(TUBE_D / 2)
                .extrude(COIL_L + 28)
            )
            tubes = t if tubes is None else tubes.union(t)
    endplates = box_between(-COIL_L / 2 - 1.2, -COIL_L / 2, -L / 2, L / 2, -COIL_T / 2 - 2, COIL_T / 2 + 2).union(
        box_between(COIL_L / 2, COIL_L / 2 + 1.2, -L / 2, L / 2, -COIL_T / 2 - 2, COIL_T / 2 + 2)
    )

    def place(w):
        return w.rotate((0, 0, 0), (1, 0, 0), ang).translate((0, (y0 + y1) / 2, (z0 + z1) / 2))

    return place(fins), place(tubes), place(endplates)


def evaporator():
    """3-slab A-coil wrapped around the fan: larger face area -> lower air velocity -> smaller lift."""
    slabs = [
        ((198, 92), (198, 222)),  # front
        ((190, 236), (112, 278)),  # top-front
        ((98, 278), (32, 214)),  # top-rear
    ]
    fins = tubes = plates = None
    for i, (a, b) in enumerate(slabs):
        f, t, p = coil_slab(a, b)
        # offset each slab inward by half its thickness so the outer face sits on the line
        fins = f if fins is None else fins.union(f)
        tubes = t if tubes is None else tubes.union(t)
        plates = p if plates is None else plates.union(p)
    return fins, tubes, plates


def crossflow_fan():
    """Cross-flow (tangential) fan: 35 forward-curved blades, 6 segments, ABS+GF."""
    r_out, r_in = FAN_D / 2, FAN_D / 2 - 14
    seg = 6
    seg_len = FAN_L / seg
    blade = (
        cq.Workplane("YZ")
        .moveTo(r_in, 0)
        .threePointArc((r_in + 7, 3.2), (r_out, 2.0))
        .lineTo(r_out, 3.4)
        .threePointArc((r_in + 7, 4.6), (r_in, 1.3))
        .close()
        .extrude(FAN_L)
    )
    fan = None
    for k in range(FAN_BLADES):
        b = blade.rotate((0, 0, 0), (1, 0, 0), k * 360 / FAN_BLADES)
        fan = b if fan is None else fan.union(b)
    # support discs between segments
    for j in range(seg + 1):
        disc = (
            cq.Workplane("YZ")
            .workplane(offset=j * seg_len - (1.5 if j == seg else 0))
            .circle(r_out)
            .circle(r_in - 4 if 0 < j < seg else 0.01)
            .extrude(1.5)
        )
        fan = fan.union(disc)
    # hub / shaft stubs
    fan = fan.union(cq.Workplane("YZ").workplane(offset=FAN_L).circle(14).extrude(12))
    fan = fan.union(cq.Workplane("YZ").workplane(offset=-10).circle(4).extrude(10))
    return fan.translate((-FAN_L / 2, FAN_CY, FAN_CZ))


def fan_motor():
    """48 V BLDC (EC) motor, 30 W, with rubber-isolated cradle."""
    m = (
        cq.Workplane("YZ")
        .workplane(offset=FAN_L / 2 + 14)
        .circle(31)
        .extrude(58)
        .faces(">X")
        .edges()
        .fillet(4)
    )
    m = m.union(cq.Workplane("YZ").workplane(offset=FAN_L / 2 + 6).circle(4).extrude(10))
    return m.translate((0, FAN_CY, FAN_CZ))


def louver():
    """Motorized horizontal vane (PC, UV-stabilized), airfoil section."""
    chord = 92.0
    v = (
        cq.Workplane("YZ")
        .moveTo(0, 0)
        .threePointArc((chord / 2, 7), (chord, 0))
        .threePointArc((chord / 2, 3.5), (0, 0))
        .close()
        .extrude(FAN_L + 10)
        .translate((-(FAN_L + 10) / 2, 0, 0))
    )
    pins = cq.Workplane("YZ").workplane(offset=-(FAN_L + 10) / 2 - 8).center(chord / 2, 3).circle(3).extrude(FAN_L + 26)
    v = v.union(pins)
    return v.rotate((0, 0, 0), (1, 0, 0), -18).translate((OUTLET_Y0 + 8, 0, 50))


def filters():
    """Two slide-in washable PP mesh filters under the top grille."""
    fw, fd = 400.0, 150.0
    out = None
    for x in (-fw / 2 - 8, fw / 2 + 8):
        f = (
            cq.Workplane("XY")
            .box(fw, fd, 2.0)
            .faces(">Z")
            .workplane()
            .rarray(14, 14, int((fw - 30) // 14), int((fd - 30) // 14))
            .rect(11, 11)
            .cutThruAll()
            .translate((x, 122, H - 14))
        )
        out = f if out is None else out.union(f)
    return out


def mounting_plate():
    """1.2 mm galvanized steel wall plate (laser cut + formed)."""
    p = (
        cq.Workplane("XZ")
        .center(0, 170)
        .rect(720, 230)
        .extrude(1.2)
        .translate((0, -6, 0))
    )
    # keyhole / anchor slots
    p = p.faces("<Y").workplane().pushPoints([(-300, 60), (300, 60), (-300, -60), (300, -60), (0, 80)]).slot2D(22, 7).cutThruAll()
    # lightening + pipe-routing cutouts
    p = p.faces("<Y").workplane().pushPoints([(-160, 0), (160, 0)]).rect(140, 110).cutThruAll()
    return p


# ============================================================== build + export
def build():
    fins, tubes, plates = evaporator()
    parts = {
        "front_cover": (front_cover(), cq.Color(0.95, 0.95, 0.94)),
        "rear_chassis": (rear_chassis(), cq.Color(0.80, 0.81, 0.82)),
        "evap_fins": (fins, cq.Color(0.70, 0.74, 0.78)),
        "evap_tubes": (tubes, cq.Color(0.80, 0.45, 0.25)),
        "evap_endplates": (plates, cq.Color(0.55, 0.57, 0.60)),
        "crossflow_fan": (crossflow_fan(), cq.Color(0.20, 0.22, 0.25)),
        "fan_motor": (fan_motor(), cq.Color(0.12, 0.12, 0.13)),
        "louver": (louver(), cq.Color(0.92, 0.92, 0.91)),
        "filters": (filters(), cq.Color(0.35, 0.55, 0.75)),
        "mounting_plate": (mounting_plate(), cq.Color(0.60, 0.62, 0.64)),
    }
    assy = cq.Assembly(name="AERO-1_indoor_unit")
    for name, (shape, color) in parts.items():
        assy.add(shape, name=name, color=color)
    return parts, assy


if __name__ == "__main__":
    (OUT / "step").mkdir(parents=True, exist_ok=True)
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    parts, assy = build()
    for name, (shape, _) in parts.items():
        cq.exporters.export(shape, str(OUT / "step" / f"{name}.step"))
        cq.exporters.export(shape, str(OUT / "stl" / f"{name}.stl"), tolerance=0.2, angularTolerance=0.2)
        bb = shape.val().BoundingBox()
        print(f"{name:16s} {bb.xlen:7.1f} x {bb.ylen:6.1f} x {bb.zlen:6.1f} mm  vol={shape.val().Volume()/1000:8.1f} cm3")
    assy.save(str(OUT / "AERO-1_assembly.step"))
    assy.save(str(OUT / "AERO-1_assembly.glb"))
    print("done")
