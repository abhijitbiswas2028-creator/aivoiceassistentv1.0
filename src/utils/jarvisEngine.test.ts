import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSafeFetchDescriptor,
  computeGatedAudioEnvelope,
  computeVoiceOrbDynamics,
  computeRingHarmonics,
  resolveBrowserDestinationUrl,
  buildDesktopAppCommand,
  detectMultilingualLanguageHint,
  downsampleFloat32Buffer,
} from './jarvisEngine.ts';

test('computeGatedAudioEnvelope gates out quiet ambient room noise and bounds loud input', () => {
  const quietRoom = new Uint8Array(32).fill(4);
  const gatedQuiet = computeGatedAudioEnvelope(quietRoom, 0, 0.06);
  assert.equal(gatedQuiet.gatedEnergy, 0);
  assert.equal(gatedQuiet.lowBand, 0);

  const activeVoice = new Uint8Array(32).fill(180);
  const gatedActive = computeGatedAudioEnvelope(activeVoice, 0.2, 0.06);
  assert.ok(gatedActive.gatedEnergy > 0.3 && gatedActive.gatedEnergy <= 1);
  assert.ok(gatedActive.midBand > 0.5);
});

test('installSafeFetchDescriptor and computeVoiceOrbDynamics work deterministically', () => {
  const fakeWin: Record<string, unknown> = {};
  assert.equal(installSafeFetchDescriptor(fakeWin), true);
  const idleDyn = computeVoiceOrbDynamics('idle', 0);
  const speakDyn = computeVoiceOrbDynamics('speaking', 0.8);
  assert.ok(speakDyn.ribbonAmplitude > idleDyn.ribbonAmplitude);
  assert.ok(Math.abs(computeRingHarmonics(1.0, 2.0, 'speaking', 0.9)) <= 1.25);
});

test('resolveBrowserDestinationUrl resolves site shortcuts, domains, and search queries', () => {
  assert.equal(resolveBrowserDestinationUrl('youtube'), 'https://www.youtube.com');
  assert.equal(resolveBrowserDestinationUrl('github.com/torvalds'), 'https://github.com/torvalds');
  assert.ok(
    resolveBrowserDestinationUrl('latest linux kernel news').includes('duckduckgo.com/html/?q=')
  );
});

test('buildDesktopAppCommand and detectMultilingualLanguageHint handle desktop tasks and any language', () => {
  const vsCodeTask = buildDesktopAppCommand('vscode', 'execute_task', '/home/user/project');
  assert.equal(vsCodeTask.canonicalApp, 'VS Code');
  assert.equal(vsCodeTask.action, 'execute_task');
  assert.ok(vsCodeTask.linuxBinaries.includes('code'));

  const closeTerm = buildDesktopAppCommand('terminal', 'close');
  assert.equal(closeTerm.action, 'close');
  assert.ok(closeTerm.summary.includes('Closed desktop application Terminal'));

  assert.equal(detectMultilingualLanguageHint('नमस्ते जार्विस').code, 'hi');
  assert.equal(detectMultilingualLanguageHint('হ্যালো জার্ভিস').code, 'bn');
  assert.equal(detectMultilingualLanguageHint('Hola Jarvis').code, 'es');
  assert.equal(detectMultilingualLanguageHint('Hello Jarvis').code, 'en');

  const input48k = new Float32Array(480).fill(0.5);
  const resampled16k = downsampleFloat32Buffer(input48k, 48000, 16000);
  assert.equal(resampled16k.length, 160);
  assert.ok(Math.abs(resampled16k[0] - 0.5) < 1e-5);
});


