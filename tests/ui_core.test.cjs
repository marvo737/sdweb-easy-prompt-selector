const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Catalog, PromptState, tokens } = require('../javascript/easy_prompt_selector.js');

const catalog = () => new Catalog({
  tags: { hair: { brown: 'brown hair', blonde: 'blonde hair' }, eyes: ['blue eyes', 'green eyes'], fixed: 'solo', pair: 'brown hair, blue eyes' },
  scenes: { morning: 'morning, @tags:hair@, @tags:eyes@', fixed: '@tags:fixed@, upper body' }
});
test('Nested group/list references expand with a readable trace', () => {
  const c = catalog(), p = c.preview('@scenes:morning@', () => 0);
  assert.equal(p.text, 'morning, brown hair, blue eyes');
  assert.deepEqual(p.trace.map(t => t.label), ['brown', 'blue eyes']);
  assert.equal(p.random, true);
  assert.deepEqual(c.analyze('@scenes:morning@').fixed, ['morning']);
});
test('Fixed references stay fixed, list buttons stay literal', () => {
  const c = catalog();
  assert.equal(c.preview('@scenes:fixed@').random, false);
  assert.equal(c.preview('@scenes:fixed@').text, 'solo, upper body');
  assert.equal(c.input(c.nodes.get('tags:eyes:0')), 'blue eyes');
  assert.throws(() => c.get('tags:eyes:0'), /参照先/);
});
test('Count and range references keep backend-compatible count semantics', () => {
  const c = catalog();
  assert.equal(c.preview('@2$$tags:fixed@', () => 0).text, 'solo, solo');
  assert.equal(c.preview('@1-3$$tags:fixed@', () => .999).text, 'solo, solo, solo');
  assert.equal(c.preview('@0$$missing@').text, '');
  assert.equal(c.preview('@3-1$$tags:fixed@', () => 0).text, 'solo');
  assert.throws(() => c.preview('@999999$$tags:fixed@'), /50/);
});
test('Missing, malformed and recursive references cannot be frozen', () => {
  const c = new Catalog({ a: { cycle: '@b@' }, b: '@a:cycle@' });
  assert.throws(() => c.preview('@a:cycle@'), /循環/);
  assert.throws(() => c.preview('@unknown@'), /参照先/);
  assert.throws(() => c.preview('@unfinished'), /指定/);
});
test('Nested reference weights and ordinary prompt syntax are preserved', () => {
  const c = catalog();
  const p = '(long hair, (blue eyes:1.2):1.4), <lora:a.b+name:0.3>, @tags:fixed@';
  assert.equal(c.preview(p).text, '(long hair, (blue eyes:1.2):1.4), <lora:a.b+name:0.3>, solo');
  assert.deepEqual(tokens(p), ['(long hair, (blue eyes:1.2):1.4)', '<lora:a.b+name:0.3>', '@tags:fixed@']);
});
test('Descriptions are used only for the matching current definition', () => {
  const c = new Catalog({ a: { item: 'brown hair' } }, { 'a:item': { value: 'blonde hair', description: '金髪' } });
  assert.notEqual(c.summary(c.nodes.get('a:item')), '金髪');
});
test('Warnings separate possible overlap from literal contradictions', () => {
  const c = new Catalog({ f: { upper: 'upper body', cowboy: 'cowboy shot' } });
  assert.ok(c.warnings('morning, night').some(w => w.includes('昼と夜')));
  assert.equal(c.warnings('morning, day').length, 0);
  assert.ok(c.warnings('@f@, full body').some(w => w.includes('ランダム')));
  assert.ok(c.warnings('upper body, full body').some(w => w.includes('画角')));
  assert.equal(c.warnings('bad hands, hands').length, 0);
});
test('Adding and removing a whole preset does not delete neighboring text', () => {
  const s = new PromptState('masterpiece');
  const a = s.add('brown hair, blue eyes', { label: 'Alice' }).span;
  const b = s.add('(light smile:1.2)', { label: 'Smile' }).span;
  s.remove(a.id);
  assert.equal(s.text, 'masterpiece, (light smile:1.2)');
  assert.equal(s.spans[0].id, b.id);
  s.remove(b.id);
  assert.equal(s.text, 'masterpiece');
});
test('Literal punctuation never becomes a regular expression', () => {
  const s = new PromptState();
  const raw = '<lora:eyes.v1+detail[1]:0.3>, (blue eyes:1.2)';
  const span = s.add(raw, { label: 'Eyes' }).span;
  s.add('blonde hair', { label: 'Hair' });
  s.remove(span.id);
  assert.equal(s.text, 'blonde hair');
});
test('Insertions before a tracked item shift its position', () => {
  const s = new PromptState();
  const span = s.add('brown hair', { label: 'Hair' }).span;
  s.sync('masterpiece, ' + s.text);
  s.remove(span.id);
  assert.equal(s.text, 'masterpiece');
});
test('Partial edits invalidate a preset while preserving a neighboring item', () => {
  const s = new PromptState();
  const a = s.add('brown hair, blue eyes', { label: 'Character' }).span;
  const b = s.add('standing', { label: 'Pose' }).span;
  s.sync(s.text.replace('blue', 'green'));
  assert.throws(() => s.remove(a.id), /本文/);
  assert.equal(s.spans.length, 1);
  s.remove(b.id);
  assert.equal(s.text, 'brown hair, green eyes');
  assert.equal(s.untracked(), true);
});
test('Changing a tag at its boundaries cannot leave a misleading chip', () => {
  const first = new PromptState();
  first.add('long hair', { label: 'Hair' });
  first.sync('very long hair');
  assert.equal(first.spans.length, 0);
  const second = new PromptState();
  second.add('blue', { label: 'Blue' });
  second.sync('blue eyes');
  assert.equal(second.spans.length, 0);
});
test('Explicit references pasted by hand can be recovered without guessing raw presets', () => {
  const c = catalog(), s = new PromptState('masterpiece, @scenes:morning@, brown hair');
  s.recover(c);
  assert.equal(s.spans.length, 1);
  assert.equal(s.spans[0].label, 'morning');
  assert.equal(s.untracked(), true);
});
test('Inner references are not duplicated as chips inside an added preset', () => {
  const c = catalog(), s = new PromptState();
  s.add('masterpiece, @scenes:morning@', { label: 'Complete' });
  s.recover(c);
  assert.equal(s.spans.length, 1);
});
test('Undo to an exact snapshot can restore selection labels', () => {
  const s = new PromptState();
  s.add('brown hair, blue eyes', { label: 'Original' });
  const original = s.text;
  s.sync(original.replace('blue', 'green'));
  assert.equal(s.spans.length, 0);
  s.sync(original);
  assert.equal(s.spans[0].label, 'Original');
});
test('Freezing replaces one selected reference and preserves its neighbors', () => {
  const c = catalog(), s = new PromptState('masterpiece');
  const span = s.add('@scenes:morning@', { label: 'Morning' }).span;
  s.add('film grain', { label: 'Effect' });
  const p = c.preview(span.raw, () => 0);
  s.replace(span.id, p.text, { label: 'Morning', mode: 'fixed', trace: p.trace });
  assert.equal(s.text, 'masterpiece, morning, brown hair, blue eyes, film grain');
  assert.equal(s.spans[0].mode, 'fixed');
  s.remove(s.spans[0].id);
  assert.equal(s.text, 'masterpiece, film grain');
});
test('Positive and negative states are independent', () => {
  const positive = new PromptState(), negative = new PromptState();
  positive.add('text', { label: 'Text' });
  negative.add('text', { label: 'Text' });
  negative.remove(negative.spans[0].id);
  assert.equal(positive.text, 'text');
  assert.equal(negative.text, '');
});
test('An exact tracked duplicate is not appended twice', () => {
  const s = new PromptState();
  s.add('solo', { label: 'Solo' });
  assert.equal(s.add('solo', { label: 'Other name' }).duplicate, true);
  assert.equal(s.text, 'solo');
  assert.equal(s.spans.length, 1);
});
test('Restored records must still match the current text', () => {
  const s = new PromptState('standing', [{ start: 0, end: 7, raw: 'sitting', label: 'Old' }]);
  assert.equal(s.spans.length, 0);
});
