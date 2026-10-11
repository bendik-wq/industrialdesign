"""Light-slit patterns: the product's only visual output.

The slit is a 60 mm opal light pipe in the tail seam, lit by RGBW LEDs. It is dark when nothing is happening.
    thinking (reading the prompt)  slow shimmer, cool white
    generating                     steady glow; brightness follows tokens/s on a log scale
    pairing                        three soft pulses, repeating
    attention (thermal, pump)      slow amber breathing
    fault (leak, shutdown)         red, 1 Hz
Night mode caps brightness at 15 %.
"""
import math
from enum import Enum

WARM = (1.0, 0.92, 0.82)
COOL = (0.85, 0.92, 1.0)
AMBER = (1.0, 0.55, 0.1)
RED = (1.0, 0.1, 0.05)


class LightState(str, Enum):
    OFF = "off"
    THINKING = "thinking"
    GENERATING = "generating"
    PAIRING = "pairing"
    ATTENTION = "attention"
    FAULT = "fault"


def tps_to_level(tps: float, lo: float = 2.0, hi: float = 80.0) -> float:
    """Map tokens/s to 0.2..1.0 on a log scale, so 5 tok/s and 50 tok/s both read clearly."""
    if tps <= 0:
        return 0.0
    x = (math.log(max(tps, lo)) - math.log(lo)) / (math.log(hi) - math.log(lo))
    return 0.2 + 0.8 * min(max(x, 0.0), 1.0)


def frame(state: LightState, t: float, tps: float = 0.0, night: bool = False):
    """(r, g, b, brightness) for the slit at time t seconds."""
    if state == LightState.OFF:
        rgb, b = WARM, 0.0
    elif state == LightState.THINKING:
        rgb, b = COOL, 0.25 + 0.15 * math.sin(2 * math.pi * t / 2.5)
    elif state == LightState.GENERATING:
        rgb, b = WARM, tps_to_level(tps)
    elif state == LightState.PAIRING:
        phase = t % 3.0
        rgb, b = COOL, (math.sin(math.pi * (phase % 0.6) / 0.6) if phase < 1.8 else 0.0)
    elif state == LightState.ATTENTION:
        rgb, b = AMBER, 0.15 + 0.35 * (0.5 + 0.5 * math.sin(2 * math.pi * t / 4.0))
    else:
        rgb, b = RED, 0.8 if (t % 1.0) < 0.5 else 0.1
    if night:
        b = min(b, 0.15)
    return (*rgb, round(max(0.0, min(b, 1.0)), 3))
