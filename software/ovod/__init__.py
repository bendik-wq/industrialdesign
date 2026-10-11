"""ovod — the OVO-1 device daemon.

The part of the software stack that only this product has: it couples the AI workload to the sealed,
water-cooled body. It decides fan speed, pump speed and the SoC power cap every second, drives the light
slit from the generation rate, and speaks the line protocol to the safety microcontroller.

Modules:
    plant      lumped thermal model of the OVO-1 hardware (used for simulation and tests)
    governor   the 1 Hz cooling / power control loop
    light      light-slit patterns
    protocol   host <-> MCU line protocol and the MCU's independent safety rules (reference model)
    sim        scenario runner: `python3 -m ovod.sim`
"""
