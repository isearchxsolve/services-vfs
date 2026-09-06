/**
 * Git Repository Wrapper
 * Provides Git operations using isomorphic-git
 */

import { promises as fs } from "fs";
import { join } from "path";
import * as git from "isomorphic-git";
import type { CommitInfo, GitStatus, GitRemote } from "./types.js";

// Create a proper fs adapter for isomorphic-git
const gitFs = {
  promises: fs,
  readFile: (path: string) => fs.readFile(path, "utf-8"),
  writeFile: (path: string, data: string | Uint8Array) => fs.writeFile(path, data),
  unlink: (path: string) => fs.unlink(path),
  mkdir: (path: string, options?: { recursive?: boolean }) => fs.mkdir(path, options),
  rmdir: (path: string, options?: { recursive?: boolean }) => fs.rmdir(path, options),
  readdir: (path: string) => fs.readdir(path),
  stat: (path: string) => fs.stat(path),
  lstat: (path: string) => fs.lstat(path),
  readlink: (path: string) => fs.readlink(path),
  symlink: (target: string, path: string) => fs.symlink(target, path),
  rename: (oldPath: string, newPath: string) => fs.rename(oldPath, newPath),
  existsSync: (path: string) => {
    try {
      require("fs").existsSync(path);
      return true;
    } catch {
      return false;
    }
  },
};

export class GitRepository {
  private fs: typeof gitFs;

  constructor() {
    this.fs = gitFs;
  }

  /**
   * Initialize a new Git repository
   */
  async initialize(rootPath: string, branch: string = "main"): Promise<void> {
    await fs.mkdir(rootPath, { recursive: true });
    
    const gitDir = join(rootPath, ".git");
    try {
      await fs.access(gitDir);
      // Repo already exists
    } catch {
      // Initialize new repo
      await git.init({ fs: this.fs, dir: rootPath, defaultBranch: branch });
      
      // Create initial commit if empty
      const status = await git.statusMatrix({ fs: this.fs, dir: rootPath });
      if (status.length === 0) {
        // Create a placeholder file for initial commit
        await fs.writeFile(join(rootPath, ".gitkeep"), "");
        await git.add({ fs: this.fs, dir: rootPath, filepath: ".gitkeep" });
        await git.commit({
          fs: this.fs,
          dir: rootPath,
          message: "Initial commit",
          author: { name: "Emergent Bot", email: "bot@emergent.sh" },
        });
      }
    }
  }

  /**
   * Initialize a project subdirectory as a Git repository
   */
  async initializeProject(projectPath: string): Promise<void> {
    await this.initialize(projectPath);
  }

  /**
   * Add a Git remote
   */
  async addRemote(dir: string, name: string, url: string): Promise<void> {
    await git.addRemote({ fs: this.fs, dir, remote: name, url });
  }

  /**
   * Remove a Git remote
   */
  async removeRemote(dir: string, name: string): Promise<void> {
    await git.deleteRemote({ fs: this.fs, dir, remote: name });
  }

  /**
   * Get list of remotes
   */
  async getRemotes(dir: string): Promise<GitRemote[]> {
    const remotes = await git.listRemotes({ fs: this.fs, dir });
    return remotes.map(r => ({
      name: r.remote,
      url: r.url,
    }));
  }

  /**
   * Stage files for commit
   */
  async add(dir: string, files: string | string[]): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    for (const file of fileList) {
      await git.add({ fs: this.fs, dir, filepath: file });
    }
  }

  /**
   * Unstage files
   */
  async reset(dir: string, files: string | string[]): Promise<void> {
    const fileList = Array.isArray(files) ? files : [files];
    for (const file of fileList) {
      await git.resetIndex({ fs: this.fs, dir, filepath: file });
    }
  }

  /**
   * Create a commit
   */
  async commit(
    dir: string,
    message: string,
    author: { name: string; email: string }
  ): Promise<CommitInfo | null> {
    try {
      const hash = await git.commit({
        fs: this.fs,
        dir,
        message,
        author,
      });

      // Get commit details
      const commit = await git.readCommit({ fs: this.fs, dir, oid: hash });
      
      return {
        hash,
        message: commit.commit.message,
        author: {
          name: commit.commit.author.name,
          email: commit.commit.author.email,
        },
        timestamp: new Date(commit.commit.author.timestamp * 1000),
        parents: commit.commit.parent ? [commit.commit.parent] : [],
        treeHash: commit.commit.tree,
      };
    } catch (error) {
      // No changes to commit
      return null;
    }
  }

  /**
   * Push to remote
   */
  async push(dir: string, remote: string = "origin", branch: string = "main"): Promise<void> {
    await git.push({
      fs: this.fs,
      dir,
      remote,
      ref: branch,
    });
  }

  /**
   * Pull from remote
   */
  async pull(dir: string, remote: string = "origin", branch: string = "main"): Promise<void> {
    await git.pull({
      fs: this.fs,
      dir,
      remote,
      ref: branch,
      singleBranch: true,
      fastForwardOnly: true,
    });
  }

  /**
   * Fetch from remote
   */
  async fetch(dir: string, remote: string = "origin"): Promise<void> {
    await git.fetch({
      fs: this.fs,
      dir,
      remote,
    });
  }

  /**
   * Get repository status
   */
  async getStatus(dir: string): Promise<GitStatus> {
    const statusMatrix = await git.statusMatrix({ fs: this.fs, dir });
    
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const [filepath, head, workdir, stage] of statusMatrix) {
      if (head !== stage) {
        staged.push(filepath);
      }
      if (stage !== workdir) {
        if (workdir === 0) {
          // Deleted in workdir
          unstaged.push(filepath);
        } else if (stage === 0) {
          // New file
          untracked.push(filepath);
        } else {
          unstaged.push(filepath);
        }
      }
    }

    // Get current branch
    let currentBranch = "main";
    try {
      currentBranch = await git.currentBranch({ fs: this.fs, dir });
    } catch {
      // Default to main
    }

    // Get ahead/behind counts
    let ahead = 0;
    let behind = 0;

    return {
      currentBranch,
      isClean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
    };
  }

  /**
   * Get commit history
   */
  async getHistory(dir: string, limit: number = 50): Promise<CommitInfo[]> {
    const commits: CommitInfo[] = [];
    
    try {
      const iter = git.log({ fs: this.fs, dir });
      for await (const commit of iter) {
        if (commits.length >= limit) break;
        
        commits.push({
          hash: commit.oid,
          message: commit.commit.message,
          author: {
            name: commit.commit.author.name,
            email: commit.commit.author.email,
          },
          timestamp: new Date(commit.commit.author.timestamp * 1000),
          parents: commit.commit.parent ? [commit.commit.parent] : [],
          treeHash: commit.commit.tree,
        });
      }
    } catch {
      // No commits or error
    }

    return commits;
  }

  /**
   * Get diff for a file
   */
  async getDiff(dir: string, filepath: string): Promise<string> {
    try {
      const diff = await git.diff({ fs: this.fs, dir, filepath });
      return diff;
    } catch {
      return "";
    }
  }

  /**
   * Checkout a branch or commit
   */
  async checkout(dir: string, ref: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir, ref });
  }

  /**
   * Create a new branch
   */
  async createBranch(dir: string, name: string, startPoint?: string): Promise<void> {
    await git.branch({ fs: this.fs, dir, ref: name, checkout: false, startpoint: startPoint });
  }

  /**
   * Delete a branch
   */
  async deleteBranch(dir: string, name: string): Promise<void> {
    await git.deleteBranch({ fs: this.fs, dir, ref: name });
  }

  /**
   * List branches
   */
  async listBranches(dir: string): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir });
  }

  /**
   * Merge a branch
   */
  async merge(dir: string, branch: string): Promise<void> {
    await git.merge({ fs: this.fs, dir, ref: branch });
  }

  /**
   * Check if repository is clean
   */
  async isClean(dir: string): Promise<boolean> {
    const status = await this.getStatus(dir);
    return status.isClean;
  }
}
