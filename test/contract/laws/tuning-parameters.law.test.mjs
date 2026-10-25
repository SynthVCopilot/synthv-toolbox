import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { PARAMETER_BOUNDS, parametersFromFeatures, blendParameters, moveParametersAway, featureDistance } = await compiled("services/tuning-service.js");

const number = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e12, max: 1e12 });
const features = fc.record({ durationSec: number, medianPitchMidi: number, pitchRangeSemitones: number, vibratoRateHz: number, vibratoDepthCents: number, dynamicRangeDb: number, breathinessProxy: number, brightnessHz: number, voicedRatio: number });
const parameters = fc.record(Object.fromEntries(Object.entries(PARAMETER_BOUNDS).map(([key, [minimum, maximum]]) => [key, fc.double({ noNaN: true, min: minimum, max: maximum })])));
const withinBounds = value => Object.entries(PARAMETER_BOUNDS).every(([key, [minimum, maximum]]) => Number.isFinite(value[key]) && value[key] >= minimum && value[key] <= maximum);

test("parameters suggested from any finite features stay inside the declared SynthV bounds", () => {
  assertProperty(features, input => assert.ok(withinBounds(parametersFromFeatures(input)), JSON.stringify(parametersFromFeatures(input))));
});

test("blending toward or away from any in-bounds candidate with any weight stays inside the bounds", () => {
  assertProperty(fc.tuple(parameters, parameters, number), ([current, candidate, weight]) => {
    assert.ok(withinBounds(blendParameters(current, candidate, weight)));
    assert.ok(withinBounds(moveParametersAway(current, candidate, weight)));
  });
});

test("blending with weight zero keeps the profile and the feature distance of a sample to itself is zero", () => {
  assertProperty(fc.tuple(parameters, parameters, features), ([current, candidate, sample]) => {
    const blended = blendParameters(current, candidate, 0);
    for (const key of Object.keys(current)) assert.ok(blended[key] === current[key], key);
    assert.equal(featureDistance(sample, sample), 0);
  });
});
