'use strict';

// Security and concentration audit helpers: inspects mint/account ownership signals
// and integrates GoPlus/BubbleMaps checks to enrich candidate risk decisions.

const { address } = require('@solana/addresses');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  rpcCall,
  fetchJson,
  ratioToPercentString,
  bigintRatioToNumber,
  runBoundedPool,
} = require('./utils');

/**
 * Checks if a value represents a truthy flag in the context of security API responses.
 * @param {any} value - The value to check.
 * @returns {boolean} True if the value is considered truthy.
 */
function isTruthyFlag(value) {
  if (value === undefined || value === null || value === '' || value === false || value === 0)
    return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'null', 'none', 'no'].includes(normalized);
}

function getErrorMessage(error) {
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
 * @param {Object} ctx - The application context.
 * @param {string} mint - The token mint address.
 * @param {Object} [options={}] - Call options.
 * @param {number} [options.priority] - Priority level.
 * @returns {Promise<Object>} Mint signals (decimals, supplyRaw, mintAuthority, freezeAuthority, concentration stats).
 * @throws {Error} If the mint data cannot be retrieved or is not a token mint.
 */
async function getMintSignals(ctx, mint, options = {}) {
  const priority = options.priority;
  const mintAddress = address(mint);
  let accountInfo = null;
  let parsed = null;
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.floor(Number(ctx.config.mintSignalMaxAttempts || 3)));
  const retryDelayMs = Math.max(1, Math.floor(Number(ctx.config.mintSignalRetryDelayMs || 750)));

  while (attempts < maxAttempts) {
    try {
      // Disable cache during retry loop to ensure we get fresh indexing updates
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
      // Classic SPL token: parsed.info.type === 'mint'
      // Token-2022: parsed.type === 'mint' but parsed.info may be absent
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
  let largestAccounts;
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
  const topAccounts = (largestAccounts.value || []).slice(0, 5).map((account) => {
    const rawAmount = BigInt(account.amount || '0');
    return {
      address: account.address,
      rawAmount,
      share: bigintRatioToNumber(rawAmount, supplyRaw),
    };
  });

  const top1Share = topAccounts[0]?.share || 0;
  const top5Share = topAccounts.slice(0, 5).reduce((sum, account) => sum + account.share, 0);
  const ownerConcurrency = Math.max(1, Math.floor(Number(ctx.config.ownerAuditParallelism || 2)));
  const ownerResults = await runBoundedPool(
    topAccounts,
    async (account) => {
      try {
        const ownerInfo = await rpcCall(
          ctx,
          'getAccountInfo',
          [
            address(account.address),
            {
              encoding: 'jsonParsed',
              commitment: 'confirmed',
            },
          ],
          { priority, cacheTtlMs: 10000 }
        );
        const owner = ownerInfo.value?.data?.parsed?.info?.owner || null;
        return { ...account, owner };
      } catch (e) {
        const message = getErrorMessage(e);
        if (message.includes('not a Token mint')) {
          return { ...account, owner: null, ownerLookupError: 'RPC Indexing Lag' };
        }
        return { ...account, owner: null, ownerLookupError: message };
      }
    },
    { concurrency: ownerConcurrency }
  );
  const ownerDetails = ownerResults.map((r) => (r.status === 'fulfilled' ? r.value : r.item));

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
 * @param {Object} ctx - The application context.
 * @param {string} mint - The token mint address.
 * @returns {Promise<Object|null>} GoPlus signals (blockers, notes, raw record) or null.
 */
async function fetchGoPlusTokenSignals(ctx, mint) {
  if (!ctx.config.goPlusAccessToken) return null;
  try {
    const url = `${ctx.config.goPlusBaseUrl}/solana/token_security?contract_addresses=${encodeURIComponent(mint)}`;
    const payload = await fetchJson(url, {
      headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` },
    });
    const record =
      payload?.result?.[mint] ||
      payload?.result?.[mint.toLowerCase()] ||
      payload?.data?.[mint] ||
      payload?.data?.[mint.toLowerCase()] ||
      null;
    if (!record) return null;

    const blockers = [];
    const notes = [];
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

    return { blockers, notes, raw: record };
  } catch (e) {
    ctx.logger(`GoPlus token security skipped for ${mint}: ${getErrorMessage(e)}`, 'warn');
    return null;
  }
}

/**
 * Fetches address security signals from GoPlus for a batch of addresses.
 * @param {Object} ctx - The application context.
 * @param {string[]} addresses - Array of addresses to check.
 * @returns {Promise<Object[]>} Array of malicious address records found.
 */
async function fetchGoPlusAddressSignals(ctx, addresses) {
  if (!ctx.config.goPlusAccessToken) return [];
  const startedAt = Date.now();
  const results = await runBoundedPool(
    addresses,
    async (address) => {
      try {
        const url = `${ctx.config.goPlusBaseUrl}/address_security/${address}?chain_id=solana`;
        const payload = await fetchJson(url, {
          headers: { Authorization: `Bearer ${ctx.config.goPlusAccessToken}` },
        });
        const resultRecord = payload?.result;
        const dataRecord = payload?.data;
        const record =
          resultRecord?.[address] ||
          resultRecord?.[address.toLowerCase()] ||
          dataRecord?.[address] ||
          dataRecord?.[address.toLowerCase()] ||
          (resultRecord && !Array.isArray(resultRecord) ? resultRecord : null) ||
          (dataRecord && !Array.isArray(dataRecord) ? dataRecord : null);
        if (record && isMaliciousGoPlusAddressRecord(record)) return { address, record };
      } catch (e) {
        ctx.logger(`GoPlus address security skipped for ${address}: ${getErrorMessage(e)}`, 'warn');
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
 * @param {Object} record - The GoPlus address security record.
 * @returns {boolean} True if malicious signals are found.
 */
function isMaliciousGoPlusAddressRecord(record) {
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
    maliciousBehaviors.some((field) => maliciousFields.includes(String(field)))
  );
}

/**
 * Fetches decentralization and cluster signals from BubbleMaps.
 * @param {Object} ctx - The application context.
 * @param {string} mint - The token mint address.
 * @returns {Promise<Object|null>} BubbleMaps signals (blockers, score, largestClusterShare, raw) or null.
 */
async function fetchBubbleMapsSignals(ctx, mint) {
  if (!ctx.config.bubbleMapsApiKey) return null;
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
      timeoutMs: 25000,
    });
    const largestClusterShare =
      Array.isArray(payload?.clusters) && payload.clusters.length > 0
        ? Number(payload.clusters[0].share || 0)
        : null;
    const blockers = [];
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
      blockers,
      score: payload?.decentralization_score ?? null,
      largestClusterShare,
      raw: payload,
    };
  } catch (e) {
    ctx.logger(`BubbleMaps skipped for ${mint}: ${getErrorMessage(e)}`, 'warn');
    return null;
  }
}

module.exports = {
  getMintSignals,
  fetchGoPlusTokenSignals,
  fetchGoPlusAddressSignals,
  fetchBubbleMapsSignals,
  isTruthyFlag,
};
