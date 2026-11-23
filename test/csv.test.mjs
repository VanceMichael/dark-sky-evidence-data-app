import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTable, toCsv, splitList } from '../src/io/csv.mjs';

test('parseTable keeps empty fields as empty strings', () => {
  assert.deepEqual(
    parseTable('id,note\nX,\n', ['id', 'note'], '交接'),
    [{ id: 'X', note: '' }]
  );
});

test('parseTable reports the offending line number', () => {
  assert.throws(() => parseTable('id,note\nX\n', ['id', 'note'], '交接'), /第 2 行/);
  assert.throws(() => parseTable('id,note\nX,"quoted"\n', ['id', 'note'], '交接'), /第 2 行/);
});

test('parseTable rejects a header that does not match the contract', () => {
  assert.throws(() => parseTable('id,other\nX,1\n', ['id', 'note'], '交接'), /表头/);
});

test('parseTable attaches a non-enumerable line number', () => {
  const [row] = parseTable('id,note\nX,Y\n', ['id', 'note'], '交接');
  assert.equal(row.line, 2);
  assert.deepEqual(Object.keys(row), ['id', 'note']);
});

test('toCsv round-trips through parseTable', () => {
  const fields = ['a', 'b'];
  const rows = [{ a: '1', b: '2' }, { a: '3', b: '' }];
  const text = toCsv(fields, rows);
  assert.deepEqual(parseTable(text, fields, 't'), rows);
});

test('toCsv refuses fields that would break the contract', () => {
  assert.throws(() => toCsv(['a'], [{ a: 'x,y' }]), /约定之外的字符/);
  assert.throws(() => toCsv(['a'], [{ a: 'x"y' }]), /约定之外的字符/);
});

test('splitList treats empty and dash as no values', () => {
  assert.deepEqual(splitList(''), []);
  assert.deepEqual(splitList('-'), []);
  assert.deepEqual(splitList('W|E'), ['W', 'E']);
  assert.deepEqual(splitList('W'), ['W']);
});
