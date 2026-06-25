import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { shell } from 'electron';

const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
export const DEFAULT_SPREADSHEET_ID = '1UPs8r7YsazA5Zeaox7I9YDaQY4U0nj4NSSL-K6nPrWs';
export const DEFAULT_SHEET_GID = 0;
const OAUTH_LOOPBACK_PORT = 47292;
const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}/`;
const SHARED_TOKEN_DIR_NAME = 'KK';
const TOKEN_FILE_NAME = 'google-oauth-tokens.json';
const SESSION_FILE_NAME = 'google-oauth-session.json';

function httpsJson(method, requestUrl, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const options = {
      method,
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json);
          return;
        }
        const message =
          (json && (json.error?.message || json.error_description)) ||
          data ||
          `HTTP ${res.statusCode}`;
        reject(new Error(message));
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsFormPost(requestUrl, form) {
  const body = new URLSearchParams(form).toString();
  return httpsJson('POST', requestUrl, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  }, body);
}

export function findOAuthClientSecretPath(searchDirs) {
  for (const dir of searchDirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('client_secret') && name.endsWith('.json'));
    if (files.length > 0) {
      return path.join(dir, files[0]);
    }
  }
  return '';
}

export function loadOAuthClientCredentials(searchDirs) {
  const secretPath = findOAuthClientSecretPath(searchDirs);
  if (!secretPath) {
    throw new Error(
      '未找到 OAuth 客户端凭证文件（client_secret*.json），请放在应用目录或用户配置目录'
    );
  }

  const raw = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const installed = raw.installed || raw.web;
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error('OAuth 凭证文件格式不正确');
  }

  return {
    secretPath,
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    tokenUri: installed.token_uri || 'https://oauth2.googleapis.com/token',
    authUri: installed.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth',
  };
}

function getSharedTokenDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, SHARED_TOKEN_DIR_NAME);
}

function getSharedTokenPath() {
  return path.join(getSharedTokenDir(), TOKEN_FILE_NAME);
}

function getSessionPath(userDataDir) {
  return path.join(userDataDir, SESSION_FILE_NAME);
}

function ensureSharedTokenDir() {
  const dir = getSharedTokenDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isAppLoggedOut(userDataDir) {
  const sessionPath = getSessionPath(userDataDir);
  if (!fs.existsSync(sessionPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'))?.loggedOut === true;
  } catch {
    return false;
  }
}

function setAppLoggedOut(userDataDir, loggedOut) {
  const sessionPath = getSessionPath(userDataDir);
  if (loggedOut) {
    fs.writeFileSync(
      sessionPath,
      JSON.stringify({ loggedOut: true, at: Date.now() }, null, 2),
      'utf8'
    );
    return;
  }
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
}

function readTokenFile(tokenPath) {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

function migrateLegacyTokens(userDataDir) {
  const sharedPath = getSharedTokenPath();
  if (fs.existsSync(sharedPath)) return;

  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const legacyPaths = [
    path.join(userDataDir, TOKEN_FILE_NAME),
    path.join(base, 'kk-skinlab', TOKEN_FILE_NAME),
    path.join(base, 'kk-sync', TOKEN_FILE_NAME),
  ];

  let bestPath = '';
  let bestScore = -1;

  for (const legacyPath of legacyPaths) {
    const tokens = readTokenFile(legacyPath);
    if (!tokens?.refresh_token) continue;
    const score = Number(tokens.expiry_date || 0);
    if (score >= bestScore) {
      bestScore = score;
      bestPath = legacyPath;
    }
  }

  if (!bestPath) return;

  ensureSharedTokenDir();
  fs.copyFileSync(bestPath, sharedPath);
}

export function loadStoredTokens(userDataDir) {
  if (isAppLoggedOut(userDataDir)) return null;

  migrateLegacyTokens(userDataDir);
  return readTokenFile(getSharedTokenPath());
}

function saveStoredTokens(_userDataDir, tokens) {
  ensureSharedTokenDir();
  fs.writeFileSync(getSharedTokenPath(), JSON.stringify(tokens, null, 2), 'utf8');
}

export function clearStoredTokens(userDataDir) {
  setAppLoggedOut(userDataDir, true);
}

export function getGoogleAuthStatus(userDataDir) {
  const tokens = loadStoredTokens(userDataDir);
  return {
    authenticated: Boolean(tokens?.refresh_token || tokens?.access_token),
    hasRefreshToken: Boolean(tokens?.refresh_token),
    email: tokens?.email || '',
    loggedOutLocally: isAppLoggedOut(userDataDir),
  };
}

async function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', OAUTH_REDIRECT_URI);
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (error) {
        res.end('<html><body><h3>授权失败</h3><p>可以关闭此页面返回应用。</p></body></html>');
        server.close();
        reject(new Error(`Google 授权被拒绝: ${error}`));
        return;
      }

      if (!code) {
        res.end('<html><body><h3>未收到授权码</h3></body></html>');
        return;
      }

      res.end(
        '<html><body><h3>授权成功</h3><p>可以关闭此页面并返回 KK Sync。</p></body></html>'
      );
      server.close();
      resolve(code);
    });

    server.on('error', reject);
    server.listen(OAUTH_LOOPBACK_PORT, '127.0.0.1', () => {});
    setTimeout(() => {
      server.close();
      reject(new Error('Google 授权超时，请重试'));
    }, 5 * 60 * 1000);
  });
}

export async function loginWithGoogle(userDataDir, searchDirs) {
  const creds = loadOAuthClientCredentials(searchDirs);
  migrateLegacyTokens(userDataDir);
  const existingTokens = readTokenFile(getSharedTokenPath());
  setAppLoggedOut(userDataDir, false);

  const authUrl = new URL(creds.authUri);
  authUrl.searchParams.set('client_id', creds.clientId);
  authUrl.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  if (!existingTokens?.refresh_token) {
    authUrl.searchParams.set('prompt', 'consent');
  }
  authUrl.searchParams.set('include_granted_scopes', 'true');

  const codePromise = waitForOAuthCode();
  await shell.openExternal(authUrl.toString());
  const code = await codePromise;

  const tokenResponse = await httpsFormPost(creds.tokenUri, {
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const tokens = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || existingTokens?.refresh_token || '',
    expiry_date: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
    scope: tokenResponse.scope || SCOPES,
    token_type: tokenResponse.token_type || 'Bearer',
  };

  if (!tokens.refresh_token) {
    throw new Error('未获取到 refresh_token，请在 Google 账号授权页移除本应用后重新登录');
  }

  saveStoredTokens(userDataDir, tokens);
  return { ok: true, message: 'Google 账号已授权' };
}

async function refreshAccessToken(userDataDir, searchDirs) {
  const creds = loadOAuthClientCredentials(searchDirs);
  const tokens = loadStoredTokens(userDataDir);
  if (!tokens?.refresh_token) {
    throw new Error('尚未登录 Google，请先授权');
  }

  const tokenResponse = await httpsFormPost(creds.tokenUri, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const nextTokens = {
    ...tokens,
    access_token: tokenResponse.access_token,
    expiry_date: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
    scope: tokenResponse.scope || tokens.scope,
    token_type: tokenResponse.token_type || tokens.token_type || 'Bearer',
  };
  saveStoredTokens(userDataDir, nextTokens);
  return nextTokens.access_token;
}

async function getValidAccessToken(userDataDir, searchDirs) {
  const tokens = loadStoredTokens(userDataDir);
  if (!tokens?.refresh_token && !tokens?.access_token) {
    throw new Error('尚未登录 Google，请先授权');
  }

  if (tokens.access_token && tokens.expiry_date && Date.now() < tokens.expiry_date - 60_000) {
    return tokens.access_token;
  }

  return refreshAccessToken(userDataDir, searchDirs);
}

async function sheetsRequest(accessToken, requestPath) {
  return httpsJson('GET', `https://sheets.googleapis.com/v4${requestPath}`, {
    Authorization: `Bearer ${accessToken}`,
  });
}

async function sheetsBatchUpdate(accessToken, spreadsheetId, payload) {
  return httpsJson(
    'POST',
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    JSON.stringify(payload)
  );
}

async function resolveSheetTitle(spreadsheetId, sheetGid, accessToken) {
  const meta = await sheetsRequest(
    accessToken,
    `/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`
  );
  const sheets = meta?.sheets || [];
  const gid = Number(sheetGid);
  const matched = sheets.find((item) => item?.properties?.sheetId === gid);
  const title = matched?.properties?.title || sheets[0]?.properties?.title;
  if (!title) {
    throw new Error('无法读取工作表信息');
  }
  return title;
}

function encodeSheetRange(sheetTitle, rangeA1 = 'A1:H539') {
  const escapedTitle = String(sheetTitle).replace(/'/g, "''");
  return encodeURIComponent(`'${escapedTitle}'!${rangeA1}`);
}

function extractCellText(cell) {
  if (!cell) return '';
  const formattedText =
    cell.formattedValue != null && cell.formattedValue !== ''
      ? sanitizeBranchText(cell.formattedValue)
      : '';
  const uv = cell.userEnteredValue;
  const rawStringText = uv?.stringValue != null ? sanitizeBranchText(uv.stringValue) : '';

  // 某些单元格 formattedValue 会出现 U+FFFD（�）乱码，优先回退到原始 stringValue
  if (formattedText) {
    if (formattedText.includes('\uFFFD') && rawStringText) {
      return rawStringText;
    }
    return formattedText;
  }

  if (!uv) return '';
  if (rawStringText) return rawStringText;
  if (uv.numberValue != null) return String(uv.numberValue).trim();
  if (uv.boolValue != null) return String(uv.boolValue).trim();
  return '';
}

function rowValuesToCells(rowValues, startColumn = 0, columnCount = 8) {
  const cells = new Array(columnCount).fill('');
  for (let i = 0; i < (rowValues?.length ?? 0); i += 1) {
    const colIndex = startColumn + i;
    if (colIndex < 0 || colIndex >= columnCount) continue;
    cells[colIndex] = extractCellText(rowValues[i]);
  }
  return cells;
}

/**
 * 使用 GridData 读取，保留真实行号（values API 会省略空行导致行号错位）
 */
async function fetchSheetRowEntries(spreadsheetId, sheetTitle, accessToken, rangeA1) {
  const rangeParam = encodeSheetRange(sheetTitle, rangeA1);
  const data = await sheetsRequest(
    accessToken,
    `/spreadsheets/${spreadsheetId}?ranges=${rangeParam}&includeGridData=true&fields=sheets(data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue))))`
  );

  const gridData = data?.sheets?.[0]?.data?.[0];
  if (!gridData) return [];

  const startRow = gridData.startRow ?? 0;
  const startColumn = gridData.startColumn ?? 0;
  const rowDataList = gridData.rowData || [];
  const entries = [];

  for (let i = 0; i < rowDataList.length; i += 1) {
    entries.push({
      sheetRowNumber: startRow + i + 1,
      cells: rowValuesToCells(rowDataList[i]?.values, startColumn, 8),
    });
  }

  return entries;
}

// B 备注/分支、C 项目名(备选分支)、F 分区说明、H 所属系列
const SHEET_COL = {
  B: 1,
  C: 2,
  F: 5,
  H: 7,
};

const DEFAULT_STOP_ROW = 540;
const STOP_MARKER = '停止代理';
/** 停止代理区首项：C 列「MOM777 + 合并服务器2」，该行及以下不读取 */
const STOP_SECTION_PROJECT_C = 'mom777合并服务器2';

// 分支名 token：1x-tz3、wg-peixe2、we-xxx 等
const BRANCH_TOKEN_PATTERNS = [
  /\d+x-[a-z0-9][a-z0-9._-]*/gi,
  /[a-z][a-z0-9]*-[a-z0-9][a-z0-9._-]*/gi,
  /[a-z0-9]+(?:-[a-z0-9._-]+)+/gi,
];

function sheetCell(cells, index) {
  return String(cells?.[index] ?? '').trim();
}

function sanitizeBranchText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[‐‑‒–—―－﹣]/g, '-')
    .trim();
}

export function normalizeBranchNameFromC(name) {
  return sanitizeBranchText(name)
    .trim()
    .replace(/[\s\u3000\r\n]+/g, '')
    .toLowerCase();
}

function normalizeMarkerText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/\u3000/g, '');
}

function cellContainsStopMarker(text) {
  const normalized = normalizeMarkerText(text);
  if (!normalized) return false;
  return normalized.includes(STOP_MARKER);
}

/** F/A/B 列出现「停止代理」说明行（浏览器中折叠分组的标题行） */
export function isStopSectionDividerRow(cells) {
  const markerCols = [0, SHEET_COL.B, SHEET_COL.F];
  for (const col of markerCols) {
    if (cellContainsStopMarker(sheetCell(cells, col))) return true;
  }
  return false;
}

/** 停止代理区首行：C 列为 MOM777 / 合并服务器2（换行或空格均可） */
export function isStopSectionStartRow(cells) {
  const rawC = sheetCell(cells, SHEET_COL.C);
  if (!rawC) return false;
  return normalizeBranchNameFromC(rawC) === STOP_SECTION_PROJECT_C;
}

function isSheetStopBoundaryRow(cells) {
  return isStopSectionDividerRow(cells) || isStopSectionStartRow(cells);
}

export function extractBranchFromB(text) {
  const raw = sanitizeBranchText(text);
  if (!raw) return '';

  const matches = [];
  for (const pattern of BRANCH_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    const found = raw.match(pattern);
    if (found?.length) matches.push(...found);
  }

  if (matches.length) {
    const normalized = matches.map((item) => item.toLowerCase());
    return normalized[normalized.length - 1];
  }

  if (/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) {
    return raw.toLowerCase();
  }

  return '';
}

function looksLikePlainBranchText(text) {
  if (!text) return false;
  // 仅允许英文数字/常见分支分隔符，避免把中文项目名整段当分支
  return /^[a-z0-9][a-z0-9._/\-\s\u3000]*$/i.test(text);
}

export function resolveBranchName(cells) {
  const rawB = sheetCell(cells, SHEET_COL.B);
  const rawC = sheetCell(cells, SHEET_COL.C);
  const fromB = extractBranchFromB(rawB);

  if (fromB) {
    return {
      branchName: fromB,
      branchSource: 'B',
      branchRawB: rawB,
      branchRawC: rawC,
    };
  }

  const fromCToken = extractBranchFromB(rawC);
  if (fromCToken) {
    return {
      branchName: fromCToken,
      branchSource: 'C',
      branchRawB: rawB,
      branchRawC: rawC,
    };
  }

  const sanitizedC = sanitizeBranchText(rawC);
  if (looksLikePlainBranchText(sanitizedC)) {
    const fromC = normalizeBranchNameFromC(sanitizedC);
    if (fromC) {
      return {
        branchName: fromC,
        branchSource: 'C',
        branchRawB: rawB,
        branchRawC: rawC,
      };
    }
  }

  return null;
}

export function resolveStopRowNumber(entries) {
  // 硬上限：第 540 行（含）及以下永不读取
  let stopRowNumber = DEFAULT_STOP_ROW;

  for (const entry of entries) {
    if (entry.sheetRowNumber >= DEFAULT_STOP_ROW) break;

    if (isSheetStopBoundaryRow(entry.cells)) {
      stopRowNumber = Math.min(stopRowNumber, entry.sheetRowNumber);
      break;
    }
  }

  return stopRowNumber;
}

function isSheetHeaderRow(cells) {
  const joined = (cells || []).map((cell) => String(cell ?? '')).join('\t');
  return /项目名|分支|所属/.test(joined);
}

function buildRowPreview(branch) {
  const parts = [branch.branchName];
  if (branch.series) parts.push(branch.series);
  if (branch.branchSource === 'B' && branch.branchRawB && branch.branchRawB !== branch.branchName) {
    parts.push(`B:${branch.branchRawB}`);
  } else if (branch.branchSource === 'C' && branch.branchRawC) {
    parts.push(`C:${branch.branchRawC}`);
  }
  return parts.join(' | ');
}

function isDemoProjectRow(cells) {
  const rawC = sheetCell(cells, SHEET_COL.C);
  if (!rawC) return false;
  return normalizeBranchNameFromC(rawC).includes('demo');
}

function groupRowsBySeries(rows) {
  const groups = [];
  const groupMap = new Map();

  for (const row of rows) {
    const seriesName = row.series || '未分类';
    if (!groupMap.has(seriesName)) {
      const group = { name: seriesName, rows: [] };
      groupMap.set(seriesName, group);
      groups.push(group);
    }
    groupMap.get(seriesName).rows.push(row);
  }

  return groups;
}

function parseSheetDataRows(entries, options = {}) {
  const skipHeader = options.skipHeader !== false;
  const stopRowNumber = resolveStopRowNumber(entries);
  const rows = [];

  for (const entry of entries) {
    if (entry.sheetRowNumber >= stopRowNumber) continue;

    const { cells } = entry;
    if (!cells?.some((cell) => cell)) continue;
    // 仅前几行可能是表头，避免把正文里含“分支”等文字的行误判并跳过
    if (skipHeader && entry.sheetRowNumber <= 3 && isSheetHeaderRow(cells)) continue;
    if (isDemoProjectRow(cells)) continue;

    const branch = resolveBranchName(cells);
    if (!branch) continue;

    const series = sheetCell(cells, SHEET_COL.H) || '未分类';

    rows.push({
      rowNumber: entry.sheetRowNumber,
      branchName: branch.branchName,
      projectName: branch.branchName,
      branchSource: branch.branchSource,
      branchRawB: branch.branchRawB,
      branchRawC: branch.branchRawC,
      series,
      preview: buildRowPreview({ ...branch, series }),
      cells,
    });
  }

  rows.sort((a, b) => a.rowNumber - b.rowNumber);

  return rows;
}

export async function fetchSpreadsheetRows(userDataDir, searchDirs, options = {}) {
  const spreadsheetId = options.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const sheetGid = options.sheetGid ?? DEFAULT_SHEET_GID;
  const rangeA1 = options.range || `A1:H${DEFAULT_STOP_ROW - 1}`;
  const skipHeader = options.skipHeader !== false;

  const accessToken = await getValidAccessToken(userDataDir, searchDirs);
  const sheetTitle = await resolveSheetTitle(spreadsheetId, sheetGid, accessToken);
  const entries = await fetchSheetRowEntries(spreadsheetId, sheetTitle, accessToken, rangeA1);
  const stopRowNumber = resolveStopRowNumber(entries);
  const rows = parseSheetDataRows(entries, { skipHeader });
  const groups = groupRowsBySeries(rows);

  return {
    ok: true,
    spreadsheetId,
    sheetTitle,
    sheetGid,
    stopRow: stopRowNumber,
    rows,
    groups,
    total: rows.length,
    groupCount: groups.length,
  };
}

export async function writeSpreadsheetBranchNames(userDataDir, searchDirs, options = {}) {
  const spreadsheetId = options.spreadsheetId || DEFAULT_SPREADSHEET_ID;
  const sheetGid = options.sheetGid ?? DEFAULT_SHEET_GID;
  const updates = Array.isArray(options.updates) ? options.updates : [];
  if (!updates.length) {
    return { ok: false, message: '没有可回填的数据' };
  }

  const accessToken = await getValidAccessToken(userDataDir, searchDirs);
  const sheetTitle = await resolveSheetTitle(spreadsheetId, sheetGid, accessToken);
  const requests = updates
    .map((item) => {
      const rowNumber = Number(item?.rowNumber);
      const branchName = String(item?.branchName || '').trim();
      if (!Number.isInteger(rowNumber) || rowNumber <= 0 || !branchName) return null;
      return {
        updateCells: {
          range: {
            sheetId: Number(sheetGid),
            startRowIndex: rowNumber - 1,
            endRowIndex: rowNumber,
            startColumnIndex: SHEET_COL.B,
            endColumnIndex: SHEET_COL.B + 1,
          },
          rows: [
            {
              values: [
                {
                  userEnteredValue: {
                    stringValue: branchName,
                  },
                },
              ],
            },
          ],
          fields: 'userEnteredValue',
        },
      };
    })
    .filter(Boolean);

  if (!requests.length) {
    return { ok: false, message: '没有可回填的有效行' };
  }

  await sheetsBatchUpdate(accessToken, spreadsheetId, { requests });
  return {
    ok: true,
    spreadsheetId,
    sheetTitle,
    sheetGid,
    updated: requests.length,
  };
}
