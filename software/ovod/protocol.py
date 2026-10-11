"""Host <-> MCU line protocol, and the MCU's own safety rules.

The controller PCB (an MCU on USB CDC) owns the fans, the pump, the light slit, the leak sensor, the flow
sensor, two water thermistors, the intake-air thermistor, the accelerometer and the PSU enable line.
It talks newline-delimited JSON, one object per line, at most 256 bytes.

    host -> mcu   {"t":"set","fan":0.42,"pump":0.7,"rgbw":[255,235,210,0],"br":0.6,"seq":17}
                  {"t":"hb","seq":18}                        heartbeat, every 1 s
    mcu  -> host  {"t":"tel","tw":38.2,"ta":24.9,"flow":0.9,"rpm":[910,905],"leak":0,"seq":18}
                  {"t":"evt","e":"tap","n":2}                 taps on the shell
                  {"t":"evt","e":"leak"} / {"t":"evt","e":"wdt"}

The MCU never trusts the host for safety. McuSafety below is the reference model the firmware must match.
The firmware test suite replays the same cases.
"""
import json
from dataclasses import dataclass

MAX_LINE = 256


class ProtocolError(ValueError):
    pass


def encode(msg: dict) -> bytes:
    line = json.dumps(msg, separators=(",", ":"))
    if len(line) + 1 > MAX_LINE:
        raise ProtocolError("message too long")
    return (line + "\n").encode()


def decode(line: bytes) -> dict:
    if len(line) > MAX_LINE:
        raise ProtocolError("line too long")
    try:
        msg = json.loads(line.decode().strip())
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ProtocolError(f"bad frame: {e}") from None
    if not isinstance(msg, dict) or msg.get("t") not in ("set", "hb", "tel", "evt"):
        raise ProtocolError("unknown message type")
    if msg["t"] == "set":
        for k in ("fan", "pump"):
            v = msg.get(k)
            if not isinstance(v, (int, float)) or not 0.0 <= v <= 1.0:
                raise ProtocolError(f"{k} out of range")
    return msg


@dataclass
class McuOutputs:
    fan: float
    pump: float
    psu_enable: bool
    fault: str = ""


class McuSafety:
    """Rules the MCU enforces on its own, whatever the host asks for.

    - Leak sensor wet: cut PSU enable (power off), stop the pump. Latches until power-cycled.
    - Water ≥ 55 °C: cut power. Latches.
    - No host heartbeat for 5 s (host hung or crashed): fans 100 %, pump 100 %. Clears on the next heartbeat.
    - Pump commanded but no flow for 3 s: fans 100 %; the host is told and caps the SoC.
    - The host can never set the pump below 30 % while the PSU is on.
    """

    HB_TIMEOUT = 5.0
    NO_FLOW_TIMEOUT = 3.0
    WATER_CUTOFF = 55.0
    PUMP_MIN = 0.3

    def __init__(self):
        self.last_hb = 0.0
        self.no_flow_since = None
        self.latched = ""
        self.req_fan, self.req_pump = 0.0, 0.5

    def on_message(self, msg: dict, now: float):
        if msg["t"] in ("hb", "set"):
            self.last_hb = now
        if msg["t"] == "set":
            self.req_fan, self.req_pump = float(msg["fan"]), float(msg["pump"])

    def evaluate(self, now: float, t_water: float, flow: float, leak: bool) -> McuOutputs:
        if leak:
            self.latched = "leak"
        elif t_water >= self.WATER_CUTOFF:
            self.latched = self.latched or "overtemp"
        if self.latched:
            return McuOutputs(fan=1.0 if self.latched == "overtemp" else 0.0, pump=0.0, psu_enable=False, fault=self.latched)

        fan, pump = self.req_fan, max(self.req_pump, self.PUMP_MIN)
        fault = ""
        if now - self.last_hb > self.HB_TIMEOUT:
            fan, pump, fault = 1.0, 1.0, "wdt"
        if flow < 0.1:
            self.no_flow_since = now if self.no_flow_since is None else self.no_flow_since
            if now - self.no_flow_since >= self.NO_FLOW_TIMEOUT:
                fan, fault = 1.0, fault or "no-flow"
        else:
            self.no_flow_since = None
        return McuOutputs(fan=fan, pump=pump, psu_enable=True, fault=fault)
