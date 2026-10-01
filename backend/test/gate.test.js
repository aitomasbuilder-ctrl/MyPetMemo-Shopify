const test = require('node:test');
const assert = require('node:assert');
const { checkOrder } = require('../lib/gate');

const line = (over = {}, props = {}) => ({
  id: 1, product_id: 9612228264038, variant_id: 48957877813350,
  properties: Object.entries({ _approved: 'true', _print_file_url: 'https://files.example.com/a.png', _shape: 'Medallion', ...props }).map(([name, value]) => ({ name, value })),
  ...over
});
const order = (o = {}) => ({ financial_status: 'paid', line_items: [line()], ...o });

test('paid + approved + file passes and maps variant', () => {
  const r = checkOrder(order());
  assert.equal(r.ok, true);
  assert.equal(r.items[0].printify_variant_id, 102555);
});
test('unpaid blocked', () => assert.deepEqual(checkOrder(order({ financial_status: 'pending' })).reasons, ['order_not_paid']));
test('unapproved blocked', () => assert.ok(checkOrder(order({ line_items: [line({}, { _approved: 'false' })] })).reasons.includes('design_not_approved:1')));
test('missing print file blocked', () => assert.ok(checkOrder(order({ line_items: [line({}, { _print_file_url: '' })] })).reasons.includes('print_file_missing:1')));
test('unmapped variant blocked', () => assert.ok(checkOrder(order({ line_items: [line({ variant_id: 1 })] })).reasons[0].startsWith('variant_unmapped')));
test('shape mismatch blocked', () => assert.ok(checkOrder(order({ line_items: [line({}, { _shape: 'Square' })] })).reasons.includes('shape_mismatch:1')));
test('non-ornament order is not ours', () => assert.ok(checkOrder(order({ line_items: [line({ product_id: 5 })] })).reasons.includes('no_ornament_lines')));
test('garbage input does not throw', () => assert.equal(checkOrder(null).ok, false));
