import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src"))
# ============================================================
# vending.py — Vending machine policy as Prolog clauses
# ============================================================

from prolog import Engine, atom, var, compound, num, lst


def build_vending_kb():
    e = Engine()
    a, v, c, n = atom, var, compound, num

    # Products: product(Slot, Name, PriceCents)
    for slot, name, price in [
        ("a1","cola",125), ("a2","water",75), ("a3","juice",150),
        ("b1","chips",100), ("b2","candy",85), ("b3","cookies",110),
    ]:
        e.add_clause(c("product", [a(slot), a(name), n(price)]))

    # Initial state
    e.add_clause(c("machine_state", [a("idle")]))
    e.add_clause(c("credit", [n(0)]))

    # Sensors
    for name, val in [
        ("tilt","ok"), ("door","closed"), ("temp","normal"),
        ("coin_mech","ready"),
        ("motor_a1","ready"), ("motor_a2","ready"), ("motor_a3","ready"),
        ("motor_b1","ready"), ("motor_b2","ready"), ("motor_b3","ready"),
        ("delivery","clear"), ("power","ok"),
    ]:
        e.add_clause(c("sensor", [a(name), a(val)]))

    # Inventory
    for slot, count in [("a1",8),("a2",10),("a3",6),("b1",7),("b2",12),("b3",5)]:
        e.add_clause(c("inventory", [a(slot), n(count)]))

    # ── Fault detection (derived from sensors) ────────────

    for fault, sensor_name, sensor_val in [
        ("tilt_detected", "tilt", "tilted"),
        ("door_open", "door", "open"),
        ("overtemp", "temp", "hot"),
        ("coin_jam", "coin_mech", "jammed"),
        ("power_fault", "power", "low"),
        ("delivery_blocked", "delivery", "blocked"),
    ]:
        e.add_clause(c("fault_condition", [a(fault)]),
            [c("sensor", [a(sensor_name), a(sensor_val)])])

    # motor_fault(Slot) :- sensor(Motor, stuck), motor_for(Slot, Motor).
    e.add_clause(c("motor_fault", [v("Slot")]),
        [c("sensor", [v("M"), a("stuck")]), c("motor_for", [v("Slot"), v("M")])])
    for slot in ["a1","a2","a3","b1","b2","b3"]:
        e.add_clause(c("motor_for", [a(slot), a("motor_" + slot)]))

    # has_any_fault / has_critical_fault
    e.add_clause(c("has_any_fault", []), [c("fault_condition", [v("_")])])
    for critical in ["tilt_detected", "door_open", "power_fault"]:
        e.add_clause(c("has_critical_fault", []),
            [c("fault_condition", [a(critical)])])

    # all_faults(Faults)
    e.add_clause(c("all_faults", [v("F")]),
        [c("findall", [v("X"), c("fault_condition", [v("X")]), v("F")])])

    # ── Can-vend ──────────────────────────────────────────

    e.add_clause(c("can_vend", [v("Slot")]), [
        c("machine_state", [a("idle")]),
        c("not", [c("has_any_fault", [])]),
        c("product", [v("Slot"), v("_N"), v("Price")]),
        c("credit", [v("Credit")]),
        c(">=", [v("Credit"), v("Price")]),
        c("inventory", [v("Slot"), v("Count")]),
        c(">", [v("Count"), n(0)]),
        c("not", [c("motor_fault", [v("Slot")])]),
        c("sensor", [a("delivery"), a("clear")]),
    ])

    # Can-accept-coin
    e.add_clause(c("can_accept_coin", []), [
        c("machine_state", [a("idle")]),
        c("not", [c("has_critical_fault", [])]),
        c("sensor", [a("coin_mech"), a("ready")]),
    ])

    # Can-return-credit
    e.add_clause(c("can_return_credit", []), [
        c("credit", [v("C")]),
        c(">", [v("C"), n(0)]),
        c("sensor", [a("coin_mech"), a("ready")]),
    ])

    # ── Actions ───────────────────────────────────────────

    # do_insert_coin(Amount)
    e.add_clause(c("do_insert_coin", [v("Amt")]), [
        c("can_accept_coin", []),
        c("credit", [v("Old")]),
        c("is", [v("New"), c("+", [v("Old"), v("Amt")])]),
        c("retract", [c("credit", [v("Old")])]),
        c("assert", [c("credit", [v("New")])]),
    ])

    # do_select(Slot)
    e.add_clause(c("do_select", [v("Slot")]), [
        c("can_vend", [v("Slot")]),
        c("product", [v("Slot"), v("_N"), v("Price")]),
        c("credit", [v("Old")]),
        c("is", [v("Change"), c("-", [v("Old"), v("Price")])]),
        c("retract", [c("credit", [v("Old")])]),
        c("assert", [c("credit", [v("Change")])]),
        c("inventory", [v("Slot"), v("Count")]),
        c("is", [v("NC"), c("-", [v("Count"), n(1)])]),
        c("retract", [c("inventory", [v("Slot"), v("Count")])]),
        c("assert", [c("inventory", [v("Slot"), v("NC")])]),
        c("retract", [c("machine_state", [a("idle")])]),
        c("assert", [c("machine_state", [a("vending")])]),
    ])

    # do_vend_complete
    e.add_clause(c("do_vend_complete", []), [
        c("machine_state", [a("vending")]),
        c("retract", [c("machine_state", [a("vending")])]),
        c("assert", [c("machine_state", [a("idle")])]),
    ])

    # do_return_credit
    e.add_clause(c("do_return_credit", []), [
        c("can_return_credit", []),
        c("credit", [v("C")]),
        c("retract", [c("credit", [v("C")])]),
        c("assert", [c("credit", [n(0)])]),
    ])

    # ── Fault response policy ─────────────────────────────

    for fault, response in [
        ("tilt_detected", "lock_and_alarm"),
        ("door_open", "lock_and_alarm"),
        ("power_fault", "emergency_return_credit"),
        ("overtemp", "compressor_boost"),
        ("coin_jam", "disable_coin_accept"),
        ("delivery_blocked", "disable_vend"),
    ]:
        e.add_clause(c("fault_response", [a(fault), a(response)]))

    e.add_clause(c("should_return_credit_on_fault", []), [
        c("has_critical_fault", []),
        c("credit", [v("C")]),
        c(">", [v("C"), n(0)]),
    ])

    # ── Display messages (clause order = priority) ────────

    for msg, body in [
        ("OUT OF ORDER", [c("fault_condition", [a("tilt_detected")])]),
        ("SERVICE DOOR OPEN", [c("fault_condition", [a("door_open")])]),
        ("POWER LOW", [c("fault_condition", [a("power_fault")])]),
        ("COIN JAMMED", [c("fault_condition", [a("coin_jam")])]),
        ("TEMP WARNING", [c("fault_condition", [a("overtemp")])]),
        ("REMOVE ITEM", [c("sensor", [a("delivery"), a("blocked")])]),
        ("VENDING...", [c("machine_state", [a("vending")])]),
        ("INSERT COINS", [c("machine_state", [a("idle")]),
                          c("credit", [n(0)]),
                          c("not", [c("has_any_fault", [])])]),
        ("SELECT ITEM", [c("machine_state", [a("idle")]),
                         c("credit", [v("C")]),
                         c(">", [v("C"), n(0)]),
                         c("not", [c("has_any_fault", [])])]),
    ]:
        e.add_clause(c("display_message", [a(msg)]), body)

    # available_slots(Slots)
    e.add_clause(c("available_slots", [v("S")]),
        [c("findall", [v("X"), c("can_vend", [v("X")]), v("S")])])

    # vend_blocked_reason(Slot, Reason)
    e.add_clause(c("vend_blocked_reason", [v("S"), a("has_fault")]),
        [c("has_any_fault", [])])
    e.add_clause(c("vend_blocked_reason", [v("S"), a("insufficient_credit")]),
        [c("product", [v("S"), v("_"), v("P")]),
         c("credit", [v("Cr")]),
         c("<", [v("Cr"), v("P")])])

    return e


def update_sensor(engine, name, value):
    """Update a sensor value in the Prolog database."""
    old = engine.query_first(compound("sensor", [atom(name), var("V")]))
    if old:
        engine.retract_first(compound("sensor", [atom(name), var("_")]))
    engine.add_clause(compound("sensor", [atom(name), atom(value)]))
