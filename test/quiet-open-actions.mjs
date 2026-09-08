import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../src/PiDesktop.Tauri/package.json', import.meta.url));
const { parse } = require('@babel/parser');
const source = readFileSync(new URL('../src/PiDesktop.Tauri/src/main.ts', import.meta.url), 'utf8');
const functions = new Set(['setFeedback', 'setOpenFeedback']);
const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
const implementation = ast.program.body
  .filter((node) => node.type === 'FunctionDeclaration' && functions.has(node.id.name))
  .map((node) => source.slice(node.start, node.end))
  .join('\n');
assert.match(implementation, /function setOpenFeedback/, 'External-open feedback has a scoped helper');

const state = { notice: 'Existing notice', error: 'Existing error' };
vm.createContext(state);
vm.runInContext(stripTypeScriptTypes(implementation, { mode: 'strip' }), state);

state.setOpenFeedback({ succeeded: true, summary: 'Opened official releases', detail: 'No download started' });
assert.equal(state.notice, 'Existing notice', 'Successful external opens do not add a notice');
assert.equal(state.error, 'Existing error', 'Successful external opens do not clear an existing error');

state.setOpenFeedback({ succeeded: false, summary: 'Unable to open settings', detail: 'System denied the request' });
assert.equal(state.notice, '', 'Failed external opens clear stale notices');
assert.equal(state.error, 'Unable to open settings\nSystem denied the request', 'Failed external opens retain the concrete error');

assert.match(source, /revealAudioArtifact\([^)]*\)\.then\(\(result\) => \{\s*setOpenFeedback\(result\)/, 'Revealing an audio artifact is quiet on success');
for (const action of [
  'openSvpDefaultAppsSettings',
  'openToolboxProject',
  'openToolboxReleases',
  'openSv2ProfileFolder',
  'openDownloadedComponent',
  'openFfmpegDownloadPage',
]) {
  assert.match(source, new RegExp(`setOpenFeedback\\(await (?:audioApi|api)\\.${action}`), `${action} is quiet on success`);
}
const updateCheckHandler = source.match(/if \(target\.hasAttribute\("data-check-toolbox-update"\)\) \{([\s\S]*?)\n  \}\n  if \(target\.hasAttribute\("data-download-toolbox-update"\)\)/)?.[1];
assert.ok(updateCheckHandler, 'Update check handler is present');
assert.match(updateCheckHandler, /toolboxUpdate = result/);
assert.match(updateCheckHandler, /toolboxUpdateDownload = await api\.getToolboxUpdateDownload\(\)/);
assert.doesNotMatch(updateCheckHandler, /notice\s*=/, 'Checking for an update leaves status to the update card');
assert.match(source, /setFeedback\(await api\.installToolboxUpdate\(\)\)/, 'Installing an update still reports its result');
assert.match(source, /setFeedback\(result\);\s*\n\s*}\)\.finally\(\(\) => \{\s*\n\s*if \(removingComponentId/, 'Component removal still reports its result');

console.log('Quiet external open actions preserve failures and suppress successful notices.');
