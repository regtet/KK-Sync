<template>
  <teleport to="body">
    <div v-if="visible" class="sheet-overlay" @click.self="close">
      <div class="sheet-panel">
        <header class="sheet-header">
          <div class="header-text">
            <h3>从 Google 表格选择分支</h3>
            <p class="header-sub">按系列分组展示，可折叠；分支名会自动匹配最新可用分支。</p>
          </div>
          <button type="button" class="btn ghost sm" @click="close">✕</button>
        </header>

        <div class="sheet-toolbar">
          <input
            v-model.trim="filterText"
            type="search"
            placeholder="筛选行号、B/C/H 列、分支名、远程仓库…"
          />
          <button
            type="button"
            class="btn ghost sm"
            :disabled="loading || matching"
            title="重新加载"
            @click="loadRows"
          >
            🔄
          </button>
          <button type="button" class="btn ghost sm" @click="logout">退出 Google</button>
        </div>

        <div class="sheet-body">
          <p v-if="loading" class="sheet-hint">正在读取 Google 表格…</p>
          <p v-else-if="error" class="sheet-hint error">{{ error }}</p>
          <p v-else-if="!rows.length" class="sheet-hint">暂无表格数据，请点击右上角 🔄 加载</p>
          <p v-else-if="!groupedRows.length" class="sheet-hint">暂无符合条件的分支</p>

          <table v-else class="sheet-table">
            <colgroup>
              <col class="col-check" />
              <col class="col-row" />
              <col class="col-b" />
              <col class="col-c" />
              <col class="col-h" />
              <col class="col-branch" />
              <col class="col-remote" />
              <col class="col-updated" />
              <col class="col-match" />
              <col class="col-src" />
            </colgroup>
            <thead>
              <tr>
                <th class="col-check">
                  <input
                    type="checkbox"
                    :checked="isAllFilteredSelected"
                    :indeterminate.prop="isPartialFilteredSelected"
                    @change="toggleSelectAllFiltered"
                  />
                </th>
                <th class="col-row">行</th>
                <th class="col-b">B 备注</th>
                <th class="col-c">C 项目名</th>
                <th class="col-h">系列</th>
                <th class="col-branch">真实分支名</th>
                <th class="col-remote">当前远程仓库</th>
                <th class="col-updated">最后更新</th>
                <th class="col-match">匹配</th>
                <th class="col-src">来源</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="group in groupedRows" :key="group.name">
                <tr class="series-row" @click="toggleSeries(group.name)">
                  <td colspan="10" class="series-cell">
                    <div class="series-cell-inner">
                      <label class="series-select" @click.stop>
                        <input
                          type="checkbox"
                          :checked="isSeriesAllSelected(group)"
                          :indeterminate.prop="isSeriesPartialSelected(group)"
                          @change="toggleSeriesSelection(group, $event)"
                        />
                      </label>
                      <span class="series-arrow">{{ collapsedSeries.has(group.name) ? '▶' : '▼' }}</span>
                      <span class="series-name">{{ group.name }}</span>
                      <span class="series-count">({{ group.rows.length }})</span>
                    </div>
                  </td>
                </tr>
                <tr
                  v-for="row in group.rows"
                  v-show="!collapsedSeries.has(group.name)"
                  :key="row.rowNumber"
                  :class="{ selected: selectedRows.has(row.rowNumber) }"
                  @click="toggleRow(row)"
                >
                  <td class="col-check" @click.stop>
                    <input
                      type="checkbox"
                      :checked="selectedRows.has(row.rowNumber)"
                      :disabled="!isRowSelectable(row)"
                      @change="toggleRow(row)"
                    />
                  </td>
                  <td class="col-row">{{ row.rowNumber }}</td>
                  <td class="col-b" :title="row.branchRawB">{{ row.branchRawB || '—' }}</td>
                  <td class="col-c" :title="row.branchRawC">{{ row.branchRawC || '—' }}</td>
                  <td class="col-h" :title="row.series">{{ row.series || '—' }}</td>
                  <td class="col-branch" :title="row.matchedBranchName || row.branchName">{{ row.matchedBranchName || row.branchName }}</td>
                  <td class="col-remote" :title="row.currentRemote">{{ row.currentRemote || '—' }}</td>
                  <td class="col-updated">{{ formatRelativeTime(row.lastCommitAt) }}</td>
                  <td class="col-match">
                    <span class="match-badge" :class="row.matchStatus">{{ matchStatusLabel(row.matchStatus) }}</span>
                  </td>
                  <td class="col-src">{{ row.branchSource }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <footer class="sheet-footer">
          <span class="status-text">{{ statusText }}</span>
          <div class="footer-actions">
            <button type="button" class="btn ghost sm" @click="close">取消</button>
            <button
              type="button"
              class="btn ghost sm"
              :disabled="!canWriteBack || writingBack"
              @click="writeBackSelected"
            >
              {{ writingBack ? '回填中…' : `回填真实分支名（${writableCount}）` }}
            </button>
            <button
              type="button"
              class="btn primary sm"
              :disabled="!selectedRows.size"
              @click="confirmSelection"
            >
              导入选中（{{ selectedRows.size }}）
            </button>
          </div>
        </footer>
      </div>
    </div>
  </teleport>
</template>

<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  repoIndex: { type: Number, default: 1 }
});

const emit = defineEmits(['update:visible', 'confirm']);

const loading = ref(false);
const matching = ref(false);
const writingBack = ref(false);
const error = ref('');
const filterText = ref('');
const rows = ref([]);
const sheetTitle = ref('');
const stopRow = ref(0);
const sheetGid = ref(0);
const selectedRows = ref(new Set());
const rowMap = ref(new Map());
const collapsedSeries = ref(new Set());
const hasLoadedOnce = ref(false);

const isRowSelectable = (row) => row?.matchStatus === 'matched';

const formatRelativeTime = (unixSeconds) => {
  const ts = Number(unixSeconds || 0);
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);

  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}天前`;
  if (diff < 30 * 86400) return `${Math.floor(diff / (7 * 86400))}周前`;
  if (diff < 365 * 86400) return `${Math.floor(diff / (30 * 86400))}月前`;
  return `${Math.floor(diff / (365 * 86400))}年前`;
};

const statusText = computed(() => {
  if (loading.value) return '正在加载…';
  if (matching.value) return '正在智能匹配分支…';
  if (writingBack.value) return '正在回填真实分支名到 Google 表格…';
  if (error.value) return error.value;
  const rowCount = rows.value.length;
  const title = sheetTitle.value ? `工作表：${sheetTitle.value} | ` : '';
  const stopHint = stopRow.value ? `读取至第 ${stopRow.value - 1} 行（不含） | ` : '';
  const matched = rows.value.filter((row) => row.matchStatus === 'matched').length;
  const missing = rows.value.filter((row) => row.matchStatus === 'missing').length;
  const matchHint = `匹配 ${matched} · 未找到 ${missing} | `;
  return `${title}${stopHint}${matchHint}共 ${rowCount} 项 · 已选 ${selectedRows.value.size} 项`;
});

const matchStatusLabel = (status) => {
  switch (status) {
    case 'matched':
      return '已匹配';
    case 'missing':
      return '未找到';
    case 'ambiguous':
      return '重名';
    case 'no-repo':
      return '未选仓库';
    case 'checking':
      return '查询中';
    default:
      return '—';
  }
};

const filteredRows = computed(() => {
  const keyword = filterText.value.trim().toLowerCase();
  if (!keyword) return rows.value;

  return rows.value.filter((row) => {
    const haystack = [
      row.rowNumber,
      row.branchRawB,
      row.branchRawC,
      row.series,
      row.branchName,
      row.currentRemote,
      row.matchedBranchName,
      row.branchSource,
      row.matchStatus,
      row.preview
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(keyword);
  });
});

const getRowLastCommitAt = (row) => {
  const ts = Number(row?.lastCommitAt || 0);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
};

const sortRowsByLastUpdate = (list) =>
  list.slice().sort((a, b) => {
    const aTs = getRowLastCommitAt(a);
    const bTs = getRowLastCommitAt(b);
    if (aTs !== bTs) return bTs - aTs;
    return a.rowNumber - b.rowNumber;
  });

const groupedRows = computed(() => {
  const map = new Map();
  const unmatched = [];
  for (const row of filteredRows.value) {
    if (!isRowSelectable(row)) {
      unmatched.push(row);
      continue;
    }
    const key = row.series || '未分类';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const groups = [...map.entries()].map(([name, grouped]) => ({
    name,
    rows: sortRowsByLastUpdate(grouped)
  }));

  if (unmatched.length) {
    groups.push({
      name: '未匹配',
      rows: unmatched.slice().sort((a, b) => a.rowNumber - b.rowNumber)
    });
  }

  return groups;
});

const isAllFilteredSelected = computed(() => {
  const selectableRows = filteredRows.value.filter(isRowSelectable);
  if (!selectableRows.length) return false;
  return selectableRows.every((row) => selectedRows.value.has(row.rowNumber));
});

const isPartialFilteredSelected = computed(() => {
  const selectableRows = filteredRows.value.filter(isRowSelectable);
  if (!selectableRows.length) return false;
  const selectedCount = selectableRows.filter((row) => selectedRows.value.has(row.rowNumber)).length;
  return selectedCount > 0 && selectedCount < selectableRows.length;
});

const close = () => {
  emit('update:visible', false);
};

const toggleSeries = (seriesName) => {
  const next = new Set(collapsedSeries.value);
  if (next.has(seriesName)) next.delete(seriesName);
  else next.add(seriesName);
  collapsedSeries.value = next;
};

const toggleRow = (row) => {
  if (!isRowSelectable(row)) return;
  const next = new Set(selectedRows.value);
  if (next.has(row.rowNumber)) next.delete(row.rowNumber);
  else next.add(row.rowNumber);
  selectedRows.value = next;
};

const toggleSelectAllFiltered = (event) => {
  const next = new Set(selectedRows.value);
  if (event.target.checked) {
    filteredRows.value.forEach((row) => {
      if (isRowSelectable(row)) next.add(row.rowNumber);
    });
  } else {
    filteredRows.value.forEach((row) => {
      if (isRowSelectable(row)) next.delete(row.rowNumber);
    });
  }
  selectedRows.value = next;
};

const getSeriesSelectableRows = (group) => group.rows.filter(isRowSelectable);

const isSeriesAllSelected = (group) => {
  const selectableRows = getSeriesSelectableRows(group);
  if (!selectableRows.length) return false;
  return selectableRows.every((row) => selectedRows.value.has(row.rowNumber));
};

const isSeriesPartialSelected = (group) => {
  const selectableRows = getSeriesSelectableRows(group);
  if (!selectableRows.length) return false;
  const selectedCount = selectableRows.filter((row) => selectedRows.value.has(row.rowNumber)).length;
  return selectedCount > 0 && selectedCount < selectableRows.length;
};

const toggleSeriesSelection = (group, event) => {
  const selectableRows = getSeriesSelectableRows(group);
  if (!selectableRows.length) return;
  const next = new Set(selectedRows.value);
  if (event.target.checked) {
    selectableRows.forEach((row) => next.add(row.rowNumber));
  } else {
    selectableRows.forEach((row) => next.delete(row.rowNumber));
  }
  selectedRows.value = next;
};

const normalizeSeriesPrefix = (series) => {
  const raw = String(series || '').trim().toLowerCase();
  if (!raw) return '';
  const removedSuffix = raw.replace(/系列/g, '');
  const lettersDigits = removedSuffix.replace(/[^a-z0-9]/g, '');
  return lettersDigits;
};

const buildSeriesPrefixedBranch = (row) => {
  const branch = String(row?.branchName || '').trim();
  const prefix = normalizeSeriesPrefix(row?.series);
  if (!branch || !prefix) return '';
  const lowerBranch = branch.toLowerCase();
  if (lowerBranch.startsWith(`${prefix}-`) || lowerBranch.startsWith(`${prefix}/`)) {
    return '';
  }
  return `${prefix}-${branch}`;
};

const stripLeadingSeriesPrefix = (branchName) => {
  const raw = String(branchName || '').trim().toLowerCase();
  if (!raw) return '';
  const match = raw.match(/^([a-z]+\d*)[-/](.+)$/);
  if (!match) return '';
  const suffix = String(match[2] || '').trim();
  if (!suffix || suffix.length < 2) return '';
  if (!/[a-z]/.test(suffix)) return '';
  return suffix;
};

const ensureAuth = async () => {
  if (!window.electronAPI?.googleSheetsAuthStatus) {
    throw new Error('请在 KK Sync 桌面应用中打开（浏览器预览不支持 Google 表格）');
  }
  const status = await window.electronAPI.googleSheetsAuthStatus();
  if (!status?.hasClientSecret) {
    throw new Error('未找到 client_secret*.json，请放在应用目录或 src/main/ 后重启应用');
  }
  if (status.authenticated) return status;

  const loginResult = await window.electronAPI?.googleSheetsLogin?.();
  if (!loginResult?.ok) {
    throw new Error(loginResult?.message || 'Google 授权失败');
  }
  return loginResult;
};

const refreshBranchMatchStatus = async () => {
  if (!rows.value.length) return;

  if (!window.electronAPI?.resolveBestBranches) {
    rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'no-repo' }));
    return;
  }

  matching.value = true;
  rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'checking' }));

  try {
    const uniqueNames = [...new Set(rows.value.map((row) => row.branchName).filter(Boolean))];
    const result = await window.electronAPI.resolveBestBranches(uniqueNames, props.repoIndex);

    if (!result?.ok) {
      rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'unknown' }));
      return;
    }

    const resolvedMap = new Map();
    for (const item of result.data?.resolved ?? []) {
      resolvedMap.set(String(item.input).toLowerCase(), item);
    }

    rows.value = rows.value.map((row) => {
      const matched = resolvedMap.get(String(row.branchName).toLowerCase());
      if (!matched?.best) {
        return {
          ...row,
          matchedBranchName: row.branchName,
          currentRemote: '',
          lastCommitAt: 0,
          matchStatus: 'missing',
        };
      }
      return {
        ...row,
        matchedBranchName: matched.best.branch,
        currentRemote: matched.best.remote,
        matchKey: matched.best.key,
        lastCommitAt: matched.best.lastCommitAt || 0,
        matchStatus: 'matched',
      };
    });

    const fallbackTargets = [];
    for (const row of rows.value) {
      if (row.matchStatus !== 'missing') continue;
      const prefixed = buildSeriesPrefixedBranch(row);
      if (!prefixed) continue;
      fallbackTargets.push(prefixed);
    }
    const uniqueFallbackTargets = [...new Set(fallbackTargets)];
    if (uniqueFallbackTargets.length) {
      const fallbackResult = await window.electronAPI.resolveBestBranches(
        uniqueFallbackTargets,
        props.repoIndex
      );
      if (fallbackResult?.ok) {
        const fallbackMap = new Map();
        for (const item of fallbackResult.data?.resolved ?? []) {
          fallbackMap.set(String(item.input).toLowerCase(), item);
        }
        rows.value = rows.value.map((row) => {
          if (row.matchStatus !== 'missing') return row;
          const prefixed = buildSeriesPrefixedBranch(row);
          if (!prefixed) return row;
          const matched = fallbackMap.get(prefixed.toLowerCase());
          if (!matched?.best) return row;
          return {
            ...row,
            matchedBranchName: matched.best.branch,
            currentRemote: matched.best.remote,
            matchKey: matched.best.key,
            lastCommitAt: matched.best.lastCommitAt || 0,
            matchStatus: 'matched',
          };
        });
      }
    }

    const strippedTargets = [];
    for (const row of rows.value) {
      if (row.matchStatus !== 'missing') continue;
      const stripped = stripLeadingSeriesPrefix(row.branchName);
      if (!stripped) continue;
      strippedTargets.push(stripped);
    }
    const uniqueStrippedTargets = [...new Set(strippedTargets)];
    if (uniqueStrippedTargets.length) {
      const strippedResult = await window.electronAPI.resolveBestBranches(
        uniqueStrippedTargets,
        props.repoIndex
      );
      if (strippedResult?.ok) {
        const strippedMap = new Map();
        for (const item of strippedResult.data?.resolved ?? []) {
          strippedMap.set(String(item.input).toLowerCase(), item);
        }
        rows.value = rows.value.map((row) => {
          if (row.matchStatus !== 'missing') return row;
          const stripped = stripLeadingSeriesPrefix(row.branchName);
          if (!stripped) return row;
          const matched = strippedMap.get(stripped.toLowerCase());
          if (!matched?.best) return row;
          return {
            ...row,
            matchedBranchName: matched.best.branch,
            currentRemote: matched.best.remote,
            matchKey: matched.best.key,
            lastCommitAt: matched.best.lastCommitAt || 0,
            matchStatus: 'matched',
          };
        });
      }
    }

    const map = new Map();
    for (const row of rows.value) {
      map.set(row.rowNumber, row);
    }
    rowMap.value = map;

    const nextSelected = new Set();
    for (const rowNumber of selectedRows.value) {
      const row = map.get(rowNumber);
      if (isRowSelectable(row)) nextSelected.add(rowNumber);
    }
    selectedRows.value = nextSelected;
  } catch {
    rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'unknown' }));
  } finally {
    matching.value = false;
  }
};

const loadRows = async () => {
  if (loading.value) return;
  loading.value = true;
  error.value = '';

  try {
    await ensureAuth();
    const result = await window.electronAPI?.googleSheetsFetchRows?.({
      skipHeader: true
    });
    if (!result?.ok) {
      throw new Error(result?.message || '读取表格失败');
    }

    sheetTitle.value = result.sheetTitle || '';
    stopRow.value = result.stopRow || 0;
    sheetGid.value = Number(result.sheetGid ?? 0);
    rows.value = (result.rows || [])
      .slice()
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((row) => ({
        ...row,
        matchedBranchName: row.branchName,
        currentRemote: '',
        lastCommitAt: 0,
        matchStatus: 'checking',
      }));
    selectedRows.value = new Set();
    collapsedSeries.value = new Set();

    const map = new Map();
    for (const row of rows.value) {
      map.set(row.rowNumber, row);
    }
    rowMap.value = map;

    await refreshBranchMatchStatus();
  } catch (e) {
    error.value = e?.message || '加载失败';
    rows.value = [];
  } finally {
    loading.value = false;
  }
};

const logout = async () => {
  const result = await window.electronAPI?.googleSheetsLogout?.();
  if (result?.ok) {
    rows.value = [];
    selectedRows.value = new Set();
    rowMap.value = new Map();
    error.value = '已退出 Google 授权';
  }
};

const confirmSelection = () => {
  const branches = [];
  const sorted = [...selectedRows.value].sort((a, b) => a - b);
  for (const rowNumber of sorted) {
    const row = rowMap.value.get(rowNumber);
    if (!isRowSelectable(row)) continue;
    if (row?.matchedBranchName || row?.branchName || row?.projectName) {
      branches.push(row.matchedBranchName || row.branchName || row.projectName);
    }
  }
  emit('confirm', branches);
  close();
};

const writableRows = computed(() => {
  const sorted = [...selectedRows.value].sort((a, b) => a - b);
  return sorted
    .map((rowNumber) => rowMap.value.get(rowNumber))
    .filter((row) => row && row.matchedBranchName && row.matchStatus === 'matched');
});

const writableCount = computed(() => writableRows.value.length);
const canWriteBack = computed(() => writableCount.value > 0 && !loading.value && !matching.value);

const writeBackSelected = async () => {
  if (!canWriteBack.value || !window.electronAPI?.googleSheetsWriteBranches) return;
  writingBack.value = true;
  error.value = '';
  try {
    const updates = writableRows.value.map((row) => ({
      rowNumber: row.rowNumber,
      branchName: row.matchedBranchName,
    }));
    const result = await window.electronAPI.googleSheetsWriteBranches({
      sheetGid: sheetGid.value,
      updates,
    });
    if (!result?.ok) {
      throw new Error(result?.message || '回填失败');
    }
  } catch (e) {
    error.value = e?.message || '回填失败';
  } finally {
    writingBack.value = false;
  }
};

watch(
  () => props.visible,
  (open) => {
    if (open) {
      filterText.value = '';
      if (!hasLoadedOnce.value) {
        hasLoadedOnce.value = true;
        loadRows();
      }
    }
  }
);
</script>

<style scoped>
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  padding: 20px;
}

.sheet-panel {
  width: min(1360px, 100%);
  max-height: min(86vh, 860px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  min-width: 0;
}

.sheet-header,
.sheet-toolbar,
.sheet-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
}

.sheet-header {
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}

.header-text h3 {
  margin: 0;
  font-size: 18px;
  font-family: 'Microsoft YaHei', '微软雅黑', sans-serif;
}

.header-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.4;
  max-width: 52em;
}

.sheet-toolbar input {
  flex: 1;
  min-width: 0;
}

.sheet-body {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 0 12px 12px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.sheet-body::-webkit-scrollbar { display: none; }

.sheet-hint {
  margin: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 14px;
  font-family: 'Microsoft YaHei', '微软雅黑', sans-serif;
}

.sheet-hint.error {
  color: var(--danger);
}

.sheet-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 14px;
  font-family: 'Microsoft YaHei', '微软雅黑', sans-serif;
}

.sheet-table col.col-check { width: 36px; }
.sheet-table col.col-row { width: 44px; }
.sheet-table col.col-b { width: 22%; }
.sheet-table col.col-c { width: 22%; }
.sheet-table col.col-h { width: 13%; }
.sheet-table col.col-branch { width: 14%; }
.sheet-table col.col-remote { width: 11%; }
.sheet-table col.col-updated { width: 9%; }
.sheet-table col.col-match { width: 64px; }
.sheet-table col.col-src { width: 36px; }

.sheet-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--surface) 92%, var(--surface-muted));
}

.sheet-table th,
.sheet-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-table th {
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
}

.series-row {
  background: color-mix(in srgb, var(--surface-muted) 65%, transparent);
  cursor: pointer;
}

.series-cell {
  overflow: visible;
  white-space: nowrap;
}

.series-cell-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-weight: 600;
  color: var(--accent);
}

.series-select {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.series-arrow {
  display: inline-block;
  width: 18px;
  flex-shrink: 0;
}

.series-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.series-count {
  margin-left: 2px;
  color: var(--text-muted);
  font-weight: 500;
  flex-shrink: 0;
}

.sheet-table tbody tr {
  cursor: pointer;
  transition: background 0.15s ease;
}

.sheet-table tbody tr:nth-child(even) {
  background: color-mix(in srgb, var(--surface-muted) 35%, transparent);
}

.sheet-table tbody tr:hover,
.sheet-table tbody tr.selected {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.col-check {
  text-align: center;
  overflow: visible;
}

input[type='checkbox'] {
  width: 16px;
  height: 16px;
  margin: 0;
  border-radius: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

input[type='checkbox']:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.col-row {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.col-branch {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  color: var(--accent);
}

.col-remote {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  color: var(--text-muted);
}

.col-updated {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.col-src {
  color: var(--text-muted);
  text-align: center;
}

.col-match {
  text-align: center;
  overflow: visible;
  white-space: nowrap;
}

.match-badge {
  display: inline-block;
  max-width: 100%;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
}

.match-badge.matched {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 18%, transparent);
}

.match-badge.missing {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 18%, transparent);
}

.match-badge.ambiguous {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 18%, transparent);
}

.match-badge.no-repo,
.match-badge.unknown {
  color: var(--text-muted);
  background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
}

.match-badge.checking {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 18%, transparent);
}

.sheet-footer {
  justify-content: space-between;
  border-top: 1px solid var(--border);
}

.status-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.btn.sm {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 10px;
}
</style>
