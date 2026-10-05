"""
SWEEP-1 — waterless, self-powered cleaning robot for solar rows (1P trackers / fixed tilt).

The robot spans one module in portrait and rides the top and bottom module frame lips.
A single drive motor turns one line shaft that carries the drive wheel at BOTH ends, so
the two ends can never get out of sync (no racking, no second motor, no sync electronics).
A rotating microfiber/nylon brush sweeps dust downslope; nightly run, no water.

Coordinate system (mm), before the tracker tilt is applied:
    X = along the row (robot travel direction)
    Y = across the module, up-slope (0 = bottom frame outer edge)
    Z = normal to the glass (0 = top of module frame)

Run:  python3 cad/solar_cleaner.py
"""
from pathlib import Path

import cadquery as cq

OUT = Path(__file__).resolve().parent.parent / "out" / "sweep1"

# ------------------------------------------------------------ site / module (context)
MOD_L = 2382.0  # module length (portrait, across the row) — 182/210 mm cell class
MOD_W = 1134.0  # module width (along the row)
MOD_GAP = 20.0  # gap between modules along the row
FRAME_H = 35.0  # frame height
FRAME_LIP = 30.0  # frame lip width (wheel track)
N_MODS = 4  # modules shown in context
TILT = 25.0  # tracker / fixed tilt angle, deg

# ------------------------------------------------------------ robot
WHEEL_D, WHEEL_W = 80.0, 24.0  # PU-tread drive/idler wheels on the frame lip
WHEEL_PITCH = 300.0  # wheel spacing along X (front/back)
GUIDE_D = 26.0  # side guide rollers on the frame outer face
SHAFT_D = 25.0  # Al 6061 line shaft tube, Ø25 x 2
BRUSH_D, BRUSH_CORE = 130.0, 40.0
BRUSH_L = MOD_L - 2 * FRAME_LIP - 10  # brush runs between frame lips
BEAM_W, BEAM_H = 45.0, 90.0  # 45x90 Al extrusion spine
BEAM_Z0 = 150.0  # beam underside height above frame top
PV_W, PV_T = 160.0, 22.0  # onboard PV strip (≈ 40 W)
TRUCK = (340.0, 150.0, 170.0)  # drive/electronics truck at the low end (X, Y, Z)

WHEEL_Z = WHEEL_D / 2  # wheel axle height (wheel sits on frame top, Z=0)
Y_LOW = FRAME_LIP / 2  # wheel track centre, bottom frame
Y_HIGH = MOD_L - FRAME_LIP / 2  # wheel track centre, top frame


def box_between(x0, x1, y0, y1, z0, z1):
    return cq.Workplane("XY").box(x1 - x0, y1 - y0, z1 - z0).translate(
        ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    )


def cyl_y(d, y0, y1, x, z, bore=0.0):
    """Cylinder along Y from y0 to y1, centred at (x, z)."""
    w = cq.Workplane("XZ").workplane(offset=-y0).center(x, z).circle(d / 2)
    if bore:
        w = w.circle(bore / 2)
    return w.extrude(-(y1 - y0))


# ============================================================ context: array
def modules():
    frames = glass = None
    for i in range(N_MODS):
        x0 = i * (MOD_W + MOD_GAP)
        f = box_between(x0, x0 + MOD_W, 0, MOD_L, -FRAME_H, 0).cut(
            box_between(x0 + FRAME_LIP, x0 + MOD_W - FRAME_LIP, FRAME_LIP, MOD_L - FRAME_LIP, -FRAME_H - 1, 1)
        )
        g = box_between(x0 + FRAME_LIP - 5, x0 + MOD_W - FRAME_LIP + 5, FRAME_LIP - 5, MOD_L - FRAME_LIP + 5, -5.2, -2.0)
        frames = f if frames is None else frames.union(f)
        glass = g if glass is None else glass.union(g)
    return frames, glass


def tracker():
    """Torque tube + purlins + one pier (context only)."""
    L = N_MODS * (MOD_W + MOD_GAP)
    tube = cq.Workplane("YZ").center(MOD_L / 2, -FRAME_H - 90).rect(130, 130).extrude(L + 400).translate((-200, 0, 0))
    for i in range(N_MODS + 1):
        x = i * (MOD_W + MOD_GAP) - MOD_GAP / 2
        tube = tube.union(box_between(x - 20, x + 20, 300, MOD_L - 300, -FRAME_H - 25, -FRAME_H))
    return tube


TUBE_Z = -FRAME_H - 90  # torque-tube axis height (tilt pivot)


def pier():
    """W6x9 driven pier + bearing housing (stays vertical; the table tilts about the tube)."""
    L = N_MODS * (MOD_W + MOD_GAP)
    p = box_between(L / 2 - 75, L / 2 + 75, MOD_L / 2 - 50, MOD_L / 2 + 50, TUBE_Z - 2400, TUBE_Z - 110)
    brg = cq.Workplane("YZ").workplane(offset=L / 2 - 60).center(MOD_L / 2, TUBE_Z).circle(110).circle(95).extrude(120)
    return p.union(brg).union(box_between(L / 2 - 60, L / 2 + 60, MOD_L / 2 - 110, MOD_L / 2 + 110, TUBE_Z - 120, TUBE_Z - 100))


def dock():
    """Parking dock at the row end: two short rails that continue the frame lips + bracket."""
    x0, x1 = -520.0, -MOD_GAP
    d = box_between(x0, x1, 0, FRAME_LIP, -FRAME_H, 0).union(box_between(x0, x1, MOD_L - FRAME_LIP, MOD_L, -FRAME_H, 0))
    # end stops
    d = d.union(box_between(x0, x0 + 8, 0, FRAME_LIP, 0, 40)).union(box_between(x0, x0 + 8, MOD_L - FRAME_LIP, MOD_L, 0, 40))
    # cross members to torque tube clamp
    d = d.union(box_between(x0 + 40, x0 + 100, 0, MOD_L, -FRAME_H - 25, -FRAME_H))
    return d


# ============================================================ robot parts
ROBOT_X = 1700.0  # robot position along the row (mid-array) for the assembly


def spine():
    """45x90 6063-T6 extrusion, T-slot, with end plates."""
    b = box_between(-BEAM_W / 2, BEAM_W / 2, -60, MOD_L + 60, BEAM_Z0, BEAM_Z0 + BEAM_H)
    # T-slot grooves (simplified) on both sides
    for z in (BEAM_Z0 + 22, BEAM_Z0 + BEAM_H - 22):
        b = b.cut(box_between(-BEAM_W / 2 - 1, -BEAM_W / 2 + 5, -61, MOD_L + 61, z - 4, z + 4))
        b = b.cut(box_between(BEAM_W / 2 - 5, BEAM_W / 2 + 1, -61, MOD_L + 61, z - 4, z + 4))
    # hollow core
    b = b.cut(box_between(-BEAM_W / 2 + 4, BEAM_W / 2 - 4, -61, MOD_L + 61, BEAM_Z0 + 30, BEAM_Z0 + BEAM_H - 30))
    return b


def end_plate(y_face, outward):
    """6 mm 5052 aluminium end plate: carries wheels, guide rollers, shaft bearing."""
    t = 6.0
    y0, y1 = (y_face, y_face + t) if outward > 0 else (y_face - t, y_face)
    p = box_between(-WHEEL_PITCH / 2 - 40, WHEEL_PITCH / 2 + 40, y0, y1, -FRAME_H - 10, BEAM_Z0 + BEAM_H)
    # lightening window
    p = p.cut(box_between(-80, 80, y0 - 1, y1 + 1, WHEEL_D + 20, BEAM_Z0 - 10))
    # shaft / axle bores
    for x in (-WHEEL_PITCH / 2, WHEEL_PITCH / 2):
        p = p.cut(cyl_y(12, y0 - 1, y1 + 1, x, WHEEL_Z))
    return p


def wheels():
    """4 drive + 4 idler PU wheels (Shore 85A tread on glass-filled PA hub)."""
    w = None
    for y in (Y_LOW, Y_HIGH):
        for x in (-WHEEL_PITCH / 2, WHEEL_PITCH / 2):
            wh = cyl_y(WHEEL_D, y - WHEEL_W / 2, y + WHEEL_W / 2, x, WHEEL_Z, bore=12)
            w = wh if w is None else w.union(wh)
    return w


def guide_rollers():
    """Vertical-axis rollers bearing on the frame outer faces: keep the robot on the row."""
    r = None
    for y, sgn in ((0.0, -1), (MOD_L, 1)):
        for x in (-WHEEL_PITCH / 2 + 40, WHEEL_PITCH / 2 - 40):
            c = (
                cq.Workplane("XY")
                .workplane(offset=-FRAME_H + 4)
                .center(x, y + sgn * GUIDE_D / 2)
                .circle(GUIDE_D / 2)
                .extrude(26)
            )
            # bracket from roller up to end plate
            yb0, yb1 = (-40, -6) if sgn < 0 else (MOD_L + 6, MOD_L + 40)
            br = box_between(x - 14, x + 14, yb0, yb1, -FRAME_H + 30, 10)
            r = c.union(br) if r is None else r.union(c).union(br)
    return r


def line_shaft():
    """Ø25x2 tube linking BOTH drive wheels — mechanical sync, no racking."""
    s = cyl_y(SHAFT_D, -46, MOD_L + 46, WHEEL_PITCH / 2, WHEEL_Z, bore=SHAFT_D - 4)
    # stub axles for the four idler wheels (plate -> wheel)
    for y0, y1 in ((-46, Y_LOW + WHEEL_W / 2), (Y_HIGH - WHEEL_W / 2, MOD_L + 46)):
        s = s.union(cyl_y(12, y0, y1, -WHEEL_PITCH / 2, WHEEL_Z))
    # two mid-span bearing hangers bolted to the spine
    for y in (MOD_L / 3, 2 * MOD_L / 3):
        h = box_between(WHEEL_PITCH / 2 - 18, WHEEL_PITCH / 2 + 18, y - 6, y + 6, WHEEL_Z - 18, BEAM_Z0)
        h = h.union(box_between(-BEAM_W / 2, WHEEL_PITCH / 2 + 18, y - 6, y + 6, BEAM_Z0 - 8, BEAM_Z0))
        h = h.cut(cyl_y(SHAFT_D + 1, y - 7, y + 7, WHEEL_PITCH / 2, WHEEL_Z))
        s = s.union(h)
    return s


def brush():
    """Ø130 helical-strip brush cartridge: microfiber + nylon 6.12, quick-release ends."""
    z = BRUSH_D / 2 - 4  # 4 mm interference with the glass
    y0, y1 = FRAME_LIP + 5, FRAME_LIP + 5 + BRUSH_L
    b = cyl_y(BRUSH_D, y0, y1, 0, z)
    # 10 longitudinal flutes give the "strip" brush look and are where bristle strips seat
    for k in range(10):
        groove = box_between(-3, 3, y0 - 1, y1 + 1, z + BRUSH_D / 2 - 14, z + BRUSH_D / 2 + 2).rotate(
            (0, 0, z), (0, 1, z), k * 36
        )
        b = b.cut(groove)
    b = b.union(cyl_y(16, -46, MOD_L + 46, 0, z))  # quick-release axle, plate to plate
    return b


def brush_hood():
    """1.2 mm aluminium hood over the brush: directs dust downslope, stiffens the frame."""
    z = BRUSH_D / 2 - 4
    y0, y1 = FRAME_LIP, MOD_L - FRAME_LIP
    outer = cyl_y(BRUSH_D + 26, y0, y1, 0, z)
    inner = cyl_y(BRUSH_D + 23.6, y0 - 1, y1 + 1, 0, z)
    hood = outer.cut(inner).cut(box_between(-200, 200, y0 - 2, y1 + 2, -50, z))  # keep upper half
    hood = hood.union(box_between(-18, 18, y0, y1, z + BRUSH_D / 2 + 10, BEAM_Z0))  # web to spine
    return hood


def drive_truck():
    """IP66 ASA enclosure at the low end: BLDC gearmotors, LiFePO4, controller, LoRa."""
    tx, ty, tz = TRUCK
    y1 = -40.0
    y0 = y1 - ty
    body = box_between(-tx / 2, tx / 2, y0, y1, 0, tz).edges("|Y").fillet(14)
    shell = body.cut(box_between(-tx / 2 + 3, tx / 2 - 3, y0 + 3, y1 - 3, 3, tz - 3))
    # gasketed lid seam
    shell = shell.cut(box_between(-tx / 2 - 1, tx / 2 + 1, y0 - 1, y1 + 1, tz - 22, tz - 20))
    # cable gland + vent
    shell = shell.union(cyl_y(20, y0 - 14, y0, -tx / 2 + 50, 60))
    shell = shell.union(cyl_y(14, y0 - 8, y0, tx / 2 - 50, 60))
    # status light pipe
    shell = shell.union(cq.Workplane("XY").workplane(offset=tz).center(0, (y0 + y1) / 2).circle(8).extrude(4))
    # mounting flange to the end plate
    shell = shell.union(box_between(-tx / 2, tx / 2, y1, y1 + 14, 20, tz - 30))
    return shell


def motors():
    """Drive gearmotor (on the line shaft) + brush motor, visible through the truck."""
    m = cyl_y(56, -120, -46, WHEEL_PITCH / 2, WHEEL_Z)  # drive motor coaxial with line shaft
    m = m.union(cyl_y(48, -120, -46, 0, BRUSH_D / 2 - 4))  # brush motor coaxial with brush
    return m


def pv_strip():
    """Onboard PV strip on top of the spine (charges the battery while parked)."""
    z0 = BEAM_Z0 + BEAM_H + 6
    p = box_between(-PV_W / 2, PV_W / 2, 40, MOD_L - 40, z0, z0 + PV_T)
    cells = None
    for k in range(14):
        y = 70 + k * 162
        c = box_between(-PV_W / 2 + 8, PV_W / 2 - 8, y, y + 150, z0 + PV_T - 0.5, z0 + PV_T + 0.5)
        cells = c if cells is None else cells.union(c)
    # standoffs to the spine
    for y in (300, MOD_L / 2, MOD_L - 300):
        p = p.union(box_between(-12, 12, y - 12, y + 12, BEAM_Z0 + BEAM_H, z0))
    return p, cells


# ============================================================ build
def build():
    frames, glass = modules()
    pv, cells = pv_strip()
    robot = {
        "spine": (spine(), cq.Color(0.78, 0.80, 0.82)),
        "end_plate_low": (end_plate(-40, -1), cq.Color(0.62, 0.64, 0.67)),
        "end_plate_high": (end_plate(MOD_L + 40, 1), cq.Color(0.62, 0.64, 0.67)),
        "wheels": (wheels(), cq.Color(0.95, 0.55, 0.12)),
        "guide_rollers": (guide_rollers(), cq.Color(0.20, 0.20, 0.22)),
        "line_shaft": (line_shaft(), cq.Color(0.70, 0.72, 0.75)),
        "brush": (brush(), cq.Color(0.98, 0.78, 0.18)),
        "brush_hood": (brush_hood(), cq.Color(0.90, 0.91, 0.92)),
        "drive_truck": (drive_truck(), cq.Color(0.16, 0.17, 0.19)),
        "motors": (motors(), cq.Color(0.35, 0.36, 0.38)),
        "pv_strip": (pv, cq.Color(0.85, 0.86, 0.88)),
        "pv_cells": (cells, cq.Color(0.08, 0.12, 0.28)),
    }
    context = {
        "module_frames": (frames, cq.Color(0.72, 0.74, 0.77)),
        "module_glass": (glass, cq.Color(0.10, 0.16, 0.32)),
        "tracker": (tracker(), cq.Color(0.55, 0.57, 0.58)),
        "dock": (dock(), cq.Color(0.95, 0.55, 0.12)),
    }
    return robot, context


def assembly(robot, context):
    # table tilts about the torque-tube axis; the pier stays vertical
    pivot = cq.Vector(0, MOD_L / 2, TUBE_Z)
    tilt = cq.Location(pivot) * cq.Location(cq.Vector(), cq.Vector(1, 0, 0), TILT) * cq.Location(-pivot)
    assy = cq.Assembly(name="SWEEP-1_on_row")
    table = cq.Assembly(name="table", loc=tilt)
    bot = cq.Assembly(name="SWEEP-1_robot", loc=cq.Location(cq.Vector(ROBOT_X, 0, 0)))
    for name, (shape, color) in robot.items():
        bot.add(shape, name=name, color=color)
    table.add(bot)
    for name, (shape, color) in context.items():
        table.add(shape, name=name, color=color)
    assy.add(table)
    assy.add(pier(), name="pier", color=cq.Color(0.50, 0.52, 0.53))
    return assy


if __name__ == "__main__":
    (OUT / "step").mkdir(parents=True, exist_ok=True)
    (OUT / "stl").mkdir(parents=True, exist_ok=True)
    robot, context = build()
    for name, (shape, _) in robot.items():
        cq.exporters.export(shape, str(OUT / "step" / f"{name}.step"))
        cq.exporters.export(shape, str(OUT / "stl" / f"{name}.stl"), tolerance=0.3, angularTolerance=0.3)
        bb = shape.val().BoundingBox()
        print(f"{name:15s} {bb.xlen:7.1f} x {bb.ylen:7.1f} x {bb.zlen:6.1f} mm  vol={shape.val().Volume()/1000:8.1f} cm3")
    assy = assembly(robot, context)
    assy.export(str(OUT / "SWEEP-1_on_row.step"))
    assy.export(str(OUT / "SWEEP-1_on_row.glb"))
    print("done")
