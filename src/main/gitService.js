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

    formatRemoteBranchKey(remoteName, branchName) {
        return `${remoteName}/${branchName}`;
    }

    /** 多远程重名时忽略的分支（如 main 各远程均有，不算重复） */
    isIgnoredDuplicateBranch(branchName) {
        const lower = String(branchName || '').trim().toLowerCase();
        return lower === 'main';
    }

    splitBranchNameInput(branchNames) {
        if (!Array.isArray(branchNames)) return [];
        const result = [];
        const seen = new Set();

        for (const raw of branchNames) {
            const text = String(raw ?? '').trim();
            if (!text) continue;

            const parts = text.split(/[\r\n,，、;；\t]+/);
            for (const part of parts) {
                const name = String(part ?? '').trim();
                if (!name) continue;
                const key = name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(name);
            }
        }

        return result;
    }

    parseSyncTarget(target, fallbackRemote = '') {
        const raw = String(target ?? '').trim();
        if (!raw) {
            return { remote: fallbackRemote, branch: '', key: '' };
        }
        const slash = raw.indexOf('/');
        if (slash > 0) {
            const remote = raw.slice(0, slash);
            const branch = raw.slice(slash + 1);
            return { remote, branch, key: `${remote}/${branch}` };
        }
        return {
            remote: fallbackRemote,
            branch: raw,
            key: fallbackRemote ? `${fallbackRemote}/${raw}` : raw
        };
    }

    buildRemoteBranchIndex(branchSummary) {
        const index = new Map();
        for (const refName of branchSummary.all) {
            if (!refName?.startsWith('remotes/')) continue;
            const match = refName.match(/^remotes\/([^/]+)\/(.+)$/);
            if (!match) continue;
            const remote = match[1];
            const branch = this.normalizeRemoteBranchName(refName);
            if (!branch) continue;
            const lower = branch.toLowerCase();
            if (!index.has(lower)) index.set(lower, []);
            const list = index.get(lower);
            if (!list.some((item) => item.remote === remote && item.branch === branch)) {
                list.push({ remote, branch });
            }
        }
        return index;
    }

    findRemoteBranchMatch(index, branchName, remoteName = null) {
        const trimmed = String(branchName ?? '').trim();
        if (!trimmed) return null;
        const lower = trimmed.toLowerCase();
        const matches = (index.get(lower) ?? []).filter(
            (item) => !remoteName || item.remote === remoteName
        );
        return matches.length === 1 ? matches[0] : null;
    }

    async fetchAll(git) {
        await git.fetch(['--all', '--prune']);
    }

    async safeFetch(git) {
        const remotes = await git.getRemotes();
        if (remotes.length === 0) {
            return { warnings: ['未配置任何远程仓库'] };
        }

        try {
            await this.fetchAll(git);
            return { warnings: [] };
        } catch (error) {
            const reason = error?.message ?? String(error);
            return {
                warnings: [`fetch --all 失败，将使用已有远程跟踪分支，不会修改远程引用（${reason}）`]
            };
        }
    }

    async switchAwayFromBranch(git, branchName) {
        const current = (await git.branch()).current;
        if (current !== branchName) return;

        const locals = await git.branchLocal();
        const fallback = locals.all.find((name) => name !== branchName);
        if (fallback) {
            await git.checkout(fallback);
            return;
        }

        await git.checkout(['--detach']);
    }

    async cleanupSyncLocalBranches(git, { branchesCreatedDuringSync, branchToRestore, initialLocalBranches, log }) {
        if (!branchesCreatedDuringSync?.size) return;

        const restoreCandidates = [
            branchToRestore,
            ...[...initialLocalBranches].filter((name) => !branchesCreatedDuringSync.has(name))
        ].filter((name, index, list) => name && list.indexOf(name) === index);

        for (const candidate of restoreCandidates) {
            try {
                await git.checkout(candidate);
                break;
            } catch {
                // try next candidate
            }
        }

        for (const branchName of branchesCreatedDuringSync) {
            try {
                await this.switchAwayFromBranch(git, branchName);
                await git.deleteLocalBranch(branchName, true);
                log(`[${branchName}] 已清理同步时创建的本地分支`, 'info');
            } catch (error) {
                log(
                    `[${branchName}] 清理本地分支失败: ${error?.message ?? error}`,
                    'warn'
                );
            }
        }

        const currentBranch = (await git.branch()).current;
        if (branchToRestore && currentBranch === branchToRestore) {
            log(`已切回同步前分支 ${branchToRestore}`);
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

    async getBranchGroups(repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const { warnings } = await this.safeFetch(git);
        const remotes = await this.getRemotes(repoIndex);
        const branchSummary = await git.branch(['-a']);
        const branchToRemotes = new Map();

        const groups = remotes.map(({ name }) => {
            const branches = branchSummary.all
                .filter((ref) => this.matchesRemoteRef(ref, name))
                .map((ref) => this.normalizeRemoteBranchName(ref))
                .filter(Boolean);
            const unique = Array.from(new Set(branches)).sort();
            for (const branch of unique) {
                const lower = branch.toLowerCase();
                if (!branchToRemotes.has(lower)) {
                    branchToRemotes.set(lower, { branch, remotes: [] });
                }
                branchToRemotes.get(lower).remotes.push(name);
            }
            return { remote: name, branches: unique };
        });

        const duplicates = [...branchToRemotes.values()]
            .filter(
                (item) => item.remotes.length > 1 && !this.isIgnoredDuplicateBranch(item.branch)
            )
            .map((item) => item.branch)
            .sort();

        return {
            groups,
            duplicates,
            current: branchSummary.current,
            fetchWarnings: warnings
        };
    }

    normalizeBranchFamilyName(name) {
        return String(name || '').trim().toLowerCase();
    }

    isVariantOfBranch(baseName, candidateName) {
        const base = this.normalizeBranchFamilyName(baseName);
        const candidate = this.normalizeBranchFamilyName(candidateName);
        if (!base || !candidate) return false;
        if (candidate === base) return true;
        if (!candidate.startsWith(base)) return false;
        const suffix = candidate.slice(base.length);
        return /^[0-9]+$/.test(suffix);
    }

    collectBranchFamilyCandidates(index, target) {
        const candidates = [];
        const seen = new Set();

        for (const list of index.values()) {
            for (const item of list) {
                if (!this.isVariantOfBranch(target, item.branch)) continue;
                const dedupeKey = `${item.remote}/${item.branch}`.toLowerCase();
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                candidates.push(item);
            }
        }

        return candidates;
    }

    async resolveBestRemoteBranches(branchNames, repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        if (!Array.isArray(branchNames) || branchNames.length === 0) {
            return { resolved: [], unresolved: [] };
        }

        await this.safeFetch(git);
        const branchSummary = await git.branch(['-a']);
        const index = this.buildRemoteBranchIndex(branchSummary);
        const timestampCache = new Map();

        const getTimestamp = async (remote, branch) => {
            const key = `${remote}/${branch}`;
            if (timestampCache.has(key)) return timestampCache.get(key);
            const ts = await this.getRemoteBranchLastCommitTime(git, remote, branch);
            timestampCache.set(key, ts);
            return ts;
        };

        const resolved = [];
        const unresolved = [];

        for (const rawName of branchNames) {
            const target = String(rawName || '').trim();
            if (!target) continue;

            const candidates = this.collectBranchFamilyCandidates(index, target);
            const matchMode = candidates.some(
                (item) => this.normalizeBranchFamilyName(item.branch) === target.toLowerCase()
            )
                ? 'exact'
                : 'variant';

            if (!candidates.length) {
                unresolved.push({ input: target, reason: 'not-found' });
                continue;
            }

            const ranked = await Promise.all(
                candidates.map(async (item) => ({
                    remote: item.remote,
                    branch: item.branch,
                    key: this.formatRemoteBranchKey(item.remote, item.branch),
                    lastCommitAt: await getTimestamp(item.remote, item.branch)
                }))
            );
            ranked.sort((a, b) => b.lastCommitAt - a.lastCommitAt);

            resolved.push({
                input: target,
                mode: matchMode,
                best: ranked[0],
                candidates: ranked
            });
        }

        return { resolved, unresolved };
    }

    async getRemoteBranchLastCommitTime(git, remoteName, branchName) {
        try {
            const output = await git.raw([
                'log',
                '-1',
                '--format=%ct',
                `${remoteName}/${branchName}`
            ]);
            const timestamp = Number.parseInt(String(output).trim(), 10);
            return Number.isFinite(timestamp) ? timestamp : 0;
        } catch {
            return 0;
        }
    }

    async planStaleDuplicateDeletions(repoIndex = 1) {
        const git = this.getGitByRepoIndex(repoIndex);
        const { warnings } = await this.safeFetch(git);
        const branchSummary = await git.branch(['-a']);
        const index = this.buildRemoteBranchIndex(branchSummary);
        const deletions = [];

        for (const matches of index.values()) {
            if (matches.length < 2) continue;
            if (this.isIgnoredDuplicateBranch(matches[0].branch)) continue;

            const ranked = await Promise.all(
                matches.map(async (match) => {
                    const lastCommitAt = await this.getRemoteBranchLastCommitTime(
                        git,
                        match.remote,
                        match.branch
                    );
                    return {
                        branch: match.branch,
                        remote: match.remote,
                        key: this.formatRemoteBranchKey(match.remote, match.branch),
                        lastCommitAt
                    };
                })
            );

            ranked.sort((a, b) => a.lastCommitAt - b.lastCommitAt);
            const stalest = ranked[0];
            const newest = ranked[ranked.length - 1];
            if (!stalest) continue;

            deletions.push({
                branch: stalest.branch,
                remote: stalest.remote,
                key: stalest.key,
                lastCommitAt: stalest.lastCommitAt,
                keepRemote: newest.remote,
                keepKey: newest.key,
                keepLastCommitAt: newest.lastCommitAt
            });
        }

        deletions.sort((a, b) => a.branch.localeCompare(b.branch));
        return { deletions, fetchWarnings: warnings };
    }

    async deleteStaleDuplicateRemoteBranches(repoIndex = 1, onLog) {
        const git = this.getGitByRepoIndex(repoIndex);
        const state = this.syncState[repoIndex];

        if (state.isSyncing) {
            throw new Error(`仓库${repoIndex} 已有任务正在执行`);
        }

        state.cancelRequested = false;
        state.isSyncing = true;

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

        const formatCommitTime = (timestamp) => {
            if (!timestamp) return '未知时间';
            return new Date(timestamp * 1000).toLocaleString('zh-CN');
        };

        const CANCEL_CODE = 'USER_CANCELLED';
        const checkCancelled = () => {
            if (state.cancelRequested) {
                const cancelError = new Error('USER_CANCELLED');
                cancelError.code = CANCEL_CODE;
                throw cancelError;
            }
        };

        const deleted = [];
        const failed = [];
        let cancelled = false;

        try {
            checkCancelled();
            log('开始清理重名远程分支…');

            const { deletions, fetchWarnings } = await this.planStaleDuplicateDeletions(repoIndex);
            if (fetchWarnings?.length) {
                fetchWarnings.forEach((warning) => log(warning, 'warn'));
            }

            if (!deletions.length) {
                log('没有可清理的重名旧分支');
                return { deleted, failed, cancelled };
            }

            const duplicateNames = [...new Set(deletions.map((item) => item.branch))];
            log(
                `警告：分支名 ${duplicateNames.join('、')} 在多个远程仓库中重复，请勾选时认准远程分组，或批量粘贴时使用 远程/分支 格式。`,
                'warn'
            );

            log(
                `共 ${deletions.length} 个重名旧分支待删除：\n${deletions
                    .map(
                        (item) =>
                            `  ${item.key}（${formatCommitTime(item.lastCommitAt)}）→ 保留 ${item.keepKey}`
                    )
                    .join('\n')}`
            );

            log(`正在批量删除 ${deletions.length} 个重名旧分支…`);
            for (const item of deletions) {
                try {
                    checkCancelled();
                    await git.raw(['push', item.remote, '--delete', item.branch]);
                    deleted.push(item);
                } catch (error) {
                    if (error?.code === CANCEL_CODE) {
                        throw error;
                    }
                    const errMsg = error?.message ?? String(error);
                    failed.push({ ...item, error: errMsg });
                }
            }

            if (deleted.length) {
                await this.safeFetch(git);
                log(`批量删除完成，成功 ${deleted.length} 个：\n${deleted.map((item) => item.key).join('\n')}`);
            }
            if (failed.length) {
                log(
                    `批量删除失败 ${failed.length} 个：\n${failed.map((item) => `${item.key}: ${item.error}`).join('\n')}`,
                    'error'
                );
            }
            if (!failed.length && deleted.length) {
                log(`清理完成，共删除 ${deleted.length} 个重名旧远程分支`);
            }

            return { deleted, failed, cancelled };
        } catch (error) {
            if (error?.code === CANCEL_CODE) {
                cancelled = true;
                log('清理任务已被用户中止', 'warn');
                if (deleted.length) {
                    log(`中止前已删除 ${deleted.length} 个：\n${deleted.map((item) => item.key).join('\n')}`);
                }
                return { deleted, failed, cancelled };
            }
            throw error;
        } finally {
            state.isSyncing = false;
            state.cancelRequested = false;
        }
    }

    /**
     * 检查指定的分支名是否在远程仓库中存在
     * @param {string[]} branchNames - 要检查的分支名数组
     * @returns {Promise<{exists: string[], notExists: string[]}>} 返回存在和不存在的分支列表
     */
    async checkRemoteBranches(branchNames, repoIndex = 1, remoteName = null) {
        const git = this.getGitByRepoIndex(repoIndex);
        const normalizedNames = this.splitBranchNameInput(branchNames);
        if (!normalizedNames.length) {
            return { exists: [], notExists: [], ambiguous: [] };
        }

        await this.safeFetch(git);
        const branchSummary = await git.branch(['-a']);
        const index = this.buildRemoteBranchIndex(branchSummary);

        const exists = [];
        const notExists = [];
        const ambiguous = [];

        normalizedNames.forEach((branchName) => {
            const trimmed = branchName.trim();
            if (!trimmed) return;

            if (trimmed.includes('/')) {
                const parsed = this.parseSyncTarget(trimmed);
                if (parsed.remote && parsed.branch) {
                    const match = this.findRemoteBranchMatch(index, parsed.branch, parsed.remote);
                    if (match) {
                        exists.push(this.formatRemoteBranchKey(match.remote, match.branch));
                    } else {
                        notExists.push(trimmed);
                    }
                    return;
                }
            }

            const lower = trimmed.toLowerCase();
            let matches = index.get(lower) ?? [];
            if (remoteName) {
                matches = matches.filter((item) => item.remote === remoteName);
            }

            if (matches.length === 0) {
                notExists.push(trimmed);
            } else if (matches.length === 1) {
                exists.push(this.formatRemoteBranchKey(matches[0].remote, matches[0].branch));
            } else if (!this.isIgnoredDuplicateBranch(trimmed)) {
                ambiguous.push({
                    name: trimmed,
                    remotes: matches.map((item) => item.remote),
                    keys: matches.map((item) => this.formatRemoteBranchKey(item.remote, item.branch))
                });
            }
        });

        return { exists, notExists, ambiguous };
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
                message: `仓库${repoIndex} 收到中止请求，正在尝试停止当前任务`,
                level: 'warn',
                timestamp: new Date().toISOString(),
                repoIndex
            });
        }
        return true;
    }

    async syncBranches(options = {}, onLog, repoIndex = 1, onProgress) {
        const git = this.getGitByRepoIndex(repoIndex);
        const state = this.syncState[repoIndex];

        const {
            targetBranches,
            commitHash,
            commitHashes = {},
            remoteName: selectedRemote
        } = options;

        if (!targetBranches?.length) {
            throw new Error('至少选择一个目标分支');
        }

        const resolveCommitHashForRemote = (remoteName) => {
            const remote = String(remoteName || '').trim();
            if (!remote) return '';
            const fromMap = commitHashes?.[remote];
            if (fromMap) return String(fromMap).trim();
            if (commitHash) return String(commitHash).trim();
            return '';
        };

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
            const initialLocalBranches = new Set(branchLocal.all);
            const branchesCreatedDuringSync = new Set();

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
            const totalTargets = targetBranches.length;
            const reportProgress = (current, branch = '') => {
                if (typeof onProgress !== 'function') return;
                onProgress({
                    current,
                    total: totalTargets,
                    branch,
                    repoIndex
                });
            };
            const progressTag = (current) => `[${current}/${totalTargets}]`;
            const CANCEL_CODE = 'USER_CANCELLED';
            const checkCancelled = () => {
                if (state.cancelRequested) {
                    const cancelError = new Error('USER_CANCELLED');
                    cancelError.code = CANCEL_CODE;
                    throw cancelError;
                }
            };

            checkCancelled();
            log('正在执行 git fetch --all --prune ...');
            const fetchResult = await this.safeFetch(git);
            if (fetchResult.warnings?.length) {
                fetchResult.warnings.forEach((warning) => log(warning, 'warn'));
            }
            log('git fetch --all 完成');

            const branchSummary = await git.branch(['-a']);
            const resolveRemoteRef = (branchName, targetRemote) => {
                const trimmed = branchName.trim();
                for (const name of branchSummary.all) {
                    if (!this.matchesRemoteRef(name, targetRemote)) continue;
                    const normalized = this.normalizeRemoteBranchName(name);
                    if (normalized === trimmed) {
                        return name;
                    }
                }
                return null;
            };

            for (let index = 0; index < targetBranches.length; index += 1) {
                const target = targetBranches[index];
                const parsed = this.parseSyncTarget(target, selectedRemote);
                const { remote: targetRemote, branch: branchName, key: targetKey } = parsed;
                if (!targetRemote || !branchName) {
                    throw new Error(`无效的目标分支：${target}`);
                }

                const currentIndex = index + 1;
                const result = { branch: targetKey, success: true, error: null };
                let cherryPickStarted = false;
                let remoteName = targetRemote;
                const commitHashForRemote = resolveCommitHashForRemote(targetRemote);
                const logTag = `${progressTag(currentIndex)} ${targetKey}`;
                try {
                    checkCancelled();
                    if (!commitHashForRemote) {
                        throw new Error(`远程 ${targetRemote} 未配置提交哈希`);
                    }
                    reportProgress(currentIndex, targetKey);
                    log(`${progressTag(currentIndex)} 开始同步到 ${targetKey}（提交 ${commitHashForRemote}）`);

                    const remoteRef = resolveRemoteRef(branchName, targetRemote);
                    if (!remoteRef) {
                        throw new Error(
                            `分支 ${branchName} 在远程 ${targetRemote} 中不存在，无法进行同步。`
                        );
                    }

                    const remoteMatch = remoteRef.match(/^remotes\/([^/]+)\/(.+)$/);
                    if (!remoteMatch) {
                        throw new Error(`无法解析远程分支引用：${remoteRef}`);
                    }
                    remoteName = remoteMatch[1];
                    const remoteBranchName = remoteMatch[2];
                    const remoteBranchRef = `${remoteName}/${remoteBranchName}`;

                    if (!branchLocal.all.includes(branchName)) {
                        try {
                            await git.checkout(['-b', branchName, remoteBranchRef]);
                            log(`[${logTag}] 本地不存在，已从 ${remoteBranchRef} 创建并切换`);
                            branchLocal.all.push(branchName);
                            branchesCreatedDuringSync.add(branchName);
                        } catch (createError) {
                            throw new Error(
                                `创建或跟踪远端分支失败：${createError?.message ?? createError}`
                            );
                        }
                    } else {
                        await git.checkout(branchName);
                        log(`[${logTag}] 已切换到本地分支 ${branchName}`);
                    }

                    checkCancelled();

                    try {
                        await git.pull(remoteName, branchName, { '--ff-only': null });
                        log(`[${logTag}] 已拉取远程分支 ${remoteBranchRef} 最新代码`);
                    } catch (pullError) {
                        if (
                            pullError?.message?.includes('Not possible to fast-forward') ||
                            pullError?.message?.includes('Cannot pull with rebase')
                        ) {
                            log(`[${logTag}] 无法快进合并，重置到远程分支状态`, 'warn');
                            try {
                                await git.reset(['--hard', remoteBranchRef]);
                                log(`[${logTag}] 已重置到远程分支 ${remoteBranchRef} 的最新状态`);
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

                    const pushBranch = async () => {
                        await git.push(remoteName, branchName);
                        log(`[${logTag}] 已推送到 ${remoteBranchRef}`);
                    };

                    cherryPickStarted = true;
                    await git.raw(['cherry-pick', commitHashForRemote]);
                    log(`[${logTag}] 已应用提交 ${commitHashForRemote}`);
                    await pushBranch();
                    checkCancelled();
                } catch (error) {
                    if (error?.code === CANCEL_CODE) {
                        cancelled = true;
                        result.success = false;
                        result.error = '用户已中止';
                        log(`[${logTag}] 同步已被中止`, 'warn');
                    } else {
                        const rawMessage = error?.message ?? String(error);
                        
                        if (rawMessage.includes('cherry-pick is now empty') || 
                            rawMessage.includes('nothing to commit') && rawMessage.includes('cherry-pick')) {
                            try {
                                await git.raw(['cherry-pick', '--skip']);
                                log(`[${logTag}] 该分支已包含相同的更改，无需重复同步（已自动跳过）`, 'info');
                                result.success = true;
                                result.error = null;
                            } catch (skipError) {
                                log(`[${logTag}] 跳过空提交失败: ${skipError?.message ?? skipError}`, 'warn');
                                result.success = true;
                                result.error = null;
                            }
                        }
                        else if (rawMessage.includes('Connection timed out') || 
                                 rawMessage.includes('Could not read from remote repository') ||
                                 rawMessage.includes('Connection refused') ||
                                 rawMessage.includes('Network is unreachable')) {
                            log(`[${logTag}] 网络连接超时，正在重试...`, 'warn');
                            
                            let retrySuccess = false;
                            for (let retryCount = 1; retryCount <= 2; retryCount++) {
                                try {
                                    checkCancelled();
                                    log(`[${logTag}] 第 ${retryCount} 次重试推送...`, 'info');
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    await git.push(remoteName, branchName);
                                    log(`[${logTag}] 重试推送成功！`, 'info');
                                    retrySuccess = true;
                                    break;
                                } catch (retryError) {
                                    const retryMsg = retryError?.message ?? String(retryError);
                                    if (retryMsg.includes('Connection timed out') || 
                                        retryMsg.includes('Could not read from remote repository') ||
                                        retryMsg.includes('Connection refused') ||
                                        retryMsg.includes('Network is unreachable')) {
                                        log(`[${logTag}] 第 ${retryCount} 次重试失败，网络仍不可用`, 'warn');
                                    } else {
                                        log(`[${logTag}] 重试时发生其他错误: ${retryMsg}`, 'error');
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
                                log(`[${logTag}] 同步失败: 网络连接超时，多次重试后仍失败`, 'error');
                            }
                        } else {
                            result.success = false;
                            result.error = rawMessage;
                            log(`[${logTag}] 同步失败: ${result.error}`, 'error');
                            if (cherryPickStarted) {
                                try {
                                    await git.raw(['cherry-pick', '--abort']);
                                    log(`[${logTag}] 已回滚 cherry-pick 操作`, 'warn');
                                } catch (abortError) {
                                    log(`[${logTag}] 回滚 cherry-pick 失败: ${abortError?.message ?? abortError}`, 'error');
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

            await this.cleanupSyncLocalBranches(git, {
                branchesCreatedDuringSync,
                branchToRestore,
                initialLocalBranches,
                log
            });

            if (branchToRestore && !state.cancelRequested) {
                const currentBranch = (await git.branch()).current;
                if (currentBranch !== branchToRestore && !branchesCreatedDuringSync.has(branchToRestore)) {
                    log(`同步结束，当前分支为 ${currentBranch}`);
                }
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
