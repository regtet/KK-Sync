import { EventEmitter } from 'node:events';
import path from 'node:path';
import { existsSync } from 'node:fs';
import simpleGit from 'simple-git';

class GitService extends EventEmitter {
    constructor() {
        super();
        this.repoPath = null;
        this.repoPath2 = null;
        this.git = null;
        this.git2 = null;
        this.syncState = {
            1: { isSyncing: false, cancelRequested: false },
            2: { isSyncing: false, cancelRequested: false }
        };
    }

    async setRepository(repoPath) {
        if (!repoPath) {
            throw new Error('未提供仓库路径');
        }

        const gitDir = path.join(repoPath, '.git');
        if (!existsSync(gitDir)) {
            throw new Error('选择的目录不是一个 Git 仓库');
        }

        this.repoPath = repoPath;
        this.git = simpleGit({ baseDir: repoPath });
        return this.getRepositoryInfo(1);
    }

    async setRepository2(repoPath) {
        if (!repoPath) {
            this.repoPath2 = null;
            this.git2 = null;
            return null;
        }
        const gitDir = path.join(repoPath, '.git');
        if (!existsSync(gitDir)) {
            throw new Error('选择的目录不是一个 Git 仓库');
        }
        this.repoPath2 = repoPath;
        this.git2 = simpleGit({ baseDir: repoPath });
        return this.getRepositoryInfo(2);
    }

    getGitByRepoIndex(repoIndex = 1) {
        const git = repoIndex === 2 ? this.git2 : this.git;
        if (!git) throw new Error(`请先选择仓库${repoIndex}`);
        return git;
    }

    getRepoPathByRepoIndex(repoIndex = 1) {
        return repoIndex === 2 ? this.repoPath2 : this.repoPath;
    }

    hasRepository(repoIndex = 1) {
        return !!(repoIndex === 2 ? this.git2 : this.git);
    }

    async getRepositoryInfo(repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const status = await git.status();
        return {
            path: this.getRepoPathByRepoIndex(repoIndex),
            currentBranch: status.current,
            isClean: status.isClean(),
            ahead: status.ahead,
            behind: status.behind
        };
    }

    async getRemotes(repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const remotes = await git.getRemotes(true);
        return remotes
            .filter((remote) => remote.name)
            .map((remote) => ({
                name: remote.name,
                url: remote.refs?.fetch || remote.refs?.push || ''
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    normalizeRemoteBranchName(refName) {
        if (!refName?.startsWith('remotes/')) return null;
        const normalized = refName.replace(/^remotes\/[^/]+\//, '').trim();
        if (!normalized || normalized === 'HEAD' || normalized.includes('->')) {
            return null;
        }
        return normalized;
    }

    matchesRemoteRef(refName, remoteName) {
        if (!refName?.startsWith('remotes/')) return false;
        if (!remoteName) return true;
        return refName.startsWith(`remotes/${remoteName}/`);
    }

    extractFailedRemoteNames(error) {
        const message = error?.message ?? String(error);
        const names = new Set();
        const refRegex = /refs\/remotes\/([^/\s]+)\//g;
        let match = refRegex.exec(message);
        while (match) {
            names.add(match[1]);
            match = refRegex.exec(message);
        }
        return Array.from(names);
    }

    async deleteRemoteRef(git, ref) {
        try {
            await git.raw(['update-ref', '-d', ref]);
            return true;
        } catch {
            return false;
        }
    }

    async clearRemoteTrackingRefs(git, remoteName = null) {
        const branchSummary = await git.branch(['-a']);
        const refsToDelete = branchSummary.all
            .filter((name) => name.startsWith('remotes/'))
            .filter((name) => !name.endsWith('/HEAD'))
            .filter((name) => !remoteName || name.startsWith(`remotes/${remoteName}/`))
            .map((name) => `refs/${name}`);

        for (const ref of refsToDelete) {
            await this.deleteRemoteRef(git, ref);
        }

        return refsToDelete.length;
    }

    async fetchAll(git) {
        await git.fetch(['--all', '--prune', '--force']);
    }

    async safeFetch(git) {
        const remotes = await git.getRemotes();
        if (remotes.length === 0) {
            return { warnings: ['未配置任何远程仓库'] };
        }

        try {
            await this.fetchAll(git);
            return { warnings: [] };
        } catch (firstError) {
            const failedRemotes = this.extractFailedRemoteNames(firstError);
            const targets = failedRemotes.length
                ? failedRemotes
                : remotes.map((remote) => remote.name);

            let clearedCount = 0;
            for (const remoteName of targets) {
                clearedCount += await this.clearRemoteTrackingRefs(git, remoteName);
            }

            try {
                await this.fetchAll(git);
                return {
                    warnings: [
                        `检测到远程跟踪分支损坏，已清理 ${clearedCount} 条引用并重新 fetch --all`
                    ]
                };
            } catch (retryError) {
                for (const remoteName of targets) {
                    await this.clearRemoteTrackingRefs(git, remoteName);
                    try {
                        await git.fetch(remoteName, [`+refs/heads/*:refs/remotes/${remoteName}/*`, '--prune']);
                    } catch {
                        // ignore per-remote force failure
                    }
                }

                try {
                    await this.fetchAll(git);
                    return {
                        warnings: [
                            `远程跟踪分支损坏，已清空 ${clearedCount} 条引用并强制重新拉取`
                        ]
                    };
                } catch (finalError) {
                    const reason = finalError?.message ?? String(finalError);
                    return {
                        warnings: [`fetch --all 失败，将使用本地缓存分支（${reason}）`]
                    };
                }
            }
        }
    }

    async getBranches(repoIndex = 1, remoteName = null) {
        const git = this.getGitByRepoIndex(repoIndex);
        const { warnings } = await this.safeFetch(git);
        const branchSummary = await git.branch(['-a']);
        const current = branchSummary.current;

        const remoteBranches = branchSummary.all
            .filter((name) => this.matchesRemoteRef(name, remoteName))
            .map((name) => this.normalizeRemoteBranchName(name))
            .filter(Boolean);

        const unique = Array.from(new Set(remoteBranches)).sort();
        return { branches: unique, current, fetchWarnings: warnings };
    }

    /**
     * 检查指定的分支名是否在远程仓库中存在
     * @param {string[]} branchNames - 要检查的分支名数组
     * @returns {Promise<{exists: string[], notExists: string[]}>} 返回存在和不存在的分支列表
     */
    async checkRemoteBranches(branchNames, repoIndex = 1, remoteName = null) {
        const git = this.getGitByRepoIndex(repoIndex);
        if (!Array.isArray(branchNames) || branchNames.length === 0) {
            return { exists: [], notExists: [] };
        }

        await this.safeFetch(git);
        const branchSummary = await git.branch(['-a']);

        const remoteBranchSet = new Set();
        const remoteBranchMap = new Map();
        branchSummary.all
            .filter((name) => this.matchesRemoteRef(name, remoteName))
            .forEach((name) => {
                const normalized = this.normalizeRemoteBranchName(name);
                if (!normalized) return;
                remoteBranchSet.add(normalized);
                const lower = normalized.toLowerCase();
                if (!remoteBranchMap.has(lower)) {
                    remoteBranchMap.set(lower, normalized);
                }
            });

        // 分类分支名
        const exists = [];
        const notExists = [];

        branchNames.forEach((branchName) => {
            const trimmed = branchName.trim();
            if (!trimmed) return;

            // 先尝试大小写完全匹配
            if (remoteBranchSet.has(trimmed)) {
                exists.push(trimmed);
                return;
            }

            // 再尝试忽略大小写匹配
            const lower = trimmed.toLowerCase();
            const realName = remoteBranchMap.get(lower);
            if (realName) {
                exists.push(realName);
            } else {
                notExists.push(trimmed);
            }
        });

        return { exists, notExists };
    }

    /**
     * 检查单个远程分支是否存在
     * @param {string} branchName - 要检查的分支名
     * @returns {Promise<boolean>} 分支是否存在
     */
    async checkRemoteBranchExists(branchName, repoIndex = 1, remoteName = null) {
        if (!branchName || !branchName.trim()) {
            return false;
        }
        const result = await this.checkRemoteBranches([branchName.trim()], repoIndex, remoteName);
        return result.exists.length > 0;
    }

    /**
     * 查找远程分支的完整引用路径（如 remotes/origin/main）
     * @param {string} branchName - 分支名
     * @returns {Promise<string|null>} 远程分支的完整引用路径，如果不存在返回 null
     */
    async findRemoteBranchRef(branchName, repoIndex = 1, remoteName = null, skipFetch = false) {
        const git = this.getGitByRepoIndex(repoIndex);
        if (!branchName || !branchName.trim()) {
            return null;
        }

        if (!skipFetch) {
            await this.safeFetch(git);
        }
        const branchSummary = await git.branch(['-a']);

        const trimmed = branchName.trim();
        for (const name of branchSummary.all) {
            if (!this.matchesRemoteRef(name, remoteName)) continue;
            const normalized = this.normalizeRemoteBranchName(name);
            if (normalized === trimmed) {
                return name;
            }
        }
        return null;
    }

    async getStashList(repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const list = await git.stashList();
        return list.all.map((item, idx) => {
            const stashRef = item.stash ?? `stash@{${typeof item.index === 'number' ? item.index : idx}}`;
            const rawMessage = item.message ?? '';
            const message = this.extractStashMessage(rawMessage);
            return {
                index: typeof item.index === 'number' ? item.index : idx,
                hash: item.hash,
                message,
                rawMessage,
                reference: stashRef
            };
        });
    }

    extractStashMessage(rawMessage = '') {
        const trimmed = rawMessage.trim();
        if (!trimmed) return '';

        const standardPrefixes = ['WIP on', 'On', 'No local changes to save'];
        const hasPrefix = standardPrefixes.some((prefix) => trimmed.startsWith(prefix));
        if (hasPrefix && trimmed.includes(':')) {
            const suffix = trimmed.split(':').slice(1).join(':').trim();
            if (suffix) {
                return suffix;
            }
        }
        return trimmed;
    }

    cancelSync(repoIndex = 1) {
        const state = this.syncState[repoIndex];
        if (!state?.isSyncing) {
            return false;
        }
        if (!state.cancelRequested) {
            state.cancelRequested = true;
            this.emit('log', {
                message: `仓库${repoIndex} 收到中止请求，正在尝试停止当前同步任务`,
                level: 'warn',
                timestamp: new Date().toISOString(),
                repoIndex
            });
        }
        return true;
    }

    async syncBranches(options = {}, onLog, repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const state = this.syncState[repoIndex];

        const {
            targetBranches,
            commitHash,
            remoteName: selectedRemote
        } = options;

        if (!targetBranches?.length) {
            throw new Error('至少选择一个目标分支');
        }

        if (!commitHash) {
            throw new Error('请填写需要同步的提交哈希');
        }

        if (state.isSyncing) {
            throw new Error(`仓库${repoIndex} 已有同步任务正在执行`);
        }

        state.cancelRequested = false;
        state.isSyncing = true;

        try {
            const branchInfo = await git.branch();
            const branchLocal = await git.branchLocal();
            const fallbackBranch = branchInfo.current;
            const branchToRestore = fallbackBranch;

            const log = (message, level = 'info') => {
                const payload = {
                    message: `[仓库${repoIndex}] ${message}`,
                    level,
                    timestamp: new Date().toISOString(),
                    repoIndex
                };
                if (typeof onLog === 'function') {
                    onLog(payload);
                } else {
                    this.emit('log', payload);
                }
            };

            const results = [];
            let cancelled = false;
            const CANCEL_CODE = 'USER_CANCELLED';
            const checkCancelled = () => {
                if (state.cancelRequested) {
                    const cancelError = new Error('USER_CANCELLED');
                    cancelError.code = CANCEL_CODE;
                    throw cancelError;
                }
            };

            for (const target of targetBranches) {
                const result = { branch: target, success: true, error: null };
                let cherryPickStarted = false;
                try {
                    checkCancelled();
                    log(`开始同步到分支 ${target}（精准提交）`);
                    await this.safeFetch(git);
                    log(`[${target}] git fetch 完成`);
                    checkCancelled();

                    let checkedOut = false;

                    // 检查远程分支是否存在并获取引用（分支已经过验证，必须存在）
                    const remoteRef = await this.findRemoteBranchRef(
                        target,
                        repoIndex,
                        selectedRemote,
                        true
                    );
                    if (!remoteRef) {
                        const remoteHint = selectedRemote ? `远程 ${selectedRemote}` : '远程仓库';
                        throw new Error(
                            `分支 ${target} 在${remoteHint}中不存在，无法进行同步。请确认远程仓库选择是否正确。`
                        );
                    }

                    // 提取远程仓库名称和分支引用
                    // remoteRef 格式: remotes/origin/branch 或 remotes/upstream/branch
                    const remoteMatch = remoteRef.match(/^remotes\/([^/]+)\/(.+)$/);
                    if (!remoteMatch) {
                        throw new Error(`无法解析远程分支引用：${remoteRef}`);
                    }
                    const remoteName = remoteMatch[1]; // origin, upstream 等
                    const remoteBranchName = remoteMatch[2]; // 分支名（从远程引用中提取，确保完全匹配）
                    const remoteBranchRef = `${remoteName}/${remoteBranchName}`; // origin/branch 格式

                    if (!branchLocal.all.includes(target)) {
                        // 本地分支不存在，从远程分支创建并跟踪
                        try {
                            await git.checkout(['-b', target, remoteBranchRef]);
                            log(`[${target}] 本地不存在，已从 ${remoteBranchRef} 创建并切换`);
                            branchLocal.all.push(target);
                            checkedOut = true;
                        } catch (createError) {
                            throw new Error(
                                `创建或跟踪远端分支失败：${createError?.message ?? createError}`
                            );
                        }
                    } else {
                        // 本地分支已存在，切换到该分支
                        await git.checkout(target);
                        log(`[${target}] 已切换到本地分支`);
                        checkedOut = true;
                    }

                    checkCancelled();

                    // 拉取远程分支最新代码（确保与远程完全同步）
                    try {
                        await git.pull(remoteName, target, { '--ff-only': null });
                        log(`[${target}] 已拉取远程分支 ${remoteBranchRef} 最新代码`);
                    } catch (pullError) {
                        // 如果拉取失败（可能是本地有未提交的更改或无法快进），重置到远程分支状态
                        if (
                            pullError?.message?.includes('Not possible to fast-forward') ||
                            pullError?.message?.includes('Cannot pull with rebase')
                        ) {
                            log(`[${target}] 无法快进合并，重置到远程分支状态`, 'warn');
                            try {
                                await git.reset(['--hard', remoteBranchRef]);
                                log(`[${target}] 已重置到远程分支 ${remoteBranchRef} 的最新状态`);
                            } catch (resetError) {
                                throw new Error(
                                    `同步远程分支失败：${resetError?.message ?? resetError}`
                                );
                            }
                        } else {
                            throw new Error(
                                `拉取远程分支失败：${pullError?.message ?? pullError}`
                            );
                        }
                    }

                    checkCancelled();

                    // 推送分支到远程（远程分支已存在，直接推送）
                    const pushBranch = async () => {
                        await git.push(remoteName, target);
                        log(`[${target}] 已推送到 ${remoteBranchRef}`);
                    };

                    cherryPickStarted = true;
                    await git.raw(['cherry-pick', commitHash]);
                    log(`[${target}] 已应用提交 ${commitHash}`);
                    await pushBranch();
                    checkCancelled();
                } catch (error) {
                    if (error?.code === CANCEL_CODE) {
                        cancelled = true;
                        result.success = false;
                        result.error = '用户已中止';
                        log(`[${target}] 同步已被中止`, 'warn');
                    } else {
                        const rawMessage = error?.message ?? String(error);
                        
                        // 检测 cherry-pick 空提交的情况（代码已经和需要同步的一样了）
                        if (rawMessage.includes('cherry-pick is now empty') || 
                            rawMessage.includes('nothing to commit') && rawMessage.includes('cherry-pick')) {
                            // 执行 cherry-pick --skip 跳过空提交
                            try {
                                await git.raw(['cherry-pick', '--skip']);
                                log(`[${target}] 该分支已包含相同的更改，无需重复同步（已自动跳过）`, 'info');
                                result.success = true;
                                result.error = null;
                            } catch (skipError) {
                                log(`[${target}] 跳过空提交失败: ${skipError?.message ?? skipError}`, 'warn');
                                result.success = true; // 仍然标记为成功，因为代码已经一致
                                result.error = null;
                            }
                        }
                        // 检测网络超时错误，自动重试
                        else if (rawMessage.includes('Connection timed out') || 
                                 rawMessage.includes('Could not read from remote repository') ||
                                 rawMessage.includes('Connection refused') ||
                                 rawMessage.includes('Network is unreachable')) {
                            log(`[${target}] 网络连接超时，正在重试...`, 'warn');
                            
                            // 尝试重试一次
                            let retrySuccess = false;
                            for (let retryCount = 1; retryCount <= 2; retryCount++) {
                                try {
                                    checkCancelled();
                                    log(`[${target}] 第 ${retryCount} 次重试推送...`, 'info');
                                    await new Promise(resolve => setTimeout(resolve, 2000)); // 等待2秒后重试
                                    await git.push(remoteName, target);
                                    log(`[${target}] 重试推送成功！`, 'info');
                                    retrySuccess = true;
                                    break;
                                } catch (retryError) {
                                    const retryMsg = retryError?.message ?? String(retryError);
                                    if (retryMsg.includes('Connection timed out') || 
                                        retryMsg.includes('Could not read from remote repository') ||
                                        retryMsg.includes('Connection refused') ||
                                        retryMsg.includes('Network is unreachable')) {
                                        log(`[${target}] 第 ${retryCount} 次重试失败，网络仍不可用`, 'warn');
                                    } else {
                                        log(`[${target}] 重试时发生其他错误: ${retryMsg}`, 'error');
                                        break;
                                    }
                                }
                            }
                            
                            if (retrySuccess) {
                                result.success = true;
                                result.error = null;
                            } else {
                                result.success = false;
                                result.error = '网络连接失败，请检查网络后重试';
                                log(`[${target}] 同步失败: 网络连接超时，多次重试后仍失败`, 'error');
                            }
                        } else {
                            result.success = false;
                            result.error = rawMessage;
                            log(`[${target}] 同步失败: ${result.error}`, 'error');
                            if (cherryPickStarted) {
                                try {
                                    await git.raw(['cherry-pick', '--abort']);
                                    log(`[${target}] 已回滚 cherry-pick 操作`, 'warn');
                                } catch (abortError) {
                                    log(`[${target}] 回滚 cherry-pick 失败: ${abortError?.message ?? abortError}`, 'error');
                                }
                            }
                        }
                    }
                } finally {
                    results.push(result);
                }

                if (cancelled) {
                    break;
                }
            }

            // 精准提交模式不切回，保持操作分支
            if (branchToRestore && !state.cancelRequested) {
                log(`同步结束，当前分支保持在最后处理分支`);
            }

            if (state.cancelRequested) {
                cancelled = true;
            }

            return { results, cancelled };
        } finally {
            state.isSyncing = false;
            state.cancelRequested = false;
        }
    }
}

export const gitService = new GitService();
