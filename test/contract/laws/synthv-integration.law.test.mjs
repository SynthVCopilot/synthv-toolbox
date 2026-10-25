import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { INTEGRATION_PREFERENCES, resolveSynthVIntegration, synthvDetected, isIntegrationPreference } = await compiled("services/integrations.js");

const evidence = fc.record({ installations: fc.nat(5), profiles: fc.nat(5), bridgeConnected: fc.boolean() });

test("on and off ignore the evidence, auto follows detection", () => {
  assertProperty(evidence, found => {
    assert.equal(resolveSynthVIntegration("on", found), true);
    assert.equal(resolveSynthVIntegration("off", found), false);
    assert.equal(resolveSynthVIntegration("auto", found), synthvDetected(found));
  });
});

test("detection is true exactly when an installation, a profile slot or a connected Bridge exists", () => {
  assertProperty(evidence, found => assert.equal(synthvDetected(found), found.installations > 0 || found.profiles > 0 || found.bridgeConnected));
});

test("more evidence never turns auto off", () => {
  assertProperty(fc.tuple(evidence, evidence), ([a, b]) => {
    const merged = { installations: a.installations + b.installations, profiles: a.profiles + b.profiles, bridgeConnected: a.bridgeConnected || b.bridgeConnected };
    if (resolveSynthVIntegration("auto", a)) assert.equal(resolveSynthVIntegration("auto", merged), true);
  });
});

test("only the three known preferences are accepted", () => {
  assertProperty(fc.anything(), value => assert.equal(isIntegrationPreference(value), INTEGRATION_PREFERENCES.includes(value)));
  assert.deepEqual([...INTEGRATION_PREFERENCES].sort(), ["auto", "off", "on"]);
});
