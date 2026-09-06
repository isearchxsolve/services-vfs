import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createVFSManager, VFSManager } from '../src/index';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('VFSManager', () => {
  let manager: VFSManager;
  let testRepoPath: string;

  beforeAll(async () => {
    testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'emergent-vfs-test-'));
    manager = await createVFSManager({ repoPath: testRepoPath });
  });

  afterAll(async () => {
    await fs.rm(testRepoPath, { recursive: true, force: true });
  });

  describe('File operations', () => {
    it('should write and read a file', async () => {
      await manager.writeFile('test.txt', 'Hello, World!');
      const content = await manager.readFile('test.txt');
      expect(content).toBe('Hello, World!');
    });

    it('should write and read binary file', async () => {
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xFF]);
      await manager.writeFile('binary.bin', binaryData);
      const content = await manager.readFile('binary.bin', 'base64');
      expect(content).toBeInstanceOf(Uint8Array);
    });

    it('should delete a file', async () => {
      await manager.writeFile('to-delete.txt', 'Delete me');
      await manager.deleteFile('to-delete.txt');
      const exists = await manager.exists('to-delete.txt');
      expect(exists).toBe(false);
    });

    it('should check file existence', async () => {
      await manager.writeFile('exists.txt', 'I exist');
      const exists = await manager.exists('exists.txt');
      expect(exists).toBe(true);
      
      const notExists = await manager.exists('not-exists.txt');
      expect(notExists).toBe(false);
    });

    it('should stat a file', async () => {
      await manager.writeFile('stat.txt', 'Stat me');
      const stat = await manager.stat('stat.txt');
      expect(stat).not.toBeNull();
      expect(stat?.isFile).toBe(true);
      expect(stat?.size).toBe(7);
    });

    it('should list directory contents', async () => {
      await manager.writeFile('dir/file1.txt', 'File 1');
      await manager.writeFile('dir/file2.txt', 'File 2');
      const files = await manager.list('dir');
      expect(files).toContain('file1.txt');
      expect(files).toContain('file2.txt');
    });

    it('should create directories', async () => {
      await manager.mkdir('new/dir/path', true);
      const stat = await manager.stat('new/dir/path');
      expect(stat?.isDirectory).toBe(true);
    });

    it('should copy files', async () => {
      await manager.writeFile('source.txt', 'Copy me');
      await manager.copy('source.txt', 'dest.txt');
      const content = await manager.readFile('dest.txt');
      expect(content).toBe('Copy me');
    });

    it('should move files', async () => {
      await manager.writeFile('move-source.txt', 'Move me');
      await manager.move('move-source.txt', 'move-dest.txt');
      const exists = await manager.exists('move-source.txt');
      expect(exists).toBe(false);
      const content = await manager.readFile('move-dest.txt');
      expect(content).toBe('Move me');
    });
  });

  describe('Git operations', () => {
    it('should show status of changes', async () => {
      await manager.writeFile('status-test.txt', 'Status test');
      const status = await manager.status();
      expect(status.length).toBeGreaterThan(0);
      const fileStatus = status.find(s => s.path === 'status-test.txt');
      expect(fileStatus).toBeDefined();
      expect(fileStatus?.status).toBe('added');
    });

    it('should add files to staging', async () => {
      await manager.writeFile('add-test.txt', 'Add test');
      await manager.add('add-test.txt');
      const status = await manager.status();
      const fileStatus = status.find(s => s.path === 'add-test.txt');
      expect(fileStatus?.staged).toBe(true);
    });

    it('should commit changes', async () => {
      await manager.writeFile('commit-test.txt', 'Commit test');
      await manager.add('commit-test.txt');
      const commit = await manager.commit('Test commit', { name: 'Tester', email: 'test@example.com' });
      expect(commit.hash).toBeDefined();
      expect(commit.message).toBe('Test commit');
      expect(commit.author.name).toBe('Tester');
    });

    it('should show commit log', async () => {
      const log = await manager.log({ limit: 10 });
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].hash).toBeDefined();
      expect(log[0].message).toBeDefined();
    });

    it('should diff files', async () => {
      await manager.writeFile('diff-test.txt', 'Original content');
      await manager.add('diff-test.txt');
      await manager.commit('Original commit');
      
      await manager.writeFile('diff-test.txt', 'Modified content');
      const diffs = await manager.diff({ paths: ['diff-test.txt'] });
      expect(diffs.length).toBe(1);
      expect(diffs[0].path).toBe('diff-test.txt');
      expect(diffs[0].additions).toBeGreaterThan(0);
      expect(diffs[0].deletions).toBeGreaterThan(0);
    });

    it('should list branches', async () => {
      const branches = await manager.branch();
      expect(branches.length).toBeGreaterThan(0);
      expect(branches.some(b => b.name === 'main')).toBe(true);
    });

    it('should checkout branches', async () => {
      await manager.checkout('feature-test', true);
      const branches = await manager.branch();
      expect(branches.some(b => b.name === 'feature-test' && b.isHead)).toBe(true);
    });
  });

  describe('Tree operations', () => {
    it('should get repository tree', async () => {
      await manager.writeFile('tree/file1.txt', 'File 1');
      await manager.writeFile('tree/file2.txt', 'File 2');
      await manager.add('tree');
      await manager.commit('Add tree files');
      
      const tree = await manager.getTree();
      expect(tree.path).toBe('/');
      expect(tree.children.length).toBeGreaterThan(0);
    });

    it('should get blob content', async () => {
      await manager.writeFile('blob-test.txt', 'Blob content');
      await manager.add('blob-test.txt');
      await manager.commit('Add blob');
      
      const blob = await manager.getBlob('blob-test.txt');
      expect(blob).toBe('Blob content');
    });
  });

  describe('Remote operations', () => {
    it('should add remote', async () => {
      await manager.remoteAdd('test-remote', 'https://github.com/test/repo.git');
      const remotes = await manager.remoteList();
      expect(remotes.some(r => r.name === 'test-remote')).toBe(true);
    });

    it('should remove remote', async () => {
      await manager.remoteAdd('remove-remote', 'https://github.com/test/remove.git');
      await manager.remoteRemove('remove-remote');
      const remotes = await manager.remoteList();
      expect(remotes.some(r => r.name === 'remove-remote')).toBe(false);
    });
  });

  describe('Events', () => {
    it('should emit change events', async () => {
      const changes: string[] = [];
      manager.on('change', (data) => changes.push(data.path));
      
      await manager.writeFile('event-test.txt', 'Event test');
      expect(changes).toContain('event-test.txt');
    });

    it('should emit commit events', async () => {
      const commits: any[] = [];
      manager.on('commit', (data) => commits.push(data));
      
      await manager.writeFile('commit-event.txt', 'Commit event');
      await manager.add('commit-event.txt');
      await manager.commit('Event commit');
      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe('Event commit');
    });
  });

  describe('Watcher', () => {
    it('should create a watcher', async () => {
      const watcher = manager.watch('watched-dir');
      expect(watcher).toBeDefined();
      expect(typeof watcher.close).toBe('function');
      await watcher.close();
    });
  });
});

describe('createVFSManager', () => {
  it('should create a new VFS manager instance', async () => {
    const testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'emergent-vfs-create-'));
    const manager = await createVFSManager({ repoPath: testRepoPath });
    expect(manager).toBeDefined();
    await fs.rm(testRepoPath, { recursive: true, force: true });
  });

  it('should initialize repository with default branch', async () => {
    const testRepoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'emergent-vfs-branch-'));
    const manager = await createVFSManager({ repoPath: testRepoPath, defaultBranch: 'develop' });
    const branches = await manager.branch();
    expect(branches.some(b => b.name === 'develop')).toBe(true);
    await fs.rm(testRepoPath, { recursive: true, force: true });
  });
});
