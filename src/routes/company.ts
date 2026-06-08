import { Router } from 'express';
import { forwardReadRequest } from '../utils/executor';

const router = Router();

// Types
interface Posting {
  id: number;
  accounts_id: number;
  accounts_dimensions_id?: number;
  type: 'D' | 'C';
  amount: number;
}

interface AccountDimension {
  id: number;
  accounts_id: number;
  title_est: string;
  title_eng: string;
}

interface BalanceTracker {
  openingBalance: number;
  debitChange: number;
  creditChange: number;
}

// Helper functions
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Short-lived in-memory cache for the full journal list. A single balance page
// load can trigger several requests (preset clicks, hide-zero toggle, refresh),
// each of which would otherwise re-paginate the entire journal history from the
// upstream API. Journal data only changes when an approved write is executed, so
// a short TTL is a safe trade-off. A single in-flight promise is shared so
// concurrent requests don't all fan out a full re-fetch.
const JOURNALS_CACHE_TTL_MS = 30_000;
let journalsCache: { data: any[]; expiresAt: number } | null = null;
let journalsInFlight: Promise<any[]> | null = null;

async function fetchAllJournalsUncached(): Promise<any[]> {
  const allJournals: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const response = await forwardReadRequest('GET', '/journals', { page: String(page), per_page: '100' }, {});

    if (response && Array.isArray(response.items)) {
      allJournals.push(...response.items);
      totalPages = response.total_pages || 1;
    } else if (Array.isArray(response)) {
      allJournals.push(...response);
      break;
    }

    page++;
  } while (page <= totalPages);

  return allJournals;
}

async function fetchAllJournals(): Promise<any[]> {
  if (journalsCache && journalsCache.expiresAt > Date.now()) {
    return journalsCache.data;
  }

  // Coalesce concurrent callers onto a single in-flight fetch.
  if (!journalsInFlight) {
    journalsInFlight = fetchAllJournalsUncached()
      .then((data) => {
        journalsCache = { data, expiresAt: Date.now() + JOURNALS_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        journalsInFlight = null;
      });
  }

  return journalsInFlight;
}

// Invalidate the journal cache. Call this after a write is executed so freshly
// approved journals show up immediately instead of waiting for the TTL.
export function invalidateJournalsCache(): void {
  journalsCache = null;
}

async function fetchAccountDimensions(): Promise<Map<string, AccountDimension>> {
  const dimensions = await forwardReadRequest('GET', '/account_dimensions', {}, {});
  const dimensionMap = new Map<string, AccountDimension>();
  
  if (Array.isArray(dimensions)) {
    dimensions.forEach((dim: AccountDimension) => {
      dimensionMap.set(String(dim.id), dim);
    });
  }
  
  return dimensionMap;
}

function getDimensionName(dimId: number, dimensionMap: Map<string, AccountDimension>): string {
  const dimInfo = dimensionMap.get(String(dimId));
  return dimInfo?.title_est || dimInfo?.title_eng || `Dimension ${dimId}`;
}

function updateBalance(tracker: BalanceTracker, posting: Posting, journalDate: Date, start: Date, end: Date): void {
  const amount = posting.amount;
  
  if (journalDate < start) {
    tracker.openingBalance += posting.type === 'D' ? amount : -amount;
  } else if (journalDate <= end) {
    if (posting.type === 'D') {
      tracker.debitChange += amount;
    } else {
      tracker.creditChange += amount;
    }
  }
}

function calculateBalanceResult(tracker: BalanceTracker) {
  const totalChange = tracker.debitChange - tracker.creditChange;
  return {
    openingBalance: round2(tracker.openingBalance),
    debitChange: round2(tracker.debitChange),
    creditChange: round2(tracker.creditChange),
    totalChange: round2(totalChange),
    closingBalance: round2(tracker.openingBalance + totalChange),
  };
}

// Routes
router.get('/company', async (req, res) => {
  try {
    const [vatInfo, invoiceInfo, bankAccounts] = await Promise.all([
      forwardReadRequest('GET', '/vat_info', {}, {}),
      forwardReadRequest('GET', '/invoice_info', {}, {}),
      forwardReadRequest('GET', '/bank_accounts', {}, {}),
    ]);

    res.json({
      success: true,
      company: {
        name: invoiceInfo.invoice_company_name || 'Unknown',
        address: invoiceInfo.address || null,
        email: invoiceInfo.email || null,
        phone: invoiceInfo.phone || null,
        fax: invoiceInfo.fax || null,
        website: invoiceInfo.webpage || null,
        vatNumber: vatInfo.vat_number || null,
        taxNumber: vatInfo.tax_refnumber || null,
        bankAccounts: bankAccounts || [],
        invoiceSettings: {
          emailSubject: invoiceInfo.invoice_email_subject || null,
          emailBody: invoiceInfo.invoice_email_body || null,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching company info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch company information',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await forwardReadRequest('GET', '/accounts', {}, {});
    res.json({ success: true, accounts });
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch accounts',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/account-dimensions?account=1750
router.get('/account-dimensions', async (req, res) => {
  try {
    const { account } = req.query;

    if (!account) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: account is required',
      });
    }

    const accountId = String(account);
    const [dimensionMap, journals] = await Promise.all([
      fetchAccountDimensions(),
      fetchAllJournals(),
    ]);

    const dimensions = new Map<number, {
      dimensionId: number;
      name: string;
      firstSeenDate: string;
      lastSeenDate: string;
      transactionCount: number;
      totalDebit: number;
      totalCredit: number;
    }>();

    for (const journal of journals) {
      const journalDate = journal.effective_date;
      const postings: Posting[] = journal.postings || [];

      for (const posting of postings) {
        if (String(posting.accounts_id) !== accountId || !posting.accounts_dimensions_id) continue;

        const dimId = posting.accounts_dimensions_id;
        const amount = parseFloat(String(posting.amount)) || 0;

        if (!dimensions.has(dimId)) {
          dimensions.set(dimId, {
            dimensionId: dimId,
            name: getDimensionName(dimId, dimensionMap),
            firstSeenDate: journalDate,
            lastSeenDate: journalDate,
            transactionCount: 0,
            totalDebit: 0,
            totalCredit: 0,
          });
        }

        const dim = dimensions.get(dimId)!;
        dim.transactionCount++;
        dim.firstSeenDate = journalDate < dim.firstSeenDate ? journalDate : dim.firstSeenDate;
        dim.lastSeenDate = journalDate > dim.lastSeenDate ? journalDate : dim.lastSeenDate;
        
        if (posting.type === 'D') {
          dim.totalDebit += amount;
        } else {
          dim.totalCredit += amount;
        }
      }
    }

    const result = Array.from(dimensions.values())
      .map(d => ({
        ...d,
        totalDebit: round2(d.totalDebit),
        totalCredit: round2(d.totalCredit),
        netBalance: round2(d.totalDebit - d.totalCredit),
      }))
      .sort((a, b) => a.dimensionId - b.dimensionId);

    res.json({
      success: true,
      account: accountId,
      totalDimensions: result.length,
      dimensions: result,
    });
  } catch (error) {
    console.error('Error fetching account dimensions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch account dimensions',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/account-balances?startDate=2024-01-01&endDate=2024-12-31&accounts=1750&includeDimensions=true
router.get('/account-balances', async (req, res) => {
  try {
    const { startDate, endDate, accounts, includeDimensions } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: startDate and endDate are required',
      });
    }

    const accountNumbers = accounts
      ? String(accounts).split(',').map(a => a.trim()).filter(Boolean)
      : [];

    const shouldIncludeDimensions = includeDimensions === 'true' || includeDimensions === '1';

    const [accountsData, dimensionMap, journals] = await Promise.all([
      forwardReadRequest('GET', '/accounts', {}, {}),
      fetchAccountDimensions(),
      fetchAllJournals(),
    ]);

    const accountMap = new Map<string, any>();
    if (Array.isArray(accountsData)) {
      accountsData.forEach((acc: any) => accountMap.set(String(acc.id), acc));
    }

    const targetAccountNumbers = accountNumbers.length > 0
      ? accountNumbers
      : Array.from(accountMap.keys());

    // Parse the period boundaries as explicit UTC instants. journal effective_date
    // values are date-only (YYYY-MM-DD) and parse to UTC midnight, so the period
    // bounds must use the same basis — otherwise a server in a non-UTC timezone
    // would bucket boundary-day journals into the wrong period (opening vs change).
    const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00.000Z`);
    const end = new Date(`${String(endDate).slice(0, 10)}T23:59:59.999Z`);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid startDate or endDate; expected YYYY-MM-DD',
      });
    }

    // Track balances per account
    const accountBalances = new Map<string, BalanceTracker>();
    const dimensionBalances = new Map<string, Map<number, BalanceTracker>>();

    targetAccountNumbers.forEach(accNum => {
      accountBalances.set(accNum, { openingBalance: 0, debitChange: 0, creditChange: 0 });
      if (shouldIncludeDimensions) {
        dimensionBalances.set(accNum, new Map());
      }
    });

    // Process all journals
    let skippedJournals = 0;
    for (const journal of journals) {
      const journalDate = new Date(journal.effective_date);
      if (isNaN(journalDate.getTime())) {
        // A journal with a missing/unparseable effective_date can't be bucketed
        // into opening vs. period change. Skip it but surface the count so the
        // omission is visible rather than silently dropped from the totals.
        skippedJournals++;
        continue;
      }
      const postings: Posting[] = journal.postings || [];

      for (const posting of postings) {
        const accNum = String(posting.accounts_id);
        if (!accountBalances.has(accNum)) continue;

        const amount = parseFloat(String(posting.amount)) || 0;
        const postingWithAmount = { ...posting, amount };

        // Update account balance
        updateBalance(accountBalances.get(accNum)!, postingWithAmount, journalDate, start, end);

        // Update dimension balance if applicable
        if (shouldIncludeDimensions && posting.accounts_dimensions_id) {
          const dimsForAccount = dimensionBalances.get(accNum)!;
          const dimId = posting.accounts_dimensions_id;
          
          if (!dimsForAccount.has(dimId)) {
            dimsForAccount.set(dimId, { openingBalance: 0, debitChange: 0, creditChange: 0 });
          }
          
          updateBalance(dimsForAccount.get(dimId)!, postingWithAmount, journalDate, start, end);
        }
      }
    }

    // Build response
    const result = targetAccountNumbers.map(accNum => {
      const acc = accountMap.get(accNum);
      const accountResult: any = {
        accountNumber: accNum,
        accountName: acc?.name_est || acc?.name_eng || 'Unknown',
        ...calculateBalanceResult(accountBalances.get(accNum)!),
      };

      if (shouldIncludeDimensions) {
        const dims = dimensionBalances.get(accNum)!;
        accountResult.dimensions = Array.from(dims.entries())
          .map(([dimId, tracker]) => ({
            dimensionId: dimId,
            name: getDimensionName(dimId, dimensionMap),
            ...calculateBalanceResult(tracker),
          }))
          .sort((a, b) => a.dimensionId - b.dimensionId);
      }

      return accountResult;
    });

    res.json({
      success: true,
      period: { startDate: String(startDate), endDate: String(endDate) },
      totalJournalsProcessed: journals.length,
      skippedJournals,
      includeDimensions: shouldIncludeDimensions,
      balances: result,
    });
  } catch (error) {
    console.error('Error calculating account balances:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate account balances',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
