import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const capabilities = readFileSync('web-panel/src/pages/CapabilitiesPage.vue', 'utf8');
const models = readFileSync('web-panel/src/pages/ModelsPage.vue', 'utf8');

test('R22 capability grid paginates cards', () => {
  assert.match(capabilities, /const PAGE_SIZE = 12/);
  assert.match(capabilities, /const pagedCards = computed/);
  assert.match(capabilities, /v-for="card in pagedCards"/);
  assert.match(capabilities, /上一页/);
  assert.match(capabilities, /下一页/);
});

test('R22 trigger/continue role binds editable model fields', () => {
  assert.match(models, /key: 'trigger'[\s\S]*section: 'bot\.keywordTrigger'[\s\S]*nodeField: 'intentNodeIndex'[\s\S]*modelField: 'intentModel'/);
});
