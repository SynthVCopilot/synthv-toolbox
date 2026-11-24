# Harmony API data alignment

Reference project: **SV Harmony API** — a file-based JSON bridge for Synthesizer V
with a two-tool base API entry (`harmony_read`, `harmony_cmd`).

This document records how far the two projects' data structures already agree,
so a value produced by one can be read by the other without a translation table.

## Verdict

The **leaf level already aligns**: field names, time units, pitch encoding,
parameter names, and success/failure signalling are the same. No code change was
needed. Differences are confined to the **container level**, where the two
projects deliberately diverge: Harmony exports one whole-project snapshot, this
bridge answers bounded, paged queries against a live host.

## Layer by layer

| Layer | Harmony | SynthV Agent Bridge | Aligned |
|---|---|---|:--:|
| Time unit | blicks, 1 quarter note = 705,600,000 | same, plus derived `*Quarters` / `*Seconds` | Yes |
| Pitch | MIDI integer (60 = C4) | `pitch` MIDI integer, plus `absolutePitch` | Yes |
| Note fields | `onset`, `duration`, `pitch`, `lyrics`, `phonemes`, `musicalType`, `detune` | identical names and meanings, plus `noteIndex`, `fingerprint`, `endPosition`, `absolute*`, `attributes` | Yes |
| Parameter names | `pitchDelta`, `vibratoEnv`, `loudness`, `tension`, `breathiness`, `voicing`, `gender`, `toneShift` | same set, read straight from `automation:getType()` | Yes |
| Parameter points | flat interleaved `[blick, value, ...]` | object array `[{position, value}]` | Convertible |
| Interpolation | `mode` | `interpolation` | Key name differs |
| Container | whole project, `tracks[].mainGroup` | locator + paged query context | No, by design |
| Session | `Harmony_Session.json` array with four file paths | `BridgeStatus` (`state`, `updatedAtEpochMs`, `ipcDirectory`, `sessionToken`) | `state: "running"` only |
| Call envelope | `{id, lua}` → `{id, ok, result, error}` | `{protocolVersion, requestId, traceId, expectedExecutorBuildId, action, payload}` → `{..., ok, result\|error}` | `ok` flag only |

## Converting parameter points

```js
// Bridge object array -> Harmony flat array
const flat = points.flatMap((p) => [p.position, p.value]);

// Harmony flat array -> Bridge object array
const objects = [];
for (let i = 0; i < flat.length; i += 2) {
  objects.push({ position: flat[i], value: flat[i + 1] });
}
```

The conversion is lossless in both directions. Positions stay in blicks and
values keep their parameter-specific range.

## Why the container is not aligned

Harmony's snapshot model suits an external program that wants the whole project
at once and can tolerate a 1–15 s export tick. This bridge answers against the
live host under a response budget, returns a `contextId` whose guards must still
be fresh at write time, and keeps one logical command inside one SynthV Undo
boundary. Emitting a whole-project snapshot would break the response budget and
detach writes from the guards that make them safe.

An external tool that wants Harmony-shaped data can assemble it from
`list_tracks` + `list_note_groups` + `get_track_notes` + `get_automation`; the
leaf fields need no renaming.

# Functional alignment

Data structures align at the leaf level. Capabilities do not, and mostly should
not — the two bridges sit on different SV versions, and several capabilities
belong to layers outside either bridge.

## Layers

| Layer | Component | Owns | Cannot |
|---|---|---|---|
| Scripting bridge | this project (SV2), SV Harmony API (SV1) | Same-version reads and guarded writes against the live project | Render audio, save the project, touch `.svp` |
| File | CVRS | Carrying a render across versions as a muted instrumental reference track, write-only | Translate editable vocal semantics across the version break |
| Injection | version-profiled native extension | Rendering and export the scripting API cannot reach | Work on a version whose profile is unverified |

The scripting API has no renderer — `bounce` is a frozen-state flag, not an
export — and cannot save a project. Those are not gaps in either bridge; they
are why the other two layers exist.

**Layer ownership is not fixed.** A capability can have more than one provider,
and can move. Importing a wav onto a track is the current example: the file
layer writes a muted instrumental track into a copy of a closed project, and an
injection-layer path would do the same thing in the open project instead. The
two differ in more than mechanism — the file layer leaves the source untouched
and emits a new file, while an injection path mutates the live session. Route
on what a bridge reports at runtime, not on a remembered owner.

Either path ends up verifiable from the bridge layer: `isInstrumental` is
readable on both SV1 and SV2, so a bridge can confirm after the fact that the
track landed with the intended shape. Writes at the other layers are unguarded;
the bridge is where a postcondition check is available.

SVP format `v134` → `v153` is a semantic break: vocal configuration moves from
`track.mainRef.voice` to `mainGroup.vocalModes`. Nothing translates editable
vocal semantics across it, by design.

## Bridge layer, side by side

| Capability | SV1 Harmony | SV2 bridge |
|---|---|---|
| Read project snapshot | Whole project, periodic export | Bounded paged queries, 17 read Actions |
| Note onset / duration / pitch / lyrics / phonemes | Yes | Yes |
| Note add / remove | Yes | Yes |
| Note detune / musicalType / language | No | Yes |
| 8 parameter curves | Yes, whole-curve replace | Yes, ranged edit and simplify |
| Track add / rename | Yes | Yes |
| Mixer write | No | `set_track_mixer` |
| Tempo / meter write | No | `set_time_axis` |
| Note Group add / remove | No | Yes |
| Group Reference | No | Yes |
| Retakes | No | 4 Actions |
| Smart Pitch controls | No | 4 Actions |
| Vocal and Vocal Modes | No | `set_group_voice`, `apply_group_tuning` |
| Selection / viewport / playback | No | `sv_ui`, 9 Actions |
| Transactions | No | Present but disabled |
| Arbitrary Lua execution | `harmony_cmd`, opt-in | No, by design |
| Undo boundary | One per import | One per command, verified |
| Runtime capability declaration | `harmony_capabilities` | `sv_describe`, `sv_status` |

Most SV1 gaps are not implementation debt: the SV1 scripting API has no
equivalent for Vocal Modes, Retakes, or Smart Pitch. Where SV1 does have the
API and the bridge does not write it — mixer, tempo, meter, detune — the gap is
in the import path.

The two bridges diverge on one deliberate point. Harmony exposes raw Lua
execution and no semantic write Actions; this project exposes semantic write
Actions and no raw execution, because a guarded write with a verified
postcondition and a single Undo boundary cannot be built on top of an arbitrary
Lua channel.

## Ask, do not assume

Both sides declare their capabilities at runtime rather than expecting a caller
to hardcode this table: `harmony_capabilities` on SV1, `sv_describe` and
`sv_status` here. Version-specific behavior — SV build, script build, which
channels are enabled — is only knowable at runtime, so read it there.
