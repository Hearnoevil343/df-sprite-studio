import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionRequest, buildPrompt, buildWorkflow, parseCaption, rankCandidates, cellFor, parseHistory, viewQuery, DEFAULT_GENERATE } from '../src/engine/ai/index.ts';

test('buildPrompt puts the trigger word first and rejects empty', () => {
  assert.match(buildPrompt('  a  brown  bear '), /^dfsprite, .*a brown bear/);
  assert.throws(() => buildPrompt('   '));
});

test('buildWorkflow wires prompt, seed, lora and size', () => {
  const wf = buildWorkflow('dfsprite, x', 7, { size: 512, strength: 0.8 });
  assert.equal(wf['3'].inputs.text, 'dfsprite, x');
  assert.equal(wf['6'].inputs.seed, 7);
  assert.equal(wf['2'].inputs.lora_name, DEFAULT_GENERATE.lora);
  assert.equal(wf['2'].inputs.strength_model, 0.8);
  assert.equal(wf['5'].inputs.width, 512);
  assert.equal(wf['8'].class_type, 'SaveImage');
});

test('parseHistory: pending, error, done', () => {
  assert.deepEqual(parseHistory({}, 'a'), { state: 'pending' });
  const bad = { a: { status: { status_str: 'error', messages: [['execution_error', { exception_message: 'oom' }]] } } };
  assert.deepEqual(parseHistory(bad, 'a'), { state: 'error', message: 'oom' });
  const ok = { a: { status: { status_str: 'success' }, outputs: { '8': { images: [{ filename: 'f.png', subfolder: '', type: 'output' }] } } } };
  const r = parseHistory(ok, 'a');
  assert.equal(r.state, 'done');
  if (r.state === 'done') assert.equal(viewQuery(r.image), 'filename=f.png&subfolder=&type=output');
  assert.equal(parseHistory({ a: { status: { status_str: 'success' }, outputs: {} } }, 'a').state, 'error');
});

test('cellFor divides size by the fake-pixel count', () => {
  assert.equal(cellFor(1024), 16);
  assert.throws(() => cellFor(1000));
});

test('buildCaptionRequest attaches the image; parseCaption cleans and rejects empty', () => {
  const req = buildCaptionRequest('QUJD');
  assert.equal(req.model, 'qwen2.5vl:7b');
  assert.equal(req.stream, false);
  assert.deepEqual((req.messages[0] as any).images, ['QUJD']);
  assert.equal(parseCaption({ message: { content: '  "A brown bear,\n  thick fur." ' } }),'A brown bear, thick fur');
  assert.throws(() => parseCaption({ message: { content: '  ' } }));
  assert.throws(() => parseCaption({}));
});

const iss = (rule: string, severity: 'error' | 'warn' | 'info') => ({ rule, severity, message: '' });

test('rankCandidates orders by score and sinks rejected ones', () => {
  const r = rankCandidates([
    { seed: 1, issues: [iss('stray', 'warn'), iss('outline', 'warn')] },
    { seed: 2, issues: [iss('palette', 'error')] },
    { seed: 3, issues: [iss('proportions', 'info')] },
    { seed: 4, issues: [iss('stray', 'warn')] },
    { seed: 5, issues: [iss('blank', 'warn')] },
  ]);
  assert.deepEqual(r.map(x => x.seed), [3, 4, 1, 5, 2]);
  assert.deepEqual(r.map(x => x.rejected), [false, false, false, true, true]);
  assert.equal(r[3].reason, 'blank');
  assert.equal(r[4].reason, 'palette');
  assert.equal(r[0].score, 0);
});
