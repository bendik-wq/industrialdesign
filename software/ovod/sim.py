"""Scenario runner: the governor driving the thermal model through realistic workloads.

    python3 -m ovod.sim                 # all scenarios x all modes, summary table
    python3 -m ovod.sim --ambient 32    # a hot room

Workload model (ASSUMPTIONS, to be replaced by measured Strix Halo numbers):
    idle 8 W SoC; reading a prompt ("prefill") wants 120 W; generating ("decode") wants 95 W.
    Decode is memory-bandwidth bound, so it slows less than linearly with the power cap:
    relative speed = 0.35 at 15 W, 0.55 at 30 W, 1.0 at 90 W and above.
    The SoC protects itself: it throttles so the die never exceeds ~100 °C (modelled as a power limit).
"""
import argparse
from dataclasses import dataclass, field

from .governor import Governor, Mode, Telemetry
from .plant import PlantParams, PlantState, die_temp, fan_noise_dba, step

P_IDLE, P_PREFILL, P_DECODE = 8.0, 120.0, 95.0


T_DIE_HW = 100.0  # the SoC's own throttle point


def decode_speed(cap: float) -> float:
    if cap <= 30.0:
        return max(0.35, 0.35 + 0.20 * (cap - 15.0) / 15.0)
    return min(1.0, 0.55 + 0.45 * (cap - 30.0) / 60.0)


# ---------------------------------------------------------------- workloads: t -> "idle" | "prefill" | "decode"
def idle(t):
    return "idle"


def chat(t):
    """A person chatting: a question every 2 min, 4 s to read it, ~20 s answer."""
    p = t % 120
    return "prefill" if p < 4 else "decode" if p < 24 else "idle"


def long_job(t):
    """An agent or a batch job: back-to-back 10 s prompt reads and 50 s answers."""
    return "prefill" if t % 60 < 10 else "decode"


def continuous(t):
    return "decode"


SCENARIOS = {
    "idle 30 min": (idle, 1800, None),
    "chat 60 min": (chat, 3600, None),
    "long job 60 min": (long_job, 3600, None),
    "pump fails at 10 min": (long_job, 1800, 600),
}


@dataclass
class Result:
    max_water: float = 0.0
    max_die: float = 0.0
    fan_on_s: int = 0
    max_dba: float = 0.0
    first_fan_s: int | None = None
    speed_sum: float = 0.0
    decode_s: int = 0
    alerts: set = field(default_factory=set)
    shutdown: bool = False

    @property
    def rel_speed(self):
        return self.speed_sum / self.decode_s if self.decode_s else 1.0


def run(workload, seconds, mode, ambient=25.0, pump_fail_at=None, params=None) -> Result:
    p = params or PlantParams()
    s = PlantState(t_water=ambient, t_ambient=ambient)
    gov = Governor(mode, heat_capacity=p.heat_capacity, ua_skin=p.ua_skin)
    fan, cap = 0.0, gov.lim.cap_max
    r = Result()
    for t in range(seconds):
        if pump_fail_at is not None and t >= pump_fail_at:
            s.pump_ok = False
        phase = workload(t)
        busy = phase != "idle"
        want = {"idle": P_IDLE, "prefill": P_PREFILL, "decode": P_DECODE}[phase]
        p_soc = min(want, cap)
        r_cp = p.r_coldplate if s.pump_ok else p.r_coldplate_no_flow
        p_soc = min(p_soc, max(0.0, (T_DIE_HW - s.t_water) / r_cp))  # hardware throttle
        t_die = die_temp(p, s, p_soc)  # die settles in milliseconds: use the water temperature it saw
        q = step(p, s, p_soc, busy, fan)
        cmd = gov.step(Telemetry(s.t_water, ambient, t_die, flow_ok=s.pump_ok, heat_w=q, busy=busy))
        fan, cap = cmd.fan, cmd.soc_cap_w
        r.alerts.update(cmd.alerts)
        if cmd.shutdown:
            r.shutdown = True
            break
        r.max_water, r.max_die = max(r.max_water, s.t_water), max(r.max_die, t_die)
        if fan > 0:
            r.fan_on_s += 1
            r.first_fan_s = t if r.first_fan_s is None else r.first_fan_s
            r.max_dba = max(r.max_dba, fan_noise_dba(p, fan))
        if phase == "decode":
            r.decode_s += 1
            r.speed_sum += decode_speed(p_soc if p_soc < P_DECODE else 120.0)
    return r


def silent_burst_seconds(ambient=25.0) -> int:
    """From a cold start, how long full-power generation runs before the fans have to start (AUTO)."""
    r = run(continuous, 3600, Mode.AUTO, ambient)
    return r.first_fan_s if r.first_fan_s is not None else 3600


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ambient", type=float, default=25.0)
    a = ap.parse_args(argv)
    print(f"ambient {a.ambient:.0f} °C\n")
    hdr = f"{'scenario':22s} {'mode':12s} {'water max':>9s} {'skin max':>8s} {'die max':>7s} {'fans on':>7s} {'loudest':>8s} {'speed':>6s}  notes"
    print(hdr)
    print("-" * len(hdr))
    for name, (wl, secs, fail) in SCENARIOS.items():
        for mode in Mode:
            r = run(wl, secs, mode, a.ambient, fail)
            loud = f"{r.max_dba:4.0f} dBA" if r.max_dba else "  silent"
            notes = ", ".join(sorted(r.alerts)) + (" SHUTDOWN" if r.shutdown else "")
            print(
                f"{name:22s} {mode.value:12s} {r.max_water:7.1f}°C {r.max_water - 1:6.1f}°C {r.max_die:5.0f}°C "
                f"{100 * r.fan_on_s / secs:6.0f}% {loud:>8s} {100 * r.rel_speed:5.0f}%  {notes}"
            )
    print(f"\nsilent burst from cold (AUTO, continuous generation): {silent_burst_seconds(a.ambient) / 60:.1f} min before the fans start")


if __name__ == "__main__":
    main()
