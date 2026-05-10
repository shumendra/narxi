import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const workspaceRoot = process.cwd();
const envPaths = [
  path.join(workspaceRoot, '.env'),
  path.join(workspaceRoot, '.env.local'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

if (!process.env.SUPABASE_URL && process.env.VITE_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY) {
  if (process.env.SUPABASE_KEY) {
    process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_KEY;
  } else if (process.env.VITE_SUPABASE_ANON_KEY) {
    process.env.SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  }
}

const { runNormalizationNowForCli } = await import('../api/moderation.js');

const startedAt = new Date().toISOString();
console.log(`[normalize] started_at=${startedAt}`);

try {
  const result = await runNormalizationNowForCli({
    trigger: 'copilot_prompt',
    includeAliasBackfill: true,
  });

  const summary = {
    firstRun: Boolean(result?.firstRun),
    rawNameCount: Number(result?.rawNameCount) || 0,
    newRawNameCount: Number(result?.newRawNameCount) || 0,
    processedRawNameCount: Number(result?.processedRawNameCount) || 0,
    remainingRawNameCount: Number(result?.remainingRawNameCount) || 0,
    hasMore: Boolean(result?.hasMore),
    sqlSuccessCount: Number(result?.sqlSuccessCount) || 0,
    sqlErrorCount: Number(result?.sqlErrorCount) || 0,
    rpcAvailable: Boolean(result?.rpcAvailable),
    manualSqlLength: String(result?.manualSql || '').length,
    aliasesProcessed: Number(result?.aliasBackfill?.aliasesProcessed) || 0,
    pricesRowsScanned: Number(result?.aliasBackfill?.pricesRowsScanned) || 0,
    pendingRowsScanned: Number(result?.aliasBackfill?.pendingRowsScanned) || 0,
  };

  console.log('[normalize] summary');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.manualSqlLength > 0) {
    console.log('[normalize] note: manualSql generated because exec_sql RPC was unavailable.');
  }
} catch (error) {
  console.error('[normalize] failed');
  console.error(String(error?.message || error));
  process.exit(1);
}
