export interface VFSConfig {
  repoPath: string;
  bare?: boolean;
  defaultBranch?: string;
}

export interface FileEntry {
  path: string;
  content: string | Uint8Array;
  encoding?: 'utf8' | 'base64';
  mode?: number;
  isBinary?: boolean;
}

export interface DirectoryEntry {
  path: string;
  children: (FileEntry | DirectoryEntry)[];
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  timestamp: Date;
  parents: string[];
  tree: string;
}

export interface BranchInfo {
  name: string;
  commit: string;
  isRemote: boolean;
  isHead: boolean;
}

export interface StatusEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

export interface DiffResult {
  path: string;
  oldContent?: string;
  newContent?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'addition' | 'deletion';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface VFSWatcher {
  close(): Promise<void>;
  on(event: 'change' | 'add' | 'unlink', listener: (path: string) => void): this;
  off(event: 'change' | 'add' | 'unlink', listener: (path: string) => void): this;
}

export interface VFSManager {
  // File operations
  readFile(path: string, encoding?: 'utf8' | 'base64'): Promise<string | Uint8Array>;
  writeFile(path: string, content: string | Uint8Array, encoding?: 'utf8' | 'base64'): Promise<void>;
  deleteFile(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;
  list(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rmdir(path: string, recursive?: boolean): Promise<void>;
  copy(sourcePath: string, destPath: string): Promise<void>;
  move(sourcePath: string, destPath: string): Promise<void>;

  // Git operations
  init(): Promise<void>;
  status(): Promise<StatusEntry[]>;
  add(paths: string | string[]): Promise<void>;
  commit(message: string, author?: { name: string; email: string }): Promise<CommitInfo>;
  log(options?: LogOptions): Promise<CommitInfo[]>;
  diff(options?: DiffOptions): Promise<DiffResult[]>;
  branch(name?: string): Promise<BranchInfo[]>;
  checkout(branchOrCommit: string, create?: boolean): Promise<void>;
  merge(branch: string, options?: MergeOptions): Promise<MergeResult>;
  push(remote?: string, branch?: string): Promise<void>;
  pull(remote?: string, branch?: string): Promise<void>;
  fetch(remote?: string): Promise<void>;
  remoteAdd(name: string, url: string): Promise<void>;
  remoteRemove(name: string): Promise<void>;
  remoteList(): Promise<RemoteInfo[]>;

  // Tree operations
  getTree(commit?: string): Promise<DirectoryEntry>;
  getBlob(path: string, commit?: string): Promise<string | Uint8Array>;

  // Watch
  watch(path: string): VFSWatcher;

  // Events
  on(event: 'change' | 'commit' | 'push' | 'pull', listener: (data: any) => void): this;
  off(event: 'change' | 'commit' | 'push' | 'pull', listener: (data: any) => void): this;
}

export interface FileStat {
  path: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  mtime: Date;
  ctime: Date;
}

export interface LogOptions {
  limit?: number;
  offset?: number;
  since?: Date;
  until?: Date;
  author?: string;
  path?: string;
}

export interface DiffOptions {
  from?: string;
  to?: string;
  paths?: string[];
  staged?: boolean;
}

export interface MergeOptions {
  strategy?: 'ours' | 'theirs' | 'recursive';
  message?: string;
  noCommit?: boolean;
}

export interface MergeResult {
  success: boolean;
  commit?: string;
  conflicts?: string[];
}

export interface RemoteInfo {
  name: string;
  url: string;
  fetchRefs: string[];
  pushRefs: string[];
}

export function createVFSManager(config: VFSConfig): Promise<VFSManager>;
