import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import { DEFAULT_FILEGEN_LIMITS, generateFile, generatedFileSpecFromJson } from '../dist/packages/filegen/src/index.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'miobot-filegen-'));
}

test('filegen: txt/md/json/csv/docx/xlsx/pptx/pdf/zip produce files', async () => {
  const dir = await tempDir();
  const txt = await generateFile({ type: 'txt', fileName: 'a', content: 'hello' }, dir);
  assert.match(txt.name, /a\.txt$/);
  assert.equal(await fs.readFile(txt.path, 'utf8'), 'hello');

  const docx = await generateFile({ type: 'docx', fileName: 'word', title: 'Doc', sections: [{ heading: 'H', body: 'Body', bullets: ['one'] }] }, dir);
  assert.ok(docx.size > 100);
  const xlsx = await generateFile({ type: 'xlsx', fileName: 'sheet', sheets: [{ name: 'S1', rows: [['Name', 'Age'], ['Alice', 3]] }] }, dir);
  assert.ok(xlsx.size > 100);
  const pptx = await generateFile({ type: 'pptx', fileName: 'slides', title: 'Deck', slides: [{ title: 'S1', bullets: ['a', 'b'] }] }, dir);
  assert.ok(pptx.size > 100);
  const pdf = await generateFile({ type: 'pdf', fileName: 'doc', title: 'PDF', content: 'hello pdf' }, dir);
  assert.ok(pdf.size > 100);
  const zip = await generateFile({ type: 'zip', fileName: 'bundle', files: [{ name: 'readme.txt', content: 'zip text' }] }, dir);
  assert.ok(zip.size > 100);
  await fs.rm(dir, { recursive: true, force: true });
});

test('filegen: model JSON can be extracted from fences and validated', () => {
  const spec = generatedFileSpecFromJson('```json\n{"type":"docx","fileName":"report","title":"T","sections":[{"body":"B"}]}\n```');
  assert.equal(spec.type, 'docx');
  assert.equal(spec.fileName, 'report');
  assert.throws(() => generatedFileSpecFromJson('{"type":"exe"}'), /不支持/);
});

test('filegen: output size limit removes oversized file', async () => {
  const dir = await tempDir();
  const limits = { ...DEFAULT_FILEGEN_LIMITS, maxOutputBytes: 10 };
  await assert.rejects(() => generateFile({ type: 'txt', fileName: 'big', content: 'x'.repeat(100) }, dir, limits), /超过上限/);
  await fs.rm(dir, { recursive: true, force: true });
});


test('filegen: docx supports model-selected theme, cover, table, callout and footer', async () => {
  const dir = await tempDir();
  const spec = generatedFileSpecFromJson(JSON.stringify({
    type: 'docx',
    fileName: 'styled-report',
    title: 'Styled Report',
    subtitle: 'Subtitle',
    style: { theme: 'modern', accentColor: '0F766E', coverPage: true, header: 'Header', footer: 'Footer', tableStyle: 'striped' },
    sections: [
      { heading: 'Overview', body: 'Body paragraph', bullets: ['One', 'Two'] },
      { heading: 'Data', table: { headers: ['Name', 'Value'], rows: [['A', '1'], ['B', '2']] } },
      { callout: { title: 'Note', body: 'Important', tone: 'success' } },
    ],
  }));
  assert.equal(spec.style?.theme, 'modern');
  assert.equal(spec.sections?.[1]?.table?.headers?.[0], 'Name');
  const docx = await generateFile(spec, dir);
  assert.match(docx.name, /styled-report\.docx$/);
  assert.ok(docx.size > 1000);
  const zip = new AdmZip(docx.path);
  const xml = zip.readAsText('word/document.xml');
  assert.match(xml, /Styled Report/);
  assert.match(xml, /0F766E/);
  assert.match(xml, /Overview/);
  assert.match(xml, /Data/);
  assert.match(xml, /Important/);
  await fs.rm(dir, { recursive: true, force: true });
});
