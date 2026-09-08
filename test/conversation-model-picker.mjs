import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const main = await readFile(new URL("../src/PiDesktop.Tauri/src/main.ts", import.meta.url), "utf8");
const pickerSource = main.slice(main.indexOf("function hasSelectableAiConnection"), main.indexOf("function aiConnectionSummary"));
const selectionSource = main.slice(main.indexOf("function selectChatModel"), main.indexOf("function aiConnectionSummary"));

function provider(overrides = {}) {
  return {
    id: "openai-codex", displayName: "OpenAI", description: "Connected", active: true, connected: true,
    oauthEnabled: true, model: "saved-model", models: ["catalog-model"],
    accounts: [{ authorized: true, enabled: true }], apiKeys: [], ...overrides,
  };
}

function pickerHarness(providers, catalogError = null) {
  const factory = new Function("providers", "catalogError", "stripTypeScriptTypes", `
    let aiModelPickerOpen = true, busy = false;
    let app = { model: { catalogError } };
    const aiProviders = () => providers;
    const isActiveAiProvider = provider => provider.active;
    const escapeHtml = value => String(value);
    const icon = () => "✓";
    const t = key => key;
    ${stripTypeScriptTypes(pickerSource)}
    return { render: renderAiModelPicker };
  `);
  return factory(providers, catalogError, stripTypeScriptTypes);
}

{
  const html = pickerHarness([provider(), provider({ id: "disabled-oauth", oauthEnabled: false }), provider({ id: "disabled-credential", accounts: [{ authorized: true, enabled: false }] })]).render();
  assert.match(html, /data-select-chat-model data-provider-id="openai-codex"/);
  assert.doesNotMatch(html, /data-provider-id="disabled-oauth"/);
  assert.doesNotMatch(html, /data-provider-id="disabled-credential"/);
}

{
  const html = pickerHarness([provider({ model: "saved-model", models: [] })], "directory unavailable").render();
  assert.match(html, /data-model-id="saved-model"/);
  assert.match(html, /copilot\.modelPickerCatalogUnavailable/);
}

{
  const html = pickerHarness([]).render();
  assert.match(html, /data-open-ai-provider-connections/);
  assert.doesNotMatch(html, /data-open-ai-provider-picker/);
}

{
  const selected = [];
  const factory = new Function("initialApp", "selected", "stripTypeScriptTypes", `
    let app = initialApp, aiModelPickerOpen = true, aiModelPickerGeneration = 0, notice = "";
    let renders = 0;
    const render = () => { renders++; };
    const activeAiProvider = () => app.model.providers.find(provider => provider.active);
    const t = key => key;
    const api = { selectAiProvider: async (provider, model) => {
      selected.push([provider, model]);
      return { model: { providers: [{ id: provider, model, active: true }] } };
    } };
    const run = async task => { await task(); };
    ${stripTypeScriptTypes(selectionSource)}
    return { selectChatModel, state: () => ({ app, aiModelPickerOpen, notice, renders }) };
  `);
  const harness = factory({ model: { providers: [{ id: "openai-codex", model: "old-model", active: true }] } }, selected, stripTypeScriptTypes);
  harness.selectChatModel("openai-codex", "new-model");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(selected, [["openai-codex", "new-model"]]);
  assert.equal(harness.state().app.model.providers[0].model, "new-model");
  assert.equal(harness.state().aiModelPickerOpen, false);
  assert.equal(harness.state().notice, "accountUi.currentAiProviderAndModelUpdated");
}

console.log("Conversation model picker behavior passed.");
