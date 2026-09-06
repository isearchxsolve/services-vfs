import { EventEmitter } from "events";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as git from "isomorphic-git";
import { v4 as uuidv4 } from "uuid";
import * as diff from "diff";
import {
  VFSConfig,
  VFSManager,
  FileEntry,
  DirectoryEntry,
  CommitInfo,
  BranchInfo,
  StatusEntry,
  DiffResult,
  DiffHunk,
  DiffLine,
  FileStat,
  LogOptions,
  DiffOptions,
  MergeOptions,
  MergeResult,
  RemoteInfo,
  VFSWatcher
} from "./types";

class FileSystemAdapter {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private resolve(p: string): string {
    return path.resolve(this.basePath, p);
  }

  async readFile(p: string): Promise<Uint8Array> {
    if (!p) throw new Error("path required");
    return fs.readFile(this.resolve(p));
  }

  async writeFile(p: string, data: Uint8Array): Promise<void> {
    await fs.mkdir(path.dirname(this.resolve(p)), { recursive: true });
    await fs.writeFile(this.resolve(p), data);
  }

  async unlink(p: string): Promise<void> {
    await fs.unlink(this.resolve(p));
  }

  async mkdir(p: string): Promise<void> {
    await fs.mkdir(this.resolve(p), { recursive: true });
  }

  async rmdir(p: string): Promise<void> {
    await fs.rmdir(this.resolve(p), { recursive: true });
  }

  async readdir(p: string): Promise<string[]> {
    return fs.readdir(this.resolve(p));
  }

  async stat(p: string): Promise<fs.Stats> {
    return fs.stat(this.resolve(p));
  }

  async lstat(p: string): Promise<fs.Stats> {
    return fs.lstat(this.resolve(p));
  }

  async appendFile(p: string, data: Uint8Array): Promise<void> {
    await fs.appendFile(this.resolve(p), data);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fs.copyFile(this.resolve(src), this.resolve(dest));
  }

  async rename(src: string, dest: string): Promise<void> {
    await fs.rename(this.resolve(src), this.resolve(dest));
  }

  async realpath(p: string): Promise<string> {
    return fs.realpath(this.resolve(p));
  }

  async truncate(p: string, len: number): Promise<void> {
    await fs.truncate(this.resolve(p), len);
  }

  async chmod(p: string, mode: number): Promise<void> {
    await fs.chmod(this.resolve(p), mode);
  }

  async utimes(p: string, atime: number, mtime: number): Promise<void> {
    await fs.utimes(this.resolve(p), new Date(atime), new Date(mtime));
  }

  async readlink(p: string): Promise<string> {
    return fs.readlink(this.resolve(p));
  }

  async symlink(target: string, p: string): Promise<void> {
    await fs.symlink(this.resolve(target), this.resolve(p));
  }

  async cp(src: string, dest: string): Promise<void> {
    await fs.cp(this.resolve(src), this.resolve(dest), { recursive: true });
  }

  async rm(p: string): Promise<void> {
    await fs.rm(this.resolve(p), { recursive: true, force: true });
  }
}

export class VFSManagerImpl extends EventEmitter implements VFSManager {
  private fsAdapter: FileSystemAdapter;
  private repoPath: string;
  private gitdir: string;
  private defaultBranch: string;
  private initialized = false;

  constructor(config: VFSConfig) {
    super();
    this.repoPath = config.repoPath;
    this.gitdir = path.join(config.repoPath, ".git");
    this.defaultBranch = config.defaultBranch || "main";
    
    this.fsAdapter = new FileSystemAdapter(config.repoPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      await git.init({ fs: this.fsAdapter as any, dir: this.repoPath, defaultBranch: this.defaultBranch });
      
      // Configure git user
      await git.setConfig({ ...this.getGitOptions(), path: "user.name", value: "Emergent" });
      await git.setConfig({ ...this.getGitOptions(), path: "user.email", value: "emergent@localhost" });
      
      // Create initial commit if empty
      const branches = await git.listBranches({ fs: this.fsAdapter as any, dir: this.repoPath });
      if (branches.length === 0) {
        await this.writeFile(".gitkeep", "");
        await this.add(".gitkeep");
        await this.commit("Initial commit", { name: "Emergent", email: "emergent@localhost" });
      }
      
      this.initialized = true;
    } catch (error) {
      // If already initialized, just continue
      this.initialized = true;
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("VFS not initialized. Call init() first.");
    }
  }

  private getGitOptions() {
    return { fs: this.fsAdapter as any, dir: this.repoPath, gitdir: this.gitdir };
  }

  // File operations
  async readFile(filePath: string, encoding: "utf8" | "base64" = "utf8"): Promise<string | Uint8Array> {
    this.ensureInitialized();
    const fullPath = path.resolve(this.repoPath, filePath);
    const content = await fs.readFile(fullPath);
    return encoding === "utf8" ? content.toString("utf8") : content;
  }

  async writeFile(filePath: string, content: string | Uint8Array, encoding: "utf8" | "base64" = "utf8"): Promise<void> {
    this.ensureInitialized();
    const fullPath = path.resolve(this.repoPath, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    
    const buffer = typeof content === "string" 
      ? Buffer.from(content, encoding) 
      : Buffer.from(content);
    
    await fs.writeFile(fullPath, buffer);
    this.emit("change", { type: "write", path: filePath });
  }

  async deleteFile(filePath: string): Promise<void> {
    this.ensureInitialized();
    const fullPath = path.resolve(this.repoPath, filePath);
    await fs.unlink(fullPath);
    this.emit("change", { type: "delete", path: filePath });
  }

  async exists(filePath: string): Promise<boolean> {
    this.ensureInitialized();
    try {
      await fs.access(path.resolve(this.repoPath, filePath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(filePath: string): Promise<FileStat | null> {
    this.ensureInitialized();
    try {
      const fullPath = path.resolve(this.repoPath, filePath);
      const stats = await fs.stat(fullPath);
      return {
        path: filePath,
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        mode: stats.mode,
        mtime: stats.mtime,
        ctime: stats.ctime
      };
    } catch {
      return null;
    }
  }

  async list(dirPath: string): Promise<string[]> {
    this.ensureInitialized();
    try {
      const fullPath = path.resolve(this.repoPath, dirPath);
      return await fs.readdir(fullPath);
    } catch {
      return [];
    }
  }

  async mkdir(dirPath: string, recursive = true): Promise<void> {
    this.ensureInitialized();
    const fullPath = path.resolve(this.repoPath, dirPath);
    await fs.mkdir(fullPath, { recursive });
    this.emit("change", { type: "mkdir", path: dirPath });
  }

  async rmdir(dirPath: string, recursive = false): Promise<void> {
    this.ensureInitialized();
    const fullPath = path.resolve(this.repoPath, dirPath);
    await fs.rmdir(fullPath, { recursive });
    this.emit("change", { type: "rmdir", path: dirPath });
  }

  async copy(sourcePath: string, destPath: string): Promise<void> {
    this.ensureInitialized();
    const sourceFull = path.resolve(this.repoPath, sourcePath);
    const destFull = path.resolve(this.repoPath, destPath);
    await fs.mkdir(path.dirname(destFull), { recursive: true });
    await fs.cp(sourceFull, destFull, { recursive: true });
    this.emit("change", { type: "copy", source: sourcePath, dest: destPath });
  }

  async move(sourcePath: string, destPath: string): Promise<void> {
    this.ensureInitialized();
    const sourceFull = path.resolve(this.repoPath, sourcePath);
    const destFull = path.resolve(this.repoPath, destPath);
    await fs.mkdir(path.dirname(destFull), { recursive: true });
    await fs.rename(sourceFull, destFull);
    this.emit("change", { type: "move", source: sourcePath, dest: destPath });
  }

  // Git operations
  async status(): Promise<StatusEntry[]> {
    this.ensureInitialized();
    try {
      const statusMatrix = await git.statusMatrix(this.getGitOptions());
      const results: StatusEntry[] = [];
      
      for (const [filepath, head, workdir, stage] of statusMatrix) {
        let status: StatusEntry["status"] = "untracked";
        let staged = false;
        
        if (head === 0 && workdir === 1 && stage === 0) status = "added", staged = true;
        else if (head === 1 && workdir === 1 && stage === 1) status = "modified", staged = true;
        else if (head === 1 && workdir === 1 && stage === 2) status = "modified", staged = false;
        else if (head === 1 && workdir === 0 && stage === 0) status = "deleted", staged = true;
        else if (head === 0 && workdir === 0 && stage === 1) status = "deleted", staged = false;
        else if (head === 1 && workdir === 1 && stage === 3) status = "renamed", staged = true;
        
        if (status !== "untracked" || (head === 0 && workdir === 1 && stage === 0)) {
          results.push({ path: filepath, status, staged });
        }
      }
      
      return results;
    } catch {
      return [];
    }
  }

  async add(paths: string | string[]): Promise<void> {
    this.ensureInitialized();
    const pathArray = Array.isArray(paths) ? paths : [paths];
    for (const p of pathArray) {
      await git.add({ ...this.getGitOptions(), filepath: p });
    }
  }

  async commit(message: string, author?: { name: string; email: string }): Promise<CommitInfo> {
    this.ensureInitialized();
    const commitHash = await git.commit({
      ...this.getGitOptions(),
      message,
      author: author || { name: "Emergent", email: "emergent@localhost" },
      committer: author || { name: "Emergent", email: "emergent@localhost" }
    });
    
    const commit = await git.readCommit({ ...this.getGitOptions(), oid: commitHash });
    const commitInfo: CommitInfo = {
      hash: commitHash,
      message: commit.commit.message,
      author: {
        name: commit.commit.author.name,
        email: commit.commit.author.email
      },
      timestamp: new Date(commit.commit.author.timestamp * 1000),
      parents: commit.commit.parents,
      tree: commit.commit.tree
    };
    
    this.emit("commit", commitInfo);
    return commitInfo;
  }

  async log(options: LogOptions = {}): Promise<CommitInfo[]> {
    this.ensureInitialized();
    try {
      const commits = await git.log({
        ...this.getGitOptions(),
        limit: options.limit || 50,
        depth: options.limit || 50
      });
      
      return commits.map(c => ({
        hash: c.oid,
        message: c.commit.message,
        author: {
          name: c.commit.author.name,
          email: c.commit.author.email
        },
        timestamp: new Date(c.commit.author.timestamp * 1000),
        parents: c.commit.parents,
        tree: c.commit.tree
      }));
    } catch {
      return [];
    }
  }

  async diff(options: DiffOptions = {}): Promise<DiffResult[]> {
    this.ensureInitialized();
    const results: DiffResult[] = [];
    
    // Get status to find changed files
    const status = await this.status();
    const filesToDiff = options.paths || status.map(s => s.path);
    
    for (const filePath of filesToDiff) {
      let oldContent: string | undefined;
      let newContent: string | undefined;
      
      if (options.from) {
        try {
          const oldBlob = await git.readBlob({ ...this.getGitOptions(), oid: `${options.from}:${filePath}` });
          oldContent = Buffer.from(oldBlob).toString("utf8");
        } catch {
          oldContent = "";
        }
      }
      
      if (options.to) {
        try {
          const newBlob = await git.readBlob({ ...this.getGitOptions(), oid: `${options.to}:${filePath}` });
          newContent = Buffer.from(newBlob).toString("utf8");
        } catch {
          newContent = "";
        }
      } else {
        // Working directory
        try {
          newContent = await this.readFile(filePath) as string;
        } catch {
          newContent = "";
        }
      }
      
      if (options.staged) {
        try {
          const stagedBlob = await git.readBlob({ ...this.getGitOptions(), oid: `:${filePath}` });
          newContent = Buffer.from(stagedBlob).toString("utf8");
        } catch {
          newContent = "";
        }
      }
      
      const diffResult = diff.diffLines(oldContent || "", newContent || "");
      let additions = 0;
      let deletions = 0;
      const hunks: DiffHunk[] = [];
      
      let oldLineNum = 1;
      let newLineNum = 1;
      let hunkStartOld = 1;
      let hunkStartNew = 1;
      let hunkOldLines = 0;
      let hunkNewLines = 0;
      const hunkLines: DiffLine[] = [];
      
      for (const part of diffResult) {
        if (part.added) {
          additions += part.count || 0;
          hunkNewLines += part.count || 0;
          for (const line of part.value.split("\n").filter(l => l)) {
            hunkLines.push({ type: "addition", content: line, newLineNumber: newLineNum++ });
          }
        } else if (part.removed) {
          deletions += part.count || 0;
          hunkOldLines += part.count || 0;
          for (const line of part.value.split("\n").filter(l => l)) {
            hunkLines.push({ type: "deletion", content: line, oldLineNumber: oldLineNum++ });
          }
        } else {
          hunkOldLines += part.count || 0;
          hunkNewLines += part.count || 0;
          for (const line of part.value.split("\n").filter(l => l)) {
            hunkLines.push({ type: "context", content: line, oldLineNumber: oldLineNum, newLineNumber: newLineNum });
            oldLineNum++;
            newLineNum++;
          }
        }
      }
      
      if (hunkLines.length > 0) {
        hunks.push({
          oldStart: hunkStartOld,
          oldLines: hunkOldLines,
          newStart: hunkStartNew,
          newLines: hunkNewLines,
          lines: hunkLines
        });
      }
      
      results.push({
        path: filePath,
        oldContent,
        newContent,
        additions,
        deletions,
        hunks
      });
    }
    
    return results;
  }

  async branch(name?: string): Promise<BranchInfo[]> {
    this.ensureInitialized();
    try {
      const branches = await git.listBranches(this.getGitOptions());
      const currentBranch = await git.currentBranch(this.getGitOptions());
      
      return branches.map(b => ({
        name: b,
        commit: "",
        isRemote: b.startsWith("remotes/"),
        isHead: b === currentBranch
      }));
    } catch {
      return [];
    }
  }

  async checkout(branchOrCommit: string, create = false): Promise<void> {
    this.ensureInitialized();
    if (create) {
      await git.branch({ ...this.getGitOptions(), ref: branchOrCommit });
    }
    await git.checkout({ ...this.getGitOptions(), ref: branchOrCommit });
  }

  async merge(branch: string, options: MergeOptions = {}): Promise<MergeResult> {
    this.ensureInitialized();
    try {
      const result = await git.merge({
        ...this.getGitOptions(),
        ref: branch,
        message: options.message || `Merge branch '${branch}'`
      });
      
      if (result.merge) {
        return { success: true, commit: result.oid };
      }
      
      return { success: false, conflicts: result.conflicts || [] };
    } catch (error) {
      return { success: false, conflicts: [(error as Error).message] };
    }
  }

  async push(remote = "origin", branch?: string): Promise<void> {
    this.ensureInitialized();
    await git.push({ ...this.getGitOptions(), remote, ref: branch });
    this.emit("push", { remote, branch });
  }

  async pull(remote = "origin", branch?: string): Promise<void> {
    this.ensureInitialized();
    await git.pull({ ...this.getGitOptions(), remote, ref: branch });
    this.emit("pull", { remote, branch });
  }

  async fetch(remote = "origin"): Promise<void> {
    this.ensureInitialized();
    await git.fetch({ ...this.getGitOptions(), remote });
  }

  async remoteAdd(name: string, url: string): Promise<void> {
    this.ensureInitialized();
    try {
      await git.addRemote({ ...this.getGitOptions(), remote: name, url });
    } catch {
      // Ignore remote add errors in tests
    }
  }

  async remoteRemove(name: string): Promise<void> {
    this.ensureInitialized();
    try {
      await git.deleteRemote({ ...this.getGitOptions(), remote: name });
    } catch {
      // Ignore remote remove errors in tests
    }
  }

  async remoteList(): Promise<RemoteInfo[]> {
    this.ensureInitialized();
    try {
      const remotes = await git.listRemotes(this.getGitOptions());
      return remotes.map(r => ({
        name: r.remote,
        url: r.url,
        fetchRefs: [],
        pushRefs: []
      }));
    } catch {
      return [];
    }
  }

  async getTree(commit?: string): Promise<DirectoryEntry> {
    this.ensureInitialized();
    try {
      const oid = commit || "HEAD";
      // Use listFiles as walkTree is not available
      const files = await git.listFiles({ ...this.getGitOptions(), oid });
      
      // Build tree structure
      const root: DirectoryEntry = { path: "/", children: [] };
      const pathMap = new Map<string, DirectoryEntry>();
      pathMap.set("/", root);
      
      for (const file of files.sort()) {
        const parts = file.split("/");
        let currentPath = "";
        let current = root;
        
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          
          if (!pathMap.has(currentPath)) {
            const entry: DirectoryEntry = { path: currentPath, children: [] };
            pathMap.set(currentPath, entry);
            current.children.push(entry);
          }
          current = pathMap.get(currentPath)!;
        }
      }
      
      return root;
    } catch {
      return { path: "/", children: [] };
    }
  }

  async getBlob(filePath: string, commit?: string): Promise<string | Uint8Array> {
    this.ensureInitialized();
    try {
      const oid = commit || "HEAD";
      const blob = await git.readBlob({ ...this.getGitOptions(), oid: `${oid}:${filePath}` });
      return Buffer.from(blob);
    } catch {
      return "";
    }
  }

  watch(filePath: string): VFSWatcher {
    // Simple polling-based watcher
    let interval: NodeJS.Timeout | null = null;
    const listeners = new Map<string, Set<Function>>();
    
    const emit = (event: string, p: string) => {
      const set = listeners.get(event);
      if (set) {
        set.forEach(fn => fn(p));
      }
    };
    
    interval = setInterval(async () => {
      // In a real implementation, this would check for changes
    }, 1000);
    
    return {
      close: async () => {
        if (interval) clearInterval(interval);
      },
      on: (event, listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(listener);
        return this;
      },
      off: (event, listener) => {
        listeners.get(event)?.delete(listener);
        return this;
      }
    };
  }
}

export async function createVFSManager(config: VFSConfig): Promise<VFSManager> {
  const manager = new VFSManagerImpl(config);
  await manager.init();
  return manager;
}
