'use strict';

// === AWG 3.0 timers / content padding generation ===
// Formats verified against amneziawg-go source (device/uapi.go, device/noise-types.go):
//   • each field is a UintRange: "N" or "LO-HI" (HI >= LO, both uint32 there —
//     but kernel packs u16, so we keep pins/values inside uint16 for cross-compat)
//   • zero range = unset = protocol default constant
//   • "(off)" is NOT parsed by any implementation — "off" is omitting the field.
// Generation bands anchored on the protocol defaults (device/constants.go,
// kernel src/messages.h): REKEY_AFTER_TIME 120s, REKEY_TIMEOUT 5s,
// REJECT_AFTER_TIME 180s, KEEPALIVE_TIMEOUT 10s, MAX_TIMER_HANDSHAKES 18
// (RekeyAttemptTime 90 / RekeyTimeout 5). Band scheme ported from
// pumbaX/awg-multi-script gen_awg3_params (MIT).
// Invariant that must never be violated: RejectAfterTime > RekeyAfterTime —
// otherwise the session is rejected before the peer can rekey.

const U16_MAX = 65535;

const PROTOCOL_DEFAULTS = Object.freeze({
    rekeyAfterTime: 120,
    rekeyTimeout: 5,
    rejectAfterTime: 180,
    keepaliveTimeout: 10,
    maxHandshakeAttempts: 18,
});

// rnd.int(lo, hi) — inclusive both ends; default wraps Math.random
const defaultRnd = { int: (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1)) };

/**
 * Generate one random timer/padding set as u16_range strings.
 * All bands stay inside uint16, LO < HI by construction, and each band
 * spans its protocol default (110..160 ∋ 120; 4-10 ∋ 5; 175..215 ∋ 180;
 * 9..30 ∋ 10; 16..20 ∋ 18).
 * @param {{int: (lo:number, hi:number) => number}} [rnd]
 * @returns {{contentPaddingAddition:string, rekeyAfterTime:string, rekeyTimeout:string,
 *            rejectAfterTime:string, keepaliveTimeout:string, maxHandshakeAttempts:string}}
 */
function generateAwg3Timers(rnd = defaultRnd) {
    // Content padding: 0 would mean "off", so start the low band at 8
    const cpa = [rnd.int(8, 24), rnd.int(48, 96)];
    // Rekey: around 120s; keep the top below RejectAfterTime's bottom band
    const rat = [rnd.int(110, 125), rnd.int(140, 160)];
    // Reject: strictly above rekey, around 180s; guard the invariant on a bad draw
    let rjt;
    do {
        rjt = [rnd.int(175, 190), rnd.int(200, 215)];
    } while (!(rjt[0] > rat[1] + 15 && rjt[1] > rjt[0] + 20));
    // Keepalive: around 10s
    const ka = [rnd.int(9, 14), rnd.int(20, 30)];
    // RekeyTimeout: narrow fixed band around 5s (spread adds little masking
    // but noticeably affects reconnection speed; the daemon picks a random
    // value inside the band per handshake anyway — UintRange.PickOne)
    const rkt = [4, 10];
    // Max handshake attempts: single value around 18 (awg2.sh pattern)
    const mha = rnd.int(16, 20);
    return {
        contentPaddingAddition: `${cpa[0]}-${cpa[1]}`,
        rekeyAfterTime: `${rat[0]}-${rat[1]}`,
        rekeyTimeout: `${rkt[0]}-${rkt[1]}`,
        rejectAfterTime: `${rjt[0]}-${rjt[1]}`,
        keepaliveTimeout: `${ka[0]}-${ka[1]}`,
        maxHandshakeAttempts: `${mha}`,
    };
}

/**
 * Validate/normalize an env pin for one of the six fields.
 * Accepted: "N", "LO-HI" (uint16, HI >= LO), "(off)" (case-insensitive →
 * '' = omit the field = protocol default; parsers do NOT implement "(off)").
 * @param {string|undefined|null} raw
 * @returns {string|null} normalized value ('' for off) or null when invalid
 */
function normalizeU16Range(raw) {
    if (raw === undefined || raw === null) return null;
    const v = String(raw).trim();
    if (!v) return null;
    if (/^\(off\)$/i.test(v)) return '';
    const m = v.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (lo > U16_MAX || hi > U16_MAX || lo > hi) return null;
    return m[2] === undefined ? `${lo}` : `${lo}-${hi}`;
}

module.exports = {
    generateAwg3Timers,
    normalizeU16Range,
    U16_MAX,
    PROTOCOL_DEFAULTS,
};
