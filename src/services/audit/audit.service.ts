import { address } from '@solana/addresses';
import {
  sleep,
  rpcCall,
  fetchJson,
  ratioToPercentString,
  bigintRatioToNumber,
  runBoundedPool,
} from '../../core/utils.js';
import { Context, MintSignals, GoPlusTokenSignals, BubbleMapsSignals } from '../../types/index.js';

/**
 * Checks if a value represents a truthy flag in the context of security API responses.
 * @param value - The value to check.
 * @returns True if the value is considered truthy.
 */
export function isTruthyFlag(value: any): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 0)
    return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'null', 'none', 'no'].includes(normalized);
}

function getErrorMessage(error: any): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Fetches mint-level signals from the Solana RPC, including supply, authorities, and top holder concentration.
 */
export async function getMintSignals(
  ctx: Context,
  mint: string,
  options: { priority?: number } = {}
): Promise<MintSignals> {
  const priority = options.priority;
  const mintAddress = address(mint);
  let accountInfo: any = null;
  let parsed: any = null;
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.floor(Number(ctx.config.mintSignalMaxAttempts || 3)));
  const retryDelayMs = Math.max(1, Math.floor(Number(ctx.config.mintSignalRetryDelayMs || 750)));

  while (attempts < maxAttempts) {
    try {
      accountInfo = await rpcCall(
        ctx,
        'getAccountInfo',
        [
          mintAddress,
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
          },
        ],
        { priority }
      );
      parsed = accountInfo.value?.data?.parsed;
      if (parsed && (parsed.info?.type === 'mint' || parsed.type === 'mint')) break;
    } catch (e) {
      if (attempts === maxAttempts - 1) throw e;
    }
    attempts++;
    if (attempts < maxAttempts) {
      await sleep(retryDelayMs * attempts);
    }
  }

  const isMint = parsed && (parsed.info?.type === 'mint' || parsed.type === 'mint');
  if (!isMint) {
    throw new Error(
      `RPC Indexing Lag: Mint ${mint} did not return parsed data after ${maxAttempts} attempts.`
    );
  }

  const mintInfo = parsed.info;
  if (!mintInfo) {
    throw new Error(
      `RPC parsed mint info missing for ${mint}; refusing to audit incomplete mint data.`
    );
  }
  let largestAccounts: any;
  try {
    largestAccounts = await rpcCall(
      ctx,
      'getTokenLargestAccounts',
      [
        mintAddress,
        {
          commitment: 'confirmed',
        },
      ],
      { priority }
    );
  } catch (e) {
    const message = getErrorMessage(e);
    if (message.includes('not a Token mint')) {
      throw new Error(`RPC Indexing Lag: ${mint} is not yet recognized as a token mint.`);
    }
    throw e;
  }
  const supplyRaw = BigInt(mintInfo.supply || '0');
  const topAccounts = (largestAccounts.value || []).slice(0, 5).map((account: any) => {
    const rawAmount = BigInt(account.amount || '0');
    return {
      address: account.address,
      rawAmount,
      share: bigintRatioToNumber(rawAmount, supplyRaw),
    };
  });

  const top1Share = topAccounts[0]?.share || 0;
  const top5Share = topAccounts
    .slice(0, 5)
    .reduce((sum: number, account: any) => sum + account.share, 0);

  const accountAddresses = topAccounts.map((a: any) => address(a.address));
  let ownersInfo: any = null;
  try {
    ownersInfo = await rpcCall(
      ctx,
      'getMultipleAccounts',
      [
        accountAddresses,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
        },
      ],
      { priority, cacheTtlMs: 10000 }
    );
  } catch (e) {
    ctx.logger(`getMultipleAccounts failed for ${mint}: ${getErrorMessage(e)}`, 'warn');
  }

  const ownerDetails = topAccounts.map((account: any, index: number) => {
    const info = ownersInfo?.value?.[index];
    if (info) {
      const owner = info.data?.parsed?.info?.owner || null;
      return { ...account, owner };
    }
    return { ...account, owner: null, ownerLookupError: 'Account info not found (possible lag)' };
  });

  return {
    decimals: Number(mintInfo.decimals || 0),
    supplyRaw,
    mintAuthority: mintInfo.mintAuthority || null,
    freezeAuthority: mintInfo.freezeAuthority || null,
    top1Share,
    top5Share,
    topAccounts: ownerDetails,
  };
}

/**
 * Fetches token security signals from GoPlus.
 */
export async function fetchGoPlusTokenSignals(
  ctx: Context,
  mint: string
): Promise<GoPlusTokenSignals | null> {
  if (!ctx.config.goPlusAccessToken) return null;
  const timeoutMs = 8000;
  try {
    const url = `${ctx.config.goPlusBaseUrl}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`;
    const payload = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` },
      timeoutMs,
    });
    const record =
      payload?.result?.[mint] ||
      payload?.result?.[mint.toLowerCase()] ||
      payload?.data?.[mint] ||
      payload?.data?.[mint.toLowerCase()] ||
      null;
    if (!record) return { status: 'no_data', blockers: [], notes: [] };

    const blockers: string[] = [];
    const notes: string[] = [];
    if (isTruthyFlag(record.is_mintable)) blockers.push('GoPlus reports token is mintable');
    if (isTruthyFlag(record.is_freezable)) blockers.push('GoPlus reports token is freezable');
    if (isTruthyFlag(record.transfer_fee_upgradable))
      notes.push('GoPlus reports transfer fee is upgradable');
    if (isTruthyFlag(record.non_transferable))
      blockers.push('GoPlus reports token is non-transferable');
    if (isTruthyFlag(record.default_account_state))
      notes.push('GoPlus reports custom default account state');
    if (isTruthyFlag(record.trusted_token) === false && record.trusted_token !== undefined)
      notes.push('GoPlus does not mark the token as trusted');

    return { status: 'ok', blockers, notes, raw: record };
  } catch (e: any) {
    const message = getErrorMessage(e);
    const status = message.includes('timed out') ? 'timeout' : 'error';
    ctx.logger(`GoPlus token security skipped for ${mint} (${status}): ${message}`, 'warn');
    return { status, blockers: [], notes: [], error: message };
  }
}

/**
 * Fetches address security signals from GoPlus for a batch of addresses.
 * @param ctx - The application context.
 * @param addresses - Array of addresses to check.
 * @returns Array of malicious address records found.
 */
export async function fetchGoPlusAddressSignals(ctx: Context, addresses: string[]): Promise<any[]> {
  if (!ctx.config.goPlusAccessToken) return [];
  const startedAt = Date.now();
  const results = await runBoundedPool(
    addresses,
    async (addr) => {
      try {
        const url = `${ctx.config.goPlusBaseUrl}/address_security/${addr}?chain_id=solana`;
        const payload = await fetchJson(url, {
          headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` },
          timeoutMs: 5000,
        });
        const resultRecord = payload?.result;
        const dataRecord = payload?.data;
        const record =
          resultRecord?.[addr] ||
          resultRecord?.[addr.toLowerCase()] ||
          dataRecord?.[addr] ||
          dataRecord?.[addr.toLowerCase()] ||
          (resultRecord && !Array.isArray(resultRecord) ? resultRecord : null) ||
          (dataRecord && !Array.isArray(dataRecord) ? dataRecord : null);
        if (record && isMaliciousGoPlusAddressRecord(record)) return { address: addr, record };
      } catch (e) {
        ctx.logger(`GoPlus address security skipped for ${addr}: ${getErrorMessage(e)}`, 'warn');
      }
      return null;
    },
    { concurrency: ctx.config.ownerAuditParallelism || 1 }
  );
  ctx.logger(
    `GoPlus owner checks completed: count=${addresses.length}, concurrency=${ctx.config.ownerAuditParallelism || 1}, ownerCheckMs=${Date.now() - startedAt}`,
    'debug',
    { console: false }
  );
  return results
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);
}

/**
 * Determines if a GoPlus address record indicates malicious activity.
 * @param record - The GoPlus address security record.
 * @returns True if malicious signals are found.
 */
function isMaliciousGoPlusAddressRecord(record: any): boolean {
  const maliciousFields = [
    'malicious_address',
    'phishing_activities',
    'fake_token',
    'blackmail_activities',
    'honeypot_related_address',
    'blacklist_doubt',
    'stealing_attack',
    'fake_kyc',
    'malicious_mining_activities',
    'darkweb_transactions',
    'cybercrime',
    'money_laundering',
    'financial_crime',
    'mixer',
    'scam',
    'sanctioned',
    'gas_abuse',
    'reinit',
    'fake_standard_interface',
  ];
  const maliciousBehaviors = Array.isArray(record.malicious_behavior)
    ? record.malicious_behavior
    : [];

  return (
    maliciousFields.some((field) => isTruthyFlag(record[field])) ||
    maliciousBehaviors.some((field: any) => maliciousFields.includes(String(field)))
  );
}

/**
 * Fetches decentralization and cluster signals from BubbleMaps.
 */
export async function fetchBubbleMapsSignals(
  ctx: Context,
  mint: string
): Promise<BubbleMapsSignals | null> {
  if (!ctx.config.bubbleMapsApiKey) return null;
  const timeoutMs = 12000;
  try {
    const params = new URLSearchParams({
      return_clusters: 'true',
      return_decentralization_score: 'true',
      return_nodes: 'false',
      use_magic_nodes: 'true',
    });
    const url = `${ctx.config.bubbleMapsBaseUrl}/maps/solana/${mint}?${params.toString()}`;
    const payload = await fetchJson(url, {
      headers: { 'X-ApiKey': ctx.config.bubbleMapsApiKey },
      timeoutMs,
    });
    const largestClusterShare =
      Array.isArray(payload?.clusters) && payload.clusters.length > 0
        ? Number(payload.clusters[0].share || 0)
        : null;
    const blockers: string[] = [];
    if (
      payload?.decentralization_score != null &&
      Number(payload.decentralization_score) < ctx.config.minBubbleMapsScore
    ) {
      blockers.push(
        `BubbleMaps decentralization score ${payload.decentralization_score} is below ${ctx.config.minBubbleMapsScore}`
      );
    }
    if (
      largestClusterShare != null &&
      largestClusterShare > ctx.config.maxBubbleMapsLargestClusterShare
    ) {
      blockers.push(
        `BubbleMaps largest cluster share ${ratioToPercentString(largestClusterShare)} is above ${ratioToPercentString(ctx.config.maxBubbleMapsLargestClusterShare)}`
      );
    }
    return {
      status: 'ok',
      blockers,
      score: payload?.decentralization_score ?? null,
      largestClusterShare,
      raw: payload,
    };
  } catch (e: any) {
    const message = getErrorMessage(e);
    const status = message.includes('timed out') ? 'timeout' : 'error';
    ctx.logger(`BubbleMaps skipped for ${mint} (${status}): ${message}`, 'warn');
    return { status, blockers: [], score: null, largestClusterShare: null, error: message };
  }
}
