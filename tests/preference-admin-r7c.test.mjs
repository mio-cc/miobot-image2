import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebApi } from '../dist/packages/web-api/src/index.js';

test('admin R7c: reply preference records can be listed, deleted and cleared with audit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'miobot-reply-admin-'));
  const prefFile = path.join(dir, 'reply-preferences.json');
  const auditFile = path.join(dir, 'audit.jsonl');
  const now = new Date();
  const records = [
    {
      scope: 'session', key: 'private:1', preference: { voice: 'off' },
      updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    {
      scope: 'user', key: '1', preference: { forwardStyle: 'flat' },
      updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    },
  ];
  await fs.writeFile(prefFile, JSON.stringify({ version: 1, records }), 'utf8');
  const oldPref = process.env.MIOBOT_REPLY_PREFERENCES_FILE;
  const oldAudit = process.env.MIOBOT_AUDIT_FILE;
  process.env.MIOBOT_REPLY_PREFERENCES_FILE = prefFile;
  process.env.MIOBOT_AUDIT_FILE = auditFile;
  try {
    const api = createWebApi();
    const login = await api.handle({ method: 'POST', path: '/api/login', body: { password: 'change-me-on-first-login' } });
    const headers = { authorization: `Bearer ${login.body.auth.token}` };

    const listed = await api.handle({ method: 'GET', path: '/api/reply-preferences', headers });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.records.length, 2);
    assert.equal(listed.body.records.find((item) => item.scope === 'user').expired, true);

    const deleted = await api.handle({
      method: 'POST', path: '/api/reply-preferences/delete', headers,
      body: { scope: 'session', key: 'private:1' },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.removed, 1);

    const afterDelete = await api.handle({ method: 'GET', path: '/api/reply-preferences', headers });
    assert.equal(afterDelete.body.records.length, 1);
    assert.equal(afterDelete.body.records[0].scope, 'user');

    const cleared = await api.handle({
      method: 'POST', path: '/api/reply-preferences/clear', headers,
      body: { scope: 'user' },
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.removed, 1);

    const empty = await api.handle({ method: 'GET', path: '/api/reply-preferences', headers });
    assert.deepEqual(empty.body.records, []);

    const auditLines = (await fs.readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(auditLines.some((item) => item.type === 'reply_preference.deleted' && item.data.key === 'private:1'));
    assert.ok(auditLines.some((item) => item.type === 'reply_preference.cleared' && item.data.scope === 'user'));
  } finally {
    if (oldPref === undefined) delete process.env.MIOBOT_REPLY_PREFERENCES_FILE; else process.env.MIOBOT_REPLY_PREFERENCES_FILE = oldPref;
    if (oldAudit === undefined) delete process.env.MIOBOT_AUDIT_FILE; else process.env.MIOBOT_AUDIT_FILE = oldAudit;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
