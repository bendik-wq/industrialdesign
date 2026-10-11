"""ovod tests. Run from software/:  python3 -m unittest -v"""
import unittest

from ovod import light, protocol
from ovod.governor import Governor, Mode, Telemetry
from ovod.plant import PlantParams, heat_input, radiator_conductance, steady_state_water
from ovod.sim import SCENARIOS, chat, long_job, run, silent_burst_seconds

P = PlantParams()


class Plant(unittest.TestCase):
    def test_sealed_skin_sheds_about_44_w_at_45c_skin(self):
        self.assertAlmostEqual(P.ua_skin * (46 - 25), 46, delta=4)

    def test_radiator_conductance_rises_with_fan_and_is_zero_when_off(self):
        g = [radiator_conductance(P, f) for f in (0, 0.25, 0.5, 1.0)]
        self.assertEqual(g[0], 0)
        self.assertTrue(g[0] < g[1] < g[2] < g[3])

    def test_boost_holds_full_load_with_skin_under_45c(self):
        q = heat_input(P, 120, active=True)  # worst case: prefill at full cap
        self.assertLess(steady_state_water(P, q, fan=1.0), 46)


class GovernorSafety(unittest.TestCase):
    def tel(self, tw, **kw):
        return Telemetry(t_water=tw, t_ambient=25, t_die=tw + 20, **kw)

    def test_leak_shuts_down(self):
        c = Governor().step(self.tel(30, leak=True))
        self.assertTrue(c.shutdown)
        self.assertEqual(c.pump, 0.0)

    def test_overtemp_trip_forces_fans_even_in_silent(self):
        c = Governor(Mode.SILENT).step(self.tel(47.5))
        self.assertEqual(c.fan, 1.0)
        self.assertIn("overtemp", c.alerts)

    def test_runaway_shuts_down(self):
        self.assertTrue(Governor().step(self.tel(52.5)).shutdown)

    def test_pump_fault_caps_soc_and_runs_fans(self):
        c = Governor().step(self.tel(35, flow_ok=False))
        self.assertEqual(c.fan, 1.0)
        self.assertLessEqual(c.soc_cap_w, 30)

    def test_auto_fans_have_hysteresis(self):
        g = Governor(Mode.AUTO)
        self.assertEqual(g.step(self.tel(41)).fan, 0)
        self.assertGreater(g.step(self.tel(42.5)).fan, 0)
        self.assertGreater(g.step(self.tel(39)).fan, 0)  # still on between off and on thresholds
        self.assertEqual(g.step(self.tel(37.5)).fan, 0)

    def test_silent_never_spins_fans_below_trip(self):
        g = Governor(Mode.SILENT)
        for tw in range(25, 47):
            self.assertEqual(g.step(self.tel(tw)).fan, 0)

    def test_burst_budget_shrinks_as_water_warms(self):
        g = Governor()
        b = [g.burst_seconds(self.tel(tw)) for tw in (25, 35, 43)]
        self.assertTrue(b[0] > b[1] > b[2] >= 0)


class Scenarios(unittest.TestCase):
    """The product promises, checked against the thermal model at a 25 °C room."""

    def test_chat_is_silent_and_full_speed_in_auto(self):
        r = run(chat, 3600, Mode.AUTO)
        self.assertEqual(r.fan_on_s, 0)
        self.assertGreaterEqual(r.rel_speed, 0.99)

    def test_long_job_keeps_skin_under_45c_in_every_mode(self):
        for mode in Mode:
            r = run(long_job, 3600, mode)
            self.assertLess(r.max_water - 1, 45.0, mode)
            self.assertFalse(r.shutdown)

    def test_silent_mode_long_job_stays_silent(self):
        r = run(long_job, 3600, Mode.SILENT)
        self.assertEqual(r.max_dba, 0)

    def test_auto_long_job_runs_at_full_speed_and_stays_quiet(self):
        r = run(long_job, 3600, Mode.AUTO)
        self.assertGreaterEqual(r.rel_speed, 0.95)
        self.assertLess(r.max_dba, 30)

    def test_pump_failure_never_cooks_the_die(self):
        _, secs, fail = SCENARIOS["pump fails at 10 min"]
        for mode in Mode:
            r = run(long_job, secs, mode, pump_fail_at=fail)
            self.assertLessEqual(r.max_die, 100.0)
            self.assertIn("pump-fault", r.alerts)

    def test_silent_burst_from_cold_is_minutes_not_seconds(self):
        self.assertGreater(silent_burst_seconds(25.0), 8 * 60)


class Light(unittest.TestCase):
    def test_off_is_dark(self):
        self.assertEqual(light.frame(light.LightState.OFF, 1.0)[3], 0)

    def test_generating_brightness_follows_tokens_per_second(self):
        lv = [light.frame(light.LightState.GENERATING, 0, tps)[3] for tps in (3, 10, 40)]
        self.assertTrue(lv[0] < lv[1] < lv[2])

    def test_night_mode_caps_brightness(self):
        for st in light.LightState:
            for t in (0.0, 0.3, 1.1, 2.2):
                self.assertLessEqual(light.frame(st, t, 80, night=True)[3], 0.15)


class Protocol(unittest.TestCase):
    def test_roundtrip(self):
        m = {"t": "set", "fan": 0.4, "pump": 0.7, "seq": 3}
        self.assertEqual(protocol.decode(protocol.encode(m)), m)

    def test_rejects_garbage_and_out_of_range(self):
        for line in (b"{nope\n", b'{"t":"x"}\n', b'{"t":"set","fan":1.5,"pump":0.5}\n', b"[1,2]\n"):
            with self.assertRaises(protocol.ProtocolError):
                protocol.decode(line)

    def test_rejects_oversized_lines(self):
        with self.assertRaises(protocol.ProtocolError):
            protocol.decode(b"{" + b" " * 300 + b"}\n")


class McuSafety(unittest.TestCase):
    def setUp(self):
        self.m = protocol.McuSafety()
        self.m.on_message({"t": "set", "fan": 0.2, "pump": 0.1}, now=0.0)

    def test_pump_never_below_minimum(self):
        self.assertGreaterEqual(self.m.evaluate(1.0, 30, 1.0, False).pump, 0.3)

    def test_leak_cuts_power_and_latches(self):
        self.assertFalse(self.m.evaluate(1.0, 30, 1.0, leak=True).psu_enable)
        self.m.on_message({"t": "hb"}, now=2.0)
        self.assertFalse(self.m.evaluate(2.0, 30, 1.0, leak=False).psu_enable)

    def test_lost_heartbeat_goes_full_cooling(self):
        o = self.m.evaluate(6.0, 30, 1.0, False)
        self.assertEqual((o.fan, o.pump, o.fault), (1.0, 1.0, "wdt"))
        self.m.on_message({"t": "hb"}, now=6.5)
        self.assertEqual(self.m.evaluate(6.6, 30, 1.0, False).fault, "")

    def test_no_flow_for_3s_forces_fans(self):
        self.m.on_message({"t": "hb"}, now=1.0)
        self.assertEqual(self.m.evaluate(1.0, 30, 0.0, False).fault, "")
        self.m.on_message({"t": "hb"}, now=4.0)
        o = self.m.evaluate(4.0, 30, 0.0, False)
        self.assertEqual((o.fan, o.fault), (1.0, "no-flow"))

    def test_water_cutoff_latches_power_off(self):
        o = self.m.evaluate(1.0, 55.5, 1.0, False)
        self.assertFalse(o.psu_enable)
        self.assertEqual(o.fault, "overtemp")


if __name__ == "__main__":
    unittest.main()
