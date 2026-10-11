"""Lumped thermal model of the OVO-1 hardware.

One thermal node for the water loop: coolant + jacket + skin + radiator + cold plate, which are all well
coupled. The SoC die sits on the loop through the cold plate's thermal resistance. Every constant comes from
docs/OVO-1.md and cad/llm_egg.py; the ones marked ASSUMPTION need a prototype measurement.
"""
import math
from dataclasses import dataclass


@dataclass
class PlantParams:
    heat_capacity: float = 4700.0  # J/K: 0.6 L coolant + 1.4 kg Al skin/liner + radiator, cold plate, steel
    ua_skin: float = 2.2  # W/K: 9.5 W/m²K x 0.21 m² water-backed skin + unjacketed ends
    air_mcp_max: float = 12.5  # W/K: air mass flow x cp at full fan speed (~22 CFM)
    ua_core_max: float = 13.0  # W/K: radiator core conductance at full air flow (ASSUMPTION, vendor data)
    r_coldplate: float = 0.18  # K/W: die to coolant with the pump running (ASSUMPTION)
    r_coldplate_no_flow: float = 0.80  # K/W: die to coolant with the pump stopped (ASSUMPTION)
    psu_loss: float = 0.08  # fraction of DC load lost in the PSU (inside the body)
    p_rest_idle: float = 10.0  # W: board, NVMe, NIC, fans/pump electronics at idle
    p_rest_active: float = 18.0  # W: same, under load
    fan_noise_full: float = 34.0  # dBA at 1 m, both fans at 100% (ASSUMPTION, slim 80 mm at ~2,000 rpm)


@dataclass
class PlantState:
    t_water: float = 25.0  # °C
    t_ambient: float = 25.0
    pump_ok: bool = True
    leak: bool = False


def radiator_conductance(p: PlantParams, fan: float) -> float:
    """Effective W/K from coolant to room air through the radiator at fan duty 0..1 (effectiveness-NTU)."""
    if fan <= 0:
        return 0.0
    mcp = p.air_mcp_max * fan
    ntu = p.ua_core_max * math.sqrt(fan) / mcp
    return (1 - math.exp(-ntu)) * mcp


def fan_noise_dba(p: PlantParams, fan: float) -> float:
    """Fan-law noise estimate: 50·log10(rpm ratio). Below ~12 dBA counts as inaudible."""
    if fan <= 0:
        return 0.0
    return max(0.0, p.fan_noise_full + 50 * math.log10(fan))


def die_temp(p: PlantParams, s: PlantState, p_soc: float) -> float:
    r = p.r_coldplate if s.pump_ok else p.r_coldplate_no_flow
    return s.t_water + p_soc * r


def heat_input(p: PlantParams, p_soc: float, active: bool) -> float:
    dc = p_soc + (p.p_rest_active if active else p.p_rest_idle)
    return dc * (1 + p.psu_loss)


def step(p: PlantParams, s: PlantState, p_soc: float, active: bool, fan: float, dt: float = 1.0) -> float:
    """Advance the water temperature by dt seconds. Returns the heat input in W."""
    q_in = heat_input(p, p_soc, active)
    dt_w = s.t_water - s.t_ambient
    q_out = p.ua_skin * dt_w + radiator_conductance(p, fan) * dt_w
    s.t_water += (q_in - q_out) * dt / p.heat_capacity
    return q_in


def steady_state_water(p: PlantParams, q_in: float, fan: float, t_ambient: float = 25.0) -> float:
    return t_ambient + q_in / (p.ua_skin + radiator_conductance(p, fan))
