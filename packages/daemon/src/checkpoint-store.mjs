import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export class CheckpointStore {
  constructor(db, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Checkpoint encryption key must be 32 bytes');
    this.db = db;
    this.key = key;
  }

  static async open(db, directory) {
    const root = resolve(directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const path = join(root, 'checkpoint.key');
    let key;
    try {
      key = await readFile(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      key = randomBytes(32);
      try {
        await writeFile(path, key, { flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        key = await readFile(path);
      }
    }
    if (key.length !== 32) throw new Error('Checkpoint key file is invalid');
    await chmod(path, 0o600);
    return new CheckpointStore(db, key);
  }

  seal(state) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext=Buffer.from(JSON.stringify(state),'utf8');
    if(plaintext.length>8*1024*1024)throw new Error('Runtime checkpoint exceeds the 8 MB persistence limit');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  unseal(value) {
    const [version, ivText, tagText, encryptedText, extra] = String(value).split('.');
    if (version !== 'v1' || !ivText || !tagText || !encryptedText || extra) throw new Error('Checkpoint encoding is invalid');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
  }

  save(runId, state, approvalId, argsHash, updatedAt = new Date().toISOString()) {
    const sealed = this.seal(state);
    this.db.prepare(`INSERT INTO runtime_checkpoints(run_id,state_json,approval_id,args_hash,attempts,updated_at)
      VALUES(?,?,?,?,0,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json,
      approval_id=excluded.approval_id,args_hash=excluded.args_hash,updated_at=excluded.updated_at`).run(runId, sealed, approvalId, argsHash, updatedAt);
  }

  get(runId) {
    const row = this.db.prepare('SELECT * FROM runtime_checkpoints WHERE run_id=?').get(runId);
    return row ? { ...row, state: this.unseal(row.state_json) } : null;
  }

  getForApproval(approvalId) {
    const row = this.db.prepare('SELECT * FROM runtime_checkpoints WHERE approval_id=?').get(approvalId);
    return row ? { ...row, state: this.unseal(row.state_json) } : null;
  }

  delete(runId) {
    this.db.prepare('DELETE FROM runtime_checkpoints WHERE run_id=?').run(runId);
  }
}
