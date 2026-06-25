<template>
  <teleport to="body">
    <div v-if="visible" class="sheet-overlay" @click.self="close">
      <div class="sheet-panel">
        <header class="sheet-header">
          <div class="header-text">
            <h3>从 Google 表格选择分支</h3>
            <p class="header-sub">对照表格：行号与 B / C / H 列一致，仅显示第 540 行「停止代理」之前</p>
          </div>
          <button type="button" class="btn ghost sm" @click="close">✕</button>
        </header>

        <div class="sheet-toolbar">
          <input
            v-model.trim="filterText"
            type="search"
            placeholder="筛选行号、B/C/H 列、分支名…"
          />
          <button
            type="button"
            class="btn ghost sm"
            :disabled="loading"
            title="重新加载"
            @click="loadRows"
          >
            🔄
          </button>
          <button type="button" class="btn ghost sm" @click="logout">退出 Google</button>
        </div>

        <div class="sheet-body scroll-thin">
          <p v-if="loading" class="sheet-hint">正在读取 Google 表格…</p>
          <p v-else-if="error" class="sheet-hint error">{{ error }}</p>
          <p v-else-if="!filteredRows.length" class="sheet-hint">暂无符合条件的分支</p>

          <table v-else class="sheet-table">
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
                <th class="col-h">H 系列</th>
                <th class="col-branch">分支名</th>
                <th class="col-match">匹配</th>
                <th class="col-src">来源</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in filteredRows"
                :key="row.rowNumber"
                :class="{ selected: selectedRows.has(row.rowNumber) }"
                @click="toggleRow(row)"
              >
                <td class="col-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selectedRows.has(row.rowNumber)"
                    @change="toggleRow(row)"
                  />
                </td>
                <td class="col-row">{{ row.rowNumber }}</td>
                <td class="col-b" :title="row.branchRawB">{{ row.branchRawB || '—' }}</td>
                <td class="col-c" :title="row.branchRawC">{{ row.branchRawC || '—' }}</td>
                <td class="col-h" :title="row.series">{{ row.series || '—' }}</td>
                <td class="col-branch">{{ row.branchName }}</td>
                <td class="col-match">
                  <span class="match-badge" :class="row.matchStatus">{{ matchStatusLabel(row.matchStatus) }}</span>
                </td>
                <td class="col-src">{{ row.branchSource }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="sheet-footer">
          <span class="status-text">{{ statusText }}</span>
          <div class="footer-actions">
            <button type="button" class="btn ghost sm" @click="close">取消</button>
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
  repoIndex: { type: Number, default: 1 },
  remoteName: { type: String, default: '' }
});

const emit = defineEmits(['update:visible', 'confirm']);

const loading = ref(false);
const error = ref('');
const filterText = ref('');
const rows = ref([]);
const sheetTitle = ref('');
const stopRow = ref(0);
const selectedRows = ref(new Set());
const rowMap = ref(new Map());
const matchChecking = ref(false);

const statusText = computed(() => {
  if (loading.value) return '正在加载…';
  if (matchChecking.value) return '正在匹配远程分支…';
  if (error.value) return error.value;
  const rowCount = rows.value.length;
  const title = sheetTitle.value ? `工作表：${sheetTitle.value} | ` : '';
  const stopHint = stopRow.value ? `读取至第 ${stopRow.value - 1} 行（不含） | ` : '';
  const matched = rows.value.filter((row) => row.matchStatus === 'matched').length;
  const missing = rows.value.filter((row) => row.matchStatus === 'missing').length;
  const matchHint = props.remoteName ? `匹配 ${matched} · 未找到 ${missing} | ` : '';
  return `${title}${stopHint}${matchHint}共 ${rowCount} 项 · 已选 ${selectedRows.value.size} 项`;
});

const matchStatusLabel = (status) => {
  switch (status) {
    case 'matched':
      return '已匹配';
    case 'missing':
      return '未找到';
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
      row.branchSource,
      row.matchStatus,
      row.preview
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(keyword);
  });
});

const isAllFilteredSelected = computed(() => {
  if (!filteredRows.value.length) return false;
  return filteredRows.value.every((row) => selectedRows.value.has(row.rowNumber));
});

const isPartialFilteredSelected = computed(() => {
  if (!filteredRows.value.length) return false;
  const selectedCount = filteredRows.value.filter((row) => selectedRows.value.has(row.rowNumber)).length;
  return selectedCount > 0 && selectedCount < filteredRows.value.length;
});

const close = () => {
  emit('update:visible', false);
};

const toggleRow = (row) => {
  const next = new Set(selectedRows.value);
  if (next.has(row.rowNumber)) next.delete(row.rowNumber);
  else next.add(row.rowNumber);
  selectedRows.value = next;
};

const toggleSelectAllFiltered = (event) => {
  const next = new Set(selectedRows.value);
  if (event.target.checked) {
    filteredRows.value.forEach((row) => next.add(row.rowNumber));
  } else {
    filteredRows.value.forEach((row) => next.delete(row.rowNumber));
  }
  selectedRows.value = next;
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

  if (!props.remoteName || !window.electronAPI?.checkRemoteBranches) {
    rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'no-repo' }));
    return;
  }

  matchChecking.value = true;
  rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'checking' }));

  try {
    const uniqueNames = [...new Set(rows.value.map((row) => row.branchName).filter(Boolean))];
    const result = await window.electronAPI.checkRemoteBranches(
      uniqueNames,
      props.repoIndex,
      props.remoteName
    );

    if (!result?.ok) {
      rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'unknown' }));
      return;
    }

    const existsSet = new Set(
      (result.data?.exists ?? []).map((name) => String(name).toLowerCase())
    );
    rows.value = rows.value.map((row) => ({
      ...row,
      matchStatus: existsSet.has(String(row.branchName).toLowerCase()) ? 'matched' : 'missing'
    }));

    const map = new Map();
    for (const row of rows.value) {
      map.set(row.rowNumber, row);
    }
    rowMap.value = map;
  } catch {
    rows.value = rows.value.map((row) => ({ ...row, matchStatus: 'unknown' }));
  } finally {
    matchChecking.value = false;
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
    rows.value = (result.rows || [])
      .slice()
      .sort((a, b) => a.rowNumber - b.rowNumber)
      .map((row) => ({ ...row, matchStatus: 'checking' }));
    selectedRows.value = new Set();

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
    if (row?.branchName || row?.projectName) {
      branches.push(row.branchName || row.projectName);
    }
  }
  emit('confirm', branches);
  close();
};

watch(
  () => props.visible,
  (open) => {
    if (open) {
      filterText.value = '';
      loadRows();
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
  width: min(1160px, 100%);
  max-height: min(86vh, 860px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
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
  font-size: 16px;
}

.header-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.sheet-toolbar input {
  flex: 1;
  min-width: 0;
}

.sheet-body {
  flex: 1;
  min-height: 280px;
  overflow: auto;
  padding: 0 12px 12px;
}

.sheet-hint {
  margin: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.sheet-hint.error {
  color: var(--danger);
}

.sheet-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.sheet-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--surface) 92%, var(--surface-muted));
}

.sheet-table th,
.sheet-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}

.sheet-table th {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
  white-space: nowrap;
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
  width: 36px;
  text-align: center;
}

.col-row {
  width: 52px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.col-b,
.col-c {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-h {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-branch {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  color: var(--accent);
  white-space: nowrap;
}

.col-src {
  width: 44px;
  color: var(--text-muted);
  text-align: center;
}

.col-match {
  width: 72px;
  text-align: center;
}

.match-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
}

.match-badge.matched {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 18%, transparent);
}

.match-badge.missing {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 18%, transparent);
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
