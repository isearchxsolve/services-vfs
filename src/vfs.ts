/**
 * Virtual File System (VFS) Service
 * In-memory file system with Git synchronization capabilities
 */

import { promises as fs } from "fs";
import { join, relative, dirname, basename, resolve } from "path";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import { GitRepository } from "./git-repository.js";
import {
  VFSNode,
  FileContent,
  VFSOperation,
  CommitInfo,
  GitStatus,
  GitRemote,
  VFSConfig,
  VFSSession,
  VFSEvents,
} from "./types.js";

const DEFAULT_CONFIG: VFSConfig = {
  rootPath: "/tmp/emergent-vfs",
  gitEnabled: true,
  gitBranch: "main",
  autoCommit: true,
  autoPush: false,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  allowedExtensions: [
    ".js", ".ts", ".jsx", ".tsx", ".json", ".html", ".css", ".scss",
    ".md", ".txt", ".yaml", ".yml", ".toml", ".env", ".gitignore",
    ".dockerignore", ".py", ".rs", ".go", ".java", ".cpp", ".c", ".h",
    ".sh", ".sql", ".prisma", ".graphql", ".proto",
  ],
};

export class VirtualFileSystem extends EventEmitter<{
  [K in keyof VFSEvents]: (payload: VFSEvents[K]) => void;
}> {
  private config: VFSConfig;
  private sessions: Map<string, VFSSession> = new Map();
  private gitRepo: GitRepository | null = null;
  private initialized = false;

  constructor(config?: Partial<VFSConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the VFS and Git repository
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create root directory
    await fs.mkdir(this.config.rootPath, { recursive: true });

    // Initialize Git if enabled
    if (this.config.gitEnabled) {
      this.gitRepo = new GitRepository(this.config.rootPath);
      await this.gitRepo.initialize(this.config.gitBranch);
      
      // Set up remote if provided
      if (this.config.gitRemoteUrl) {
        await this.gitRepo.addRemote("origin", this.config.gitRemoteUrl);
      }
    }

    this.initialized = true;
  }

  /**
   * Create a new VFS session
   */
  async createSession(userId: string, projectId: string): Promise<VFSSession> {
    await this.initialize();

    const sessionId = uuidv4();
    const rootNode: VFSNode = {
      id: uuidv4(),
      name: projectId,
      path: "/",
      type: "directory",
      size: 0,
      children: new Map(),
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    };

    const session: VFSSession = {
      id: sessionId,
      userId,
      projectId,
      rootNode,
      operations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.sessions.set(sessionId, session);

    // Create project directory on disk
    const projectPath = join(this.config.rootPath, projectId);
    await fs.mkdir(projectPath, { recursive: true });

    // Initialize git repo for project if needed
    if (this.config.gitEnabled && this.gitRepo) {
      await this.gitRepo.initializeProject(projectId);
    }

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): VFSSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions for a user
   */
  getUserSessions(userId: string): VFSSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId);
  }

  /**
   * Create a file or directory
   */
  async create(
    sessionId: string,
    path: string,
    content: string | Uint8Array = "",
    type: "file" | "directory" = "file"
  ): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Normalize path
    const normalizedPath = this.normalizePath(path);
    const parentPath = dirname(normalizedPath);
    const name = basename(normalizedPath);

    // Validate extension for files
    if (type === "file" && !this.isAllowedExtension(name)) {
      throw new Error(`File extension not allowed: ${name}`);
    }

    // Check file size
    const contentStr = typeof content === "string" ? content : new TextDecoder().decode(content);
    if (contentStr.length > this.config.maxFileSize) {
      throw new Error(`File size exceeds limit: ${this.config.maxFileSize} bytes`);
    }

    // Get or create parent directory
    let parentNode = await this.getNode(session.rootNode, parentPath);
    if (!parentNode || parentNode.type !== "directory") {
      // Create parent directories recursively
      parentNode = await this.ensureDirectory(session.rootNode, parentPath);
    }

    // Check if already exists
    if (parentNode.children?.has(name)) {
      throw new Error(`File already exists: ${normalizedPath}`);
    }

    const now = new Date();
    const node: VFSNode = {
      id: uuidv4(),
      name,
      path: normalizedPath,
      type,
      size: contentStr.length,
      mimeType: type === "file" ? this.getMimeType(name) : undefined,
      content: type === "file" ? contentStr : undefined,
      children: type === "directory" ? new Map() : undefined,
      parent: parentNode,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    // Add to parent
    parentNode.children!.set(name, node);
    parentNode.updatedAt = now;

    // Write to disk
    const diskPath = this.getDiskPath(session.projectId, normalizedPath);
    if (type === "file") {
      await fs.mkdir(dirname(diskPath), { recursive: true });
      await fs.writeFile(diskPath, content);
    } else {
      await fs.mkdir(diskPath, { recursive: true });
    }

    // Record operation
    this.recordOperation(sessionId, {
      type: "create",
      path: normalizedPath,
      content: type === "file" ? contentStr : undefined,
      sessionId,
      userId: session.userId,
    });

    // Emit event
    if (type === "file") {
      this.emit("file:created", { node, sessionId });
    } else {
      this.emit("directory:created", { node, sessionId });
    }

    // Auto-commit if enabled
    if (this.config.autoCommit && this.gitRepo) {
      await this.commit(sessionId, `Create ${type}: ${normalizedPath}`);
    }

    session.updatedAt = new Date();
    return node;
  }

  /**
   * Read a file
   */
  async read(sessionId: string, path: string): Promise<FileContent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const node = await this.getNode(session.rootNode, normalizedPath);
    
    if (!node) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    if (node.type !== "file") {
      throw new Error(`Not a file: ${normalizedPath}`);
    }

    // Read from disk for freshness
    const diskPath = this.getDiskPath(session.projectId, normalizedPath);
    const content = await fs.readFile(diskPath, "utf-8");
    
    // Update in-memory node
    node.content = content;
    node.size = content.length;
    node.updatedAt = new Date();

    return {
      path: normalizedPath,
      content,
      encoding: "utf-8",
      mimeType: node.mimeType,
    };
  }

  /**
   * Update a file
   */
  async update(sessionId: string, path: string, content: string | Uint8Array): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const node = await this.getNode(session.rootNode, normalizedPath);
    
    if (!node) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    if (node.type !== "file") {
      throw new Error(`Not a file: ${normalizedPath}`);
    }

    const contentStr = typeof content === "string" ? content : new TextDecoder().decode(content);
    if (contentStr.length > this.config.maxFileSize) {
      throw new Error(`File size exceeds limit: ${this.config.maxFileSize} bytes`);
    }

    const oldContent = node.content;
    const now = new Date();

    // Update in-memory
    node.content = contentStr;
    node.size = contentStr.length;
    node.updatedAt = now;

    // Write to disk
    const diskPath = this.getDiskPath(session.projectId, normalizedPath);
    await fs.writeFile(diskPath, contentStr);

    // Record operation
    this.recordOperation(sessionId, {
      type: "update",
      path: normalizedPath,
      content: contentStr,
      sessionId,
      userId: session.userId,
    });

    // Emit event
    this.emit("file:updated", { node, sessionId, oldContent });

    // Auto-commit if enabled
    if (this.config.autoCommit && this.gitRepo) {
      await this.commit(sessionId, `Update file: ${normalizedPath}`);
    }

    session.updatedAt = new Date();
    return node;
  }

  /**
   * Delete a file or directory
   */
  async delete(sessionId: string, path: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const parentPath = dirname(normalizedPath);
    const name = basename(normalizedPath);

    const parentNode = await this.getNode(session.rootNode, parentPath);
    if (!parentNode || parentNode.type !== "directory") {
      throw new Error(`Parent directory not found: ${parentPath}`);
    }

    const node = parentNode.children?.get(name);
    if (!node) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    // Remove from parent
    parentNode.children!.delete(name);
    parentNode.updatedAt = new Date();

    // Remove from disk
    const diskPath = this.getDiskPath(session.projectId, normalizedPath);
    if (node.type === "file") {
      await fs.unlink(diskPath);
      this.emit("file:deleted", { path: normalizedPath, sessionId });
    } else {
      await fs.rm(diskPath, { recursive: true, force: true });
      this.emit("directory:deleted", { path: normalizedPath, sessionId });
    }

    // Record operation
    this.recordOperation(sessionId, {
      type: "delete",
      path: normalizedPath,
      sessionId,
      userId: session.userId,
    });

    // Auto-commit if enabled
    if (this.config.autoCommit && this.gitRepo) {
      await this.commit(sessionId, `Delete ${node.type}: ${normalizedPath}`);
    }

    session.updatedAt = new Date();
  }

  /**
   * Move/rename a file or directory
   */
  async move(sessionId: string, oldPath: string, newPath: string): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedOldPath = this.normalizePath(oldPath);
    const normalizedNewPath = this.normalizePath(newPath);
    
    const oldParentPath = dirname(normalizedOldPath);
    const newParentPath = dirname(normalizedNewPath);
    const newName = basename(normalizedNewPath);

    const oldParentNode = await this.getNode(session.rootNode, oldParentPath);
    const newParentNode = await this.getNode(session.rootNode, newParentPath);
    
    if (!oldParentNode || oldParentNode.type !== "directory") {
      throw new Error(`Source parent directory not found: ${oldParentPath}`);
    }
    if (!newParentNode || newParentNode.type !== "directory") {
      throw new Error(`Target parent directory not found: ${newParentPath}`);
    }

    const node = oldParentNode.children?.get(basename(normalizedOldPath));
    if (!node) {
      throw new Error(`File not found: ${normalizedOldPath}`);
    }

    if (newParentNode.children?.has(newName)) {
      throw new Error(`Target already exists: ${normalizedNewPath}`);
    }

    // Update in-memory
    oldParentNode.children!.delete(basename(normalizedOldPath));
    node.name = newName;
    node.path = normalizedNewPath;
    node.parent = newParentNode;
    node.updatedAt = new Date();
    newParentNode.children!.set(newName, node);
    newParentNode.updatedAt = new Date();

    // Move on disk
    const oldDiskPath = this.getDiskPath(session.projectId, normalizedOldPath);
    const newDiskPath = this.getDiskPath(session.projectId, normalizedNewPath);
    await fs.mkdir(dirname(newDiskPath), { recursive: true });
    await fs.rename(oldDiskPath, newDiskPath);

    // Record operation
    this.recordOperation(sessionId, {
      type: "move",
      path: normalizedOldPath,
      targetPath: normalizedNewPath,
      sessionId,
      userId: session.userId,
    });

    // Emit event
    this.emit("file:moved", { oldPath: normalizedOldPath, newPath: normalizedNewPath, sessionId });

    // Auto-commit if enabled
    if (this.config.autoCommit && this.gitRepo) {
      await this.commit(sessionId, `Move ${node.type}: ${normalizedOldPath} -> ${normalizedNewPath}`);
    }

    session.updatedAt = new Date();
    return node;
  }

  /**
   * Copy a file or directory
   */
  async copy(sessionId: string, srcPath: string, destPath: string): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedSrcPath = this.normalizePath(srcPath);
    const normalizedDestPath = this.normalizePath(destPath);
    
    const srcNode = await this.getNode(session.rootNode, normalizedSrcPath);
    if (!srcNode) {
      throw new Error(`Source not found: ${normalizedSrcPath}`);
    }

    // For files, read content and create new file
    if (srcNode.type === "file") {
      const content = await this.read(sessionId, normalizedSrcPath);
      return this.create(sessionId, normalizedDestPath, content.content);
    }

    // For directories, create directory and recursively copy children
    const newDir = await this.create(sessionId, normalizedDestPath, "", "directory");
    
    if (srcNode.children) {
      for (const [name, childNode] of srcNode.children) {
        const childSrcPath = join(normalizedSrcPath, name);
        const childDestPath = join(normalizedDestPath, name);
        await this.copy(sessionId, childSrcPath, childDestPath);
      }
    }

    return newDir;
  }

  /**
   * List directory contents
   */
  async list(sessionId: string, path: string = "/"): Promise<VFSNode[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const node = await this.getNode(session.rootNode, normalizedPath);
    
    if (!node || node.type !== "directory") {
      throw new Error(`Directory not found: ${normalizedPath}`);
    }

    if (!node.children) {
      return [];
    }

    return Array.from(node.children.values());
  }

  /**
   * Get file/directory metadata
   */
  async stat(sessionId: string, path: string): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const node = await this.getNode(session.rootNode, normalizedPath);
    
    if (!node) {
      throw new Error(`Not found: ${normalizedPath}`);
    }

    return node;
  }

  /**
   * Search files by pattern
   */
  async search(sessionId: string, pattern: string): Promise<VFSNode[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const regex = new RegExp(pattern);
    const results: VFSNode[] = [];

    const searchNode = (node: VFSNode) => {
      if (regex.test(node.name) || regex.test(node.path)) {
        results.push(node);
      }
      if (node.children) {
        for (const child of node.children.values()) {
          searchNode(child);
        }
      }
    };

    searchNode(session.rootNode);
    return results;
  }

  /**
   * Get file tree as nested structure
   */
  async getTree(sessionId: string, path: string = "/"): Promise<VFSNode> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const normalizedPath = this.normalizePath(path);
    const node = await this.getNode(session.rootNode, normalizedPath);
    
    if (!node) {
      throw new Error(`Not found: ${normalizedPath}`);
    }

    return this.cloneNode(node);
  }

  /**
   * Commit changes to Git
   */
  async commit(sessionId: string, message: string): Promise<CommitInfo | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      return null;
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    const commit = await this.gitRepo.commit(projectPath, message, {
      name: "Emergent Bot",
      email: "bot@emergent.sh",
    });

    if (commit) {
      this.emit("git:committed", { commit, sessionId });
    }

    return commit;
  }

  /**
   * Push to remote
   */
  async push(sessionId: string, remote: string = "origin", branch?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      throw new Error("Git not enabled or session not found");
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    await this.gitRepo.push(projectPath, remote, branch || this.config.gitBranch!);
    this.emit("git:pushed", { remote, ref: branch || this.config.gitBranch!, sessionId });
  }

  /**
   * Pull from remote
   */
  async pull(sessionId: string, remote: string = "origin", branch?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      throw new Error("Git not enabled or session not found");
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    await this.gitRepo.pull(projectPath, remote, branch || this.config.gitBranch!);
    this.emit("git:pulled", { remote, ref: branch || this.config.gitBranch!, sessionId });
    
    // Reload VFS from disk after pull
    await this.reloadSession(sessionId);
  }

  /**
   * Get Git status
   */
  async getGitStatus(sessionId: string): Promise<GitStatus | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      return null;
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    return this.gitRepo.getStatus(projectPath);
  }

  /**
   * Get commit history
   */
  async getCommitHistory(sessionId: string, limit: number = 50): Promise<CommitInfo[]> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      return [];
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    return this.gitRepo.getHistory(projectPath, limit);
  }

  /**
   * Sync with remote (pull then push)
   */
  async sync(sessionId: string): Promise<{ pulled: boolean; pushed: boolean; changes: number }> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.gitRepo || !this.config.gitEnabled) {
      throw new Error("Git not enabled or session not found");
    }

    this.emit("sync:started", { sessionId });

    const projectPath = join(this.config.rootPath, session.projectId);
    let changes = 0;

    try {
      await this.gitRepo.pull(projectPath, "origin", this.config.gitBranch!);
      changes++;
      this.emit("git:pulled", { remote: "origin", ref: this.config.gitBranch!, sessionId });
    } catch {
      // Pull failed, maybe no remote or no changes
    }

    const status = await this.gitRepo.getStatus(projectPath);
    if (!status.isClean) {
      await this.gitRepo.commit(projectPath, "Auto-sync commit", {
        name: "Emergent Bot",
        email: "bot@emergent.sh",
      });
      await this.gitRepo.push(projectPath, "origin", this.config.gitBranch!);
      changes++;
      this.emit("git:pushed", { remote: "origin", ref: this.config.gitBranch!, sessionId });
    }

    await this.reloadSession(sessionId);
    this.emit("sync:completed", { sessionId, changes });

    return { pulled: true, pushed: true, changes };
  }

  /**
   * Export session as archive
   */
  async exportSession(sessionId: string): Promise<Uint8Array> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const projectPath = join(this.config.rootPath, session.projectId);
    // In a real implementation, this would create a tar.gz or zip
    // For now, return a simple JSON representation
    const tree = await this.getTree(sessionId);
    return new TextEncoder().encode(JSON.stringify({
      session: {
        id: session.id,
        userId: session.userId,
        projectId: session.projectId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      tree,
    }, null, 2));
  }

  // Private helper methods

  private normalizePath(path: string): string {
    // Ensure path starts with /
    let normalized = path.startsWith("/") ? path : `/${path}`;
    // Remove trailing slash except for root
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }

  private getDiskPath(projectId: string, vfsPath: string): string {
    const relativePath = vfsPath.startsWith("/") ? vfsPath.slice(1) : vfsPath;
    return join(this.config.rootPath, projectId, relativePath);
  }

  private async getNode(root: VFSNode, path: string): Promise<VFSNode | null> {
    if (path === "/") return root;

    const parts = path.split("/").filter(Boolean);
    let current = root;

    for (const part of parts) {
      if (!current.children || !current.children.has(part)) {
        return null;
      }
      current = current.children.get(part)!;
    }

    return current;
  }

  private async ensureDirectory(root: VFSNode, path: string): Promise<VFSNode> {
    if (path === "/") return root;

    const parts = path.split("/").filter(Boolean);
    let current = root;

    for (const part of parts) {
      if (!current.children) {
        current.children = new Map();
      }
      
      if (!current.children.has(part)) {
        const now = new Date();
        const newDir: VFSNode = {
          id: uuidv4(),
          name: part,
          path: join(current.path === "/" ? "/" : current.path, part),
          type: "directory",
          size: 0,
          children: new Map(),
          parent: current,
          createdAt: now,
          updatedAt: now,
          metadata: {},
        };
        current.children.set(part, newDir);
        current = newDir;
      } else {
        current = current.children.get(part)!;
      }
    }

    return current;
  }

  private isAllowedExtension(filename: string): boolean {
    if (this.config.allowedExtensions.length === 0) return true;
    return this.config.allowedExtensions.some(ext => filename.endsWith(ext));
  }

  private getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      js: "application/javascript",
      ts: "application/typescript",
      jsx: "application/javascript",
      tsx: "application/typescript",
      json: "application/json",
      html: "text/html",
      css: "text/css",
      scss: "text/scss",
      md: "text/markdown",
      txt: "text/plain",
      yaml: "application/yaml",
      yml: "application/yaml",
      toml: "application/toml",
      py: "text/x-python",
      rs: "text/x-rust",
      go: "text/x-go",
      java: "text/x-java",
      cpp: "text/x-c++",
      c: "text/x-c",
      h: "text/x-c",
      sh: "application/x-sh",
      sql: "application/sql",
      prisma: "text/x-prisma",
      graphql: "application/graphql",
      proto: "application/x-protobuf",
    };
    return mimeTypes[ext || ""] || "application/octet-stream";
  }

  private recordOperation(sessionId: string, op: Omit<VFSOperation, "id" | "timestamp">): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.operations.push({
      ...op,
      id: uuidv4(),
      timestamp: new Date(),
    });

    // Keep only last 1000 operations
    if (session.operations.length > 1000) {
      session.operations = session.operations.slice(-1000);
    }
  }

  private cloneNode(node: VFSNode): VFSNode {
    const cloned: VFSNode = {
      ...node,
      children: node.children ? new Map() : undefined,
    };
    if (node.children) {
      for (const [name, child] of node.children) {
        cloned.children!.set(name, this.cloneNode(child));
      }
    }
    return cloned;
  }

  private async reloadSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const projectPath = join(this.config.rootPath, session.projectId);
    session.rootNode = await this.loadDirectoryTree(projectPath, session.projectId);
    session.updatedAt = new Date();
  }

  private async loadDirectoryTree(dirPath: string, projectId: string, parentPath: string = "/"): Promise<VFSNode> {
    const stats = await fs.stat(dirPath);
    const name = parentPath === "/" ? projectId : basename(dirPath);
    const vfsPath = parentPath === "/" ? "/" : join(parentPath, basename(dirPath));

    const node: VFSNode = {
      id: uuidv4(),
      name,
      path: vfsPath,
      type: "directory",
      size: stats.size,
      children: new Map(),
      createdAt: stats.birthtime,
      updatedAt: stats.mtime,
      metadata: {},
    };

    if (stats.isDirectory()) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
        
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const child = await this.loadDirectoryTree(entryPath, projectId, vfsPath);
          node.children!.set(entry.name, child);
        } else {
          const entryStats = await fs.stat(entryPath);
          const content = await fs.readFile(entryPath, "utf-8");
          const child: VFSNode = {
            id: uuidv4(),
            name: entry.name,
            path: join(vfsPath, entry.name),
            type: "file",
            size: entryStats.size,
            mimeType: this.getMimeType(entry.name),
            content,
            createdAt: entryStats.birthtime,
            updatedAt: entryStats.mtime,
            metadata: {},
          };
          node.children!.set(entry.name, child);
        }
      }
    }

    return node;
  }
}

export function createVFS(config?: Partial<VFSConfig>): VirtualFileSystem {
  return new VirtualFileSystem(config);
}
