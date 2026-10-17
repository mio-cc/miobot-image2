import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

import { detectFileKind, parseFile, PendingFileIndex } from '../dist/packages/file-ingest/src/index.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'miobot-file-'));
}

test('file ingest: text and extension detection', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'note.md');
  await fs.writeFile(file, '# Hello\nMiibot file input', 'utf8');
  assert.equal(detectFileKind('note.md'), 'text');
  const parsed = await parseFile(file);
  assert.equal(parsed.kind, 'text');
  assert.match(parsed.text, /Miibot file input/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('file ingest: docx/pptx/xlsx minimal OOXML extraction', async () => {
  const dir = await tempDir();
  const docx = new AdmZip();
  docx.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>'));
  const docxPath = path.join(dir, 'a.docx');
  docx.writeZip(docxPath);

  const pptx = new AdmZip();
  pptx.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><a:p><a:r><a:t>Slide Title</a:t></a:r></a:p></p:sld>'));
  const pptxPath = path.join(dir, 'a.pptx');
  pptx.writeZip(pptxPath);

  const xlsx = new AdmZip();
  xlsx.addFile('xl/sharedStrings.xml', Buffer.from('<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>'));
  xlsx.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="People"/></sheets></workbook>'));
  xlsx.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>'));
  const xlsxPath = path.join(dir, 'a.xlsx');
  xlsx.writeZip(xlsxPath);

  assert.match((await parseFile(docxPath)).text, /Hello DOCX/);
  assert.match((await parseFile(pptxPath)).text, /Slide Title/);
  const sheet = await parseFile(xlsxPath);
  assert.match(sheet.text, /Name/);
  assert.match(sheet.text, /Alice/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('file ingest: zip lists entries and reads small text files', async () => {
  const dir = await tempDir();
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('hello zip'));
  zip.addFile('data.bin', Buffer.from([0, 1, 2, 3]));
  const file = path.join(dir, 'bundle.zip');
  zip.writeZip(file);
  const parsed = await parseFile(file);
  assert.equal(parsed.kind, 'zip');
  assert.match(parsed.text, /readme\.txt/);
  assert.match(parsed.text, /hello zip/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('pending file index: records by message id and short code with chat isolation', async () => {
  const dir = await tempDir();
  const filePath = path.join(dir, 'pending.json');
  const index = new PendingFileIndex({ filePath, ttlMs: 60_000, maxPerChat: 10 });
  index.loadSync();
  const record = index.record({ messageId: '1001', chatType: 'group', groupId: '1', userId: '2', fileId: 'f1', name: 'a.txt', size: 10, mime: 'text/plain' });
  assert.match(record.code, /^F[0-9A-F]{5}$/);
  assert.equal(index.findByMessageId('group', '1', '2', '1001')?.name, 'a.txt');
  assert.equal(index.findCode('group', '1', '2', record.code)?.fileId, 'f1');
  assert.equal(index.findByMessageId('group', '9', '2', '1001'), undefined);
  await index.save();
  const loaded = new PendingFileIndex({ filePath, ttlMs: 60_000, maxPerChat: 10 });
  loaded.loadSync();
  assert.equal(loaded.findByMessageId('group', '1', '2', '1001')?.fileId, 'f1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('file ingest: generated PDF text can be extracted', async () => {
  const { generateFile } = await import('../dist/packages/filegen/src/index.js');
  const dir = await tempDir();
  const generated = await generateFile({ type: 'pdf', fileName: 'test', title: 'Miobot PDF', content: 'PDF content extraction works.' }, dir);
  const parsed = await parseFile(generated.path);
  assert.equal(parsed.kind, 'pdf');
  assert.match(parsed.text, /Miobot PDF/);
  assert.match(parsed.text, /PDF content extraction works/);
  await fs.rm(dir, { recursive: true, force: true });
});
