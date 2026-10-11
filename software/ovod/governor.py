"""The 1 Hz cooling / power governor.

Priorities, in order:
    1. Safety: skin never above 45 °C (water ≤ 46 °C), die ≤ 95 °C, stop on leak or runaway.
    2. Silence: fans stay off as long as the water and the metal can soak up the heat.
    3. Speed: the highest SoC power cap the first two allow.

The body stores ~4.7 kJ/K. That is the "burst budget": a long answer can run at full power in silence, and
the fans only start when the water actually gets warm. In SILENT mode the fans never start; the governor
trims the SoC power cap instead.
"""
from dataclasses import dataclass, field
from enum import Enum


class Mode(str, Enum):
    SILENT = "silent"  # fans never run (except safety); trade speed for silence
    AUTO = "auto"  # fans only when the burst budget runs out
    PERFORMANCE = "performance"  # fans early, full speed always


@dataclass
class Telemetry:
    t_water: float
    t_ambient: float
    t_die: float
    flow_ok: bool = True
    leak: bool = False
    heat_w: float = 0.0  # current heat input estimate
    busy: bool = False


@dataclass
class Command:
    fan: float  # 0..1
    pump: float  # 0..1
    soc_cap_w: float
    shutdown: bool = False
    alerts: list = field(default_factory=list)


@dataclass
class Limits:
    water_max: float = 46.0  # skin ≈ water − 1 °C → skin ≤ 45 °C
    water_trip: float = 47.0  # safety: fans 100 %, cap to floor
    water_shutdown: float = 52.0
    die_max: float = 95.0
    cap_max: float = 120.0
    cap_floor: float = 30.0  # lowest cap when fans are allowed
    cap_floor_silent: float = 15.0  # SILENT trims further: the sealed skin alone sheds ~44 W in total


PROFILES = {
    # fan on / off thresholds and the water temperature the fan loop holds
    Mode.AUTO: dict(on=42.0, off=38.0, target=43.0),
    Mode.PERFORMANCE: dict(on=35.0, off=32.0, target=37.0),
}


class Governor:
    def __init__(self, mode: Mode = Mode.AUTO, limits: Limits | None = None, heat_capacity: float = 4700.0, ua_skin: float = 2.2):
        self.mode = mode
        self.lim = limits or Limits()
        self.c = heat_capacity
        self.ua_skin = ua_skin
        self.fan_on = False
        self.integral = 0.0
        self.cap = self.lim.cap_max

    # ---------------------------------------------------------------- public
    def step(self, t: Telemetry, dt: float = 1.0) -> Command:
        alerts = []
        if t.leak:
            return Command(fan=0.0, pump=0.0, soc_cap_w=0.0, shutdown=True, alerts=["leak"])
        if t.t_water >= self.lim.water_shutdown:
            return Command(fan=1.0, pump=1.0, soc_cap_w=0.0, shutdown=True, alerts=["overtemp-shutdown"])

        fan = self._fan(t, dt) if self.mode != Mode.SILENT else 0.0
        self._update_cap(t, dt)
        pump = 1.0 if t.t_water > 40 else (0.7 if t.busy else 0.35)

        if not t.flow_ok:
            alerts.append("pump-fault")
            fan, self.cap = 1.0, self.lim.cap_floor
        if t.t_water >= self.lim.water_trip:
            alerts.append("overtemp")
            fan, self.cap = 1.0, self.lim.cap_floor
        return Command(fan=round(fan, 3), pump=pump, soc_cap_w=round(self.cap, 1), alerts=alerts)

    def burst_seconds(self, t: Telemetry, p_heat_full: float = 150.0) -> float:
        """How long full power can run with the fans off before the water reaches its limit (for the UI)."""
        headroom = self.lim.water_max - 2.0 - t.t_water
        net = p_heat_full - self.ua_skin * (t.t_water - t.t_ambient)
        if headroom <= 0:
            return 0.0
        return float("inf") if net <= 0 else self.c * headroom / net

    # ---------------------------------------------------------------- internals
    def _fan(self, t: Telemetry, dt: float) -> float:
        prof = PROFILES[self.mode]
        if not self.fan_on and t.t_water >= prof["on"]:
            self.fan_on, self.integral = True, 0.0
        elif self.fan_on and t.t_water <= prof["off"]:
            self.fan_on = False
        if not self.fan_on:
            return 0.0
        err = t.t_water - prof["target"]
        self.integral = min(max(self.integral + err * dt, -60.0), 200.0)
        duty = 0.35 + 0.12 * err + 0.004 * self.integral
        return min(max(duty, 0.2), 1.0)

    def _update_cap(self, t: Telemetry, dt: float):
        lim = self.lim
        floor = lim.cap_floor_silent if self.mode == Mode.SILENT else lim.cap_floor
        target = lim.water_max - 2.0  # start trimming 2 K early so the trip point is never reached
        if t.t_water > target:
            self.cap -= 8.0 * (t.t_water - target) * dt
        elif t.t_water < target - 1.5:
            self.cap += 4.0 * dt
        if t.t_die > lim.die_max:
            self.cap -= 10.0 * dt
        self.cap = min(max(self.cap, floor), lim.cap_max)
