import type {
  AssetIntelligenceCatalyst,
  AssetIntelligenceDriver,
  AssetIntelligenceLevel,
  AssetIntelligenceScenario,
  GetAssetIntelligenceRequest,
  GetAssetIntelligenceResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { buildTechnicalSnapshot, fetchYahooHistory } from './analyze-stock';

type SupportedAssetId = 'xauusd' | 'sp500';

type FredObservation = { date: string; value: number };

const CACHE_PREFIX = 'market:asset-intelligence:v1';
const CACHE_TTL_SECONDS = 900;
const FRED_API_BASE = 'https://api.stlouisfed.org/fred';

function normalizeAssetId(raw: string | undefined): SupportedAssetId {
  const normalized = (raw || '').trim().toLowerCase();
  return normalized === 'xauusd' ? 'xauusd' : 'sp500';
}

function emptyResponse(assetId: SupportedAssetId, message: string): GetAssetIntelligenceResponse {
  return {
    available: false,
    assetId,
    title: assetId === 'xauusd' ? 'Gold Spot / XAUUSD' : 'S&P 500',
    symbol: assetId === 'xauusd' ? 'GC=F' : '^GSPC',
    priceDisplay: 'N/A',
    price: 0,
    dayChangePercent: 0,
    currency: 'USD',
    updatedAt: new Date().toISOString(),
    regime: 'Unavailable',
    conviction: 'Low',
    supportiveDrivers: 0,
    headwindDrivers: 0,
    executiveSummary: message,
    forecastSummary: 'The workspace is waiting for market data before it can score the macro regime.',
    drivers: [],
    levels: [],
    scenarios: [],
    catalysts: [],
    sourceNote: 'Requires Yahoo Finance price history; macro fields improve when FRED is configured.',
  };
}

async function fetchFredSeries(seriesId: string, limit = 80): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];

  try {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: apiKey,
      file_type: 'json',
      sort_order: 'desc',
      limit: String(limit),
    });

    const response = await fetch(`${FRED_API_BASE}/series/observations?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];

    const data = await response.json() as { observations?: Array<{ date: string; value: string }> };
    return (data.observations ?? [])
      .map((obs) => {
        const value = Number.parseFloat(obs.value);
        return Number.isFinite(value) ? { date: obs.date, value } : null;
      })
      .filter((obs): obs is FredObservation => obs !== null)
      .reverse();
  } catch {
    return [];
  }
}

function latestValue(series: FredObservation[]): number | null {
  return series.length > 0 ? series[series.length - 1]!.value : null;
}

function valueAgo(series: FredObservation[], lookback: number): number | null {
  if (series.length === 0) return null;
  const index = Math.max(0, series.length - 1 - lookback);
  return series[index]?.value ?? null;
}

function lastClose(series: Awaited<ReturnType<typeof fetchYahooHistory>>): number | null {
  if (!series?.candles?.length) return null;
  return series.candles[series.candles.length - 1]?.close ?? null;
}

function closeAgo(series: Awaited<ReturnType<typeof fetchYahooHistory>>, lookback: number): number | null {
  if (!series?.candles?.length) return null;
  const index = Math.max(0, series.candles.length - 1 - lookback);
  return series.candles[index]?.close ?? null;
}

function pctChange(current: number | null, previous: number | null): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function delta(current: number | null, previous: number | null): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return current - previous;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSignedPercent(value: number | null, digits = 1): string {
  if (!Number.isFinite(value)) return 'N/A';
  const sign = (value ?? 0) > 0 ? '+' : '';
  return `${sign}${(value ?? 0).toFixed(digits)}%`;
}

function formatSignedBps(value: number | null): string {
  if (!Number.isFinite(value)) return 'N/A';
  const bps = (value ?? 0) * 100;
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps.toFixed(0)} bps`;
}

function formatPrice(value: number | null, digits = 2): string {
  if (!Number.isFinite(value)) return 'N/A';
  return `$${(value ?? 0).toFixed(digits)}`;
}

function buildDriver(
  id: string,
  label: string,
  score: number,
  valueDisplay: string,
  detail: string,
  horizon = '1m',
): AssetIntelligenceDriver {
  return {
    id,
    label,
    score,
    stance: score >= 15 ? 'tailwind' : score <= -15 ? 'headwind' : 'neutral',
    valueDisplay,
    detail,
    horizon,
  };
}

function scoreFromDirectionalMove(
  value: number | null,
  mild: number,
  strong: number,
  inverse = false,
): number {
  if (!Number.isFinite(value)) return 0;
  const signed = inverse ? -(value ?? 0) : (value ?? 0);
  if (signed >= strong) return 85;
  if (signed >= mild) return 55;
  if (signed <= -strong) return -85;
  if (signed <= -mild) return -55;
  return 0;
}

function scoreFromTrend(price: number, ma20: number, ma60: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(ma20) || !Number.isFinite(ma60)) return 0;
  const above20 = price >= ma20;
  const above60 = price >= ma60;
  const premium20 = ma20 !== 0 ? ((price - ma20) / ma20) * 100 : 0;
  const premium60 = ma60 !== 0 ? ((price - ma60) / ma60) * 100 : 0;
  if (above20 && above60 && premium20 > 1 && premium60 > 1) return 80;
  if (above20 && above60) return 55;
  if (!above20 && !above60 && premium20 < -1 && premium60 < -1) return -80;
  if (!above20 && !above60) return -55;
  return 0;
}

function buildProbabilities(overallScore: number): { base: number; bull: number; bear: number } {
  const bull = clamp(Math.round(25 + overallScore / 4), 15, 45);
  const bear = clamp(Math.round(25 - overallScore / 4), 15, 45);
  const base = clamp(100 - bull - bear, 30, 60);
  return { base, bull, bear: 100 - bull - base };
}

function buildRegime(assetId: SupportedAssetId, overallScore: number): string {
  if (assetId === 'xauusd') {
    if (overallScore >= 45) return 'Bullish safe-haven regime';
    if (overallScore >= 15) return 'Constructive accumulation regime';
    if (overallScore > -15) return 'Balanced range regime';
    if (overallScore > -45) return 'Pressured macro regime';
    return 'Bearish yield-driven regime';
  }

  if (overallScore >= 45) return 'Risk-on expansion regime';
  if (overallScore >= 15) return 'Constructive equity regime';
  if (overallScore > -15) return 'Range-bound macro regime';
  if (overallScore > -45) return 'Fragile risk regime';
  return 'Risk-off drawdown regime';
}

function buildConviction(overallScore: number, driverCount: number): string {
  if (driverCount < 4) return 'Low';
  const absScore = Math.abs(overallScore);
  if (absScore >= 55) return 'High';
  if (absScore >= 25) return 'Medium';
  return 'Low';
}

function strongestTailwind(drivers: AssetIntelligenceDriver[]): AssetIntelligenceDriver | null {
  return drivers.filter((driver) => driver.score > 0).sort((a, b) => b.score - a.score)[0] ?? null;
}

function strongestHeadwind(drivers: AssetIntelligenceDriver[]): AssetIntelligenceDriver | null {
  return drivers.filter((driver) => driver.score < 0).sort((a, b) => a.score - b.score)[0] ?? null;
}

function level(label: string, value: number | null, digits = 2): AssetIntelligenceLevel {
  return {
    label,
    value: Number.isFinite(value) ? (value ?? 0) : 0,
    valueDisplay: Number.isFinite(value) ? formatPrice(value, digits) : 'N/A',
  };
}

function macroLevel(label: string, value: number | null, suffix: string, digits = 2): AssetIntelligenceLevel {
  return {
    label,
    value: Number.isFinite(value) ? (value ?? 0) : 0,
    valueDisplay: Number.isFinite(value) ? `${(value ?? 0).toFixed(digits)}${suffix}` : 'N/A',
  };
}

function goldCatalysts(): AssetIntelligenceCatalyst[] {
  return [
    { title: 'Fed / real-yield repricing', description: 'Gold usually responds fastest to changes in US real yields and front-end rate expectations.', importance: 'high' },
    { title: 'US CPI / PCE', description: 'Inflation surprises can change both breakeven inflation and the real-rate path in one session.', importance: 'high' },
    { title: 'Dollar breakout risk', description: 'A stronger DXY often caps upside in XAUUSD even when headline risk is supportive.', importance: 'medium' },
    { title: 'Central-bank / reserve demand', description: 'Reserve accumulation and official-sector buying can keep the physical bid firm underneath price.', importance: 'medium' },
    { title: 'Geopolitical shock', description: 'Acute geopolitical escalation can temporarily overpower rate headwinds and trigger safe-haven flows.', importance: 'high' },
  ];
}

function sp500Catalysts(): AssetIntelligenceCatalyst[] {
  return [
    { title: 'US CPI / payrolls', description: 'Inflation and labor data drive the rate path that the index is discounting.', importance: 'high' },
    { title: 'FOMC / dot-plot', description: 'Forward guidance and balance-sheet messaging matter as much as the actual rate decision.', importance: 'high' },
    { title: '10Y yield + Treasury auctions', description: 'A disorderly rise in term premium is still one of the fastest ways to compress equity multiples.', importance: 'high' },
    { title: 'Earnings breadth', description: 'The index remains healthiest when leadership broadens beyond a narrow growth cohort.', importance: 'medium' },
    { title: 'Volatility / credit stress', description: 'A VIX spike or wider credit spreads can quickly force de-risking across equity books.', importance: 'high' },
  ];
}

async function buildGoldWorkspace(): Promise<GetAssetIntelligenceResponse> {
  const [gold, dxy, vix, dgs10, dfii10, t10yie, dgs2, walcl] = await Promise.all([
    fetchYahooHistory('GC=F'),
    fetchYahooHistory('DX-Y.NYB'),
    fetchYahooHistory('^VIX'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('DFII10'),
    fetchFredSeries('T10YIE'),
    fetchFredSeries('DGS2'),
    fetchFredSeries('WALCL'),
  ]);

  if (!gold) return emptyResponse('xauusd', 'Gold price history is unavailable right now.');

  const tech = buildTechnicalSnapshot(gold.candles);
  const dxyPct20 = pctChange(lastClose(dxy), closeAgo(dxy, 20));
  const vixPct5 = pctChange(lastClose(vix), closeAgo(vix, 5));
  const realYieldDelta20 = delta(latestValue(dfii10), valueAgo(dfii10, 20));
  const breakevenDelta20 = delta(latestValue(t10yie), valueAgo(t10yie, 20));
  const twoYearDelta20 = delta(latestValue(dgs2), valueAgo(dgs2, 20));
  const walclPct4 = pctChange(latestValue(walcl), valueAgo(walcl, 4));

  const drivers: AssetIntelligenceDriver[] = [
    buildDriver('real-yields', 'US real yields', scoreFromDirectionalMove(realYieldDelta20, 0.05, 0.12, true), formatSignedBps(realYieldDelta20), '10Y TIPS yield change over roughly one month. Lower real yields are usually supportive for bullion.', '1m'),
    buildDriver('dollar', 'US dollar', scoreFromDirectionalMove(dxyPct20, 0.8, 1.8, true), formatSignedPercent(dxyPct20), '20-session DXY change. Gold typically performs best when the dollar is softening.', '1m'),
    buildDriver('breakevens', 'Inflation expectations', scoreFromDirectionalMove(breakevenDelta20, 0.04, 0.10), formatSignedBps(breakevenDelta20), '10Y breakeven change. Rising inflation expectations can improve gold’s macro appeal.', '1m'),
    buildDriver('front-end-rates', 'Fed path proxy', scoreFromDirectionalMove(twoYearDelta20, 0.05, 0.12, true), formatSignedBps(twoYearDelta20), '2Y Treasury yield change. Falling front-end yields usually reduce the opportunity cost of holding gold.', '1m'),
    buildDriver('safe-haven', 'Risk stress', scoreFromDirectionalMove(vixPct5, 5, 15), formatSignedPercent(vixPct5), '5-session VIX change. A volatility shock can revive safe-haven demand quickly.', '1w'),
    buildDriver('liquidity', 'Fed liquidity proxy', scoreFromDirectionalMove(walclPct4, 0.2, 1.0), formatSignedPercent(walclPct4), '4-week change in the Fed balance sheet. Expanding liquidity is usually a mild structural tailwind for gold.', '1m'),
    buildDriver('trend', 'Price regime', scoreFromTrend(tech.currentPrice, tech.ma20, tech.ma60), `${formatPrice(tech.currentPrice)} vs 20D ${formatPrice(tech.ma20)} / 60D ${formatPrice(tech.ma60)}`, 'Trend confirmation based on the asset trading relative to its 20-day and 60-day averages.', '1m'),
  ];

  const availableScores = drivers.map((driver) => driver.score);
  const overallScore = average(availableScores);
  const supportiveDrivers = drivers.filter((driver) => driver.score >= 15).length;
  const headwindDrivers = drivers.filter((driver) => driver.score <= -15).length;
  const best = strongestTailwind(drivers);
  const worst = strongestHeadwind(drivers);
  const regime = buildRegime('xauusd', overallScore);
  const conviction = buildConviction(overallScore, drivers.length);
  const probabilities = buildProbabilities(overallScore);
  const recentHigh = gold.candles.slice(-20).reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
  const recentLow = gold.candles.slice(-20).reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);

  return {
    available: true,
    assetId: 'xauusd',
    title: 'Gold Spot / XAUUSD',
    symbol: 'GC=F',
    priceDisplay: formatPrice(tech.currentPrice),
    price: tech.currentPrice,
    dayChangePercent: tech.changePercent,
    currency: gold.currency || 'USD',
    updatedAt: new Date().toISOString(),
    regime,
    conviction,
    supportiveDrivers,
    headwindDrivers,
    executiveSummary: `Gold is in a ${regime.toLowerCase()}. ${best ? `${best.label} is the strongest tailwind` : 'The macro tailwinds are mixed'}, while ${worst ? worst.label.toLowerCase() : 'headline noise'} is the main headwind. As long as spot holds above the medium-term trend zone, dip buyers still have a credible case.`,
    forecastSummary: `Base case: expect gold to respect macro rates and dollar signals more than headlines alone. A sustained move above ${formatPrice(recentHigh)} likely needs softer real yields and a weaker dollar, while a break below ${formatPrice(tech.ma60)} would usually require higher real yields and a firm dollar at the same time.`,
    drivers,
    levels: [
      level('Spot', tech.currentPrice),
      level('20D moving average', tech.ma20),
      level('60D moving average', tech.ma60),
      level('20D high', Number.isFinite(recentHigh) ? recentHigh : null),
      level('20D low', Number.isFinite(recentLow) ? recentLow : null),
      macroLevel('10Y real yield', latestValue(dfii10), '%', 2),
      macroLevel('DXY proxy', lastClose(dxy), '', 2),
    ],
    scenarios: [
      { name: 'Base case', probability: probabilities.base, narrative: `Gold oscillates around the trend zone while real yields and the dollar stay mixed. That keeps the tape tradable, but not impulsive, unless macro data clearly breaks one way.` },
      { name: 'Bull case', probability: probabilities.bull, narrative: `Gold extends through ${formatPrice(recentHigh)} if real yields drift lower, the dollar softens, and any geopolitical stress keeps safe-haven demand alive.` },
      { name: 'Bear case', probability: probabilities.bear, narrative: `Gold loses altitude toward ${formatPrice(tech.ma60)} or lower if front-end rates and real yields both reprice upward and the dollar firms at the same time.` },
    ],
    catalysts: goldCatalysts(),
    sourceNote: 'Built from Yahoo Finance price histories, FRED macro series, and the finance-news mesh already loaded inside World Monitor. Missing macro fields reduce conviction but do not block the workspace.',
  };
}

async function buildSp500Workspace(): Promise<GetAssetIntelligenceResponse> {
  const [spx, vix, dxy, qqq, xlp, dgs10, dfii10, dgs2, walcl] = await Promise.all([
    fetchYahooHistory('^GSPC'),
    fetchYahooHistory('^VIX'),
    fetchYahooHistory('DX-Y.NYB'),
    fetchYahooHistory('QQQ'),
    fetchYahooHistory('XLP'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('DFII10'),
    fetchFredSeries('DGS2'),
    fetchFredSeries('WALCL'),
  ]);

  if (!spx) return emptyResponse('sp500', 'S&P 500 price history is unavailable right now.');

  const tech = buildTechnicalSnapshot(spx.candles);
  const vixPct5 = pctChange(lastClose(vix), closeAgo(vix, 5));
  const dxyPct20 = pctChange(lastClose(dxy), closeAgo(dxy, 20));
  const realYieldDelta20 = delta(latestValue(dfii10), valueAgo(dfii10, 20));
  const twoYearDelta20 = delta(latestValue(dgs2), valueAgo(dgs2, 20));
  const tenYearDelta20 = delta(latestValue(dgs10), valueAgo(dgs10, 20));
  const walclPct4 = pctChange(latestValue(walcl), valueAgo(walcl, 4));
  const qqqRoc20 = pctChange(lastClose(qqq), closeAgo(qqq, 20));
  const xlpRoc20 = pctChange(lastClose(xlp), closeAgo(xlp, 20));
  const growthSpread = Number.isFinite(qqqRoc20) && Number.isFinite(xlpRoc20) ? (qqqRoc20 ?? 0) - (xlpRoc20 ?? 0) : null;

  const drivers: AssetIntelligenceDriver[] = [
    buildDriver('volatility', 'Volatility regime', scoreFromDirectionalMove(vixPct5, 5, 15, true), formatSignedPercent(vixPct5), '5-session VIX change. Falling implied volatility keeps the equity risk premium from compressing further.', '1w'),
    buildDriver('front-end-rates', 'Front-end rates', scoreFromDirectionalMove(twoYearDelta20, 0.05, 0.12, true), formatSignedBps(twoYearDelta20), '2Y Treasury yield change over roughly one month. Lower front-end yields usually help duration-heavy equity valuations.', '1m'),
    buildDriver('real-yields', 'Real yields', scoreFromDirectionalMove(realYieldDelta20, 0.05, 0.12, true), formatSignedBps(realYieldDelta20), '10Y real-yield change. Falling real yields reduce discount-rate pressure on equities.', '1m'),
    buildDriver('long-end-rates', '10Y yield', scoreFromDirectionalMove(tenYearDelta20, 0.05, 0.12, true), formatSignedBps(tenYearDelta20), '10Y Treasury yield change. A calm or falling long end is usually supportive for multiples.', '1m'),
    buildDriver('dollar', 'US dollar', scoreFromDirectionalMove(dxyPct20, 0.8, 1.8, true), formatSignedPercent(dxyPct20), '20-session DXY change. A softer dollar tends to be friendlier for global risk assets and earnings translation.', '1m'),
    buildDriver('leadership', 'Growth vs defensives', scoreFromDirectionalMove(growthSpread, 1.5, 4.0), `QQQ ${formatSignedPercent(qqqRoc20)} vs XLP ${formatSignedPercent(xlpRoc20)}`, '20-session performance spread. Healthy growth leadership usually confirms a constructive equity tape.', '1m'),
    buildDriver('liquidity', 'Fed liquidity proxy', scoreFromDirectionalMove(walclPct4, 0.2, 1.0), formatSignedPercent(walclPct4), '4-week change in the Fed balance sheet. Improving liquidity is not sufficient on its own, but it helps when rates are contained.', '1m'),
    buildDriver('trend', 'Price regime', scoreFromTrend(tech.currentPrice, tech.ma20, tech.ma60), `${formatPrice(tech.currentPrice)} vs 20D ${formatPrice(tech.ma20)} / 60D ${formatPrice(tech.ma60)}`, 'Trend confirmation based on the index trading relative to its 20-day and 60-day averages.', '1m'),
  ];

  const overallScore = average(drivers.map((driver) => driver.score));
  const supportiveDrivers = drivers.filter((driver) => driver.score >= 15).length;
  const headwindDrivers = drivers.filter((driver) => driver.score <= -15).length;
  const best = strongestTailwind(drivers);
  const worst = strongestHeadwind(drivers);
  const regime = buildRegime('sp500', overallScore);
  const conviction = buildConviction(overallScore, drivers.length);
  const probabilities = buildProbabilities(overallScore);
  const recentHigh = spx.candles.slice(-20).reduce((max, candle) => Math.max(max, candle.high), Number.NEGATIVE_INFINITY);
  const recentLow = spx.candles.slice(-20).reduce((min, candle) => Math.min(min, candle.low), Number.POSITIVE_INFINITY);

  return {
    available: true,
    assetId: 'sp500',
    title: 'S&P 500',
    symbol: '^GSPC',
    priceDisplay: formatPrice(tech.currentPrice),
    price: tech.currentPrice,
    dayChangePercent: tech.changePercent,
    currency: spx.currency || 'USD',
    updatedAt: new Date().toISOString(),
    regime,
    conviction,
    supportiveDrivers,
    headwindDrivers,
    executiveSummary: `The S&P 500 is in a ${regime.toLowerCase()}. ${best ? `${best.label} is currently the strongest tailwind` : 'The tape lacks a dominant tailwind'}, while ${worst ? worst.label.toLowerCase() : 'macro noise'} is the key headwind. If volatility stays contained and yields do not re-accelerate, the index still has room to grind rather than break down.`,
    forecastSummary: `Base case: equities keep following rates, volatility, and leadership breadth more than narrative noise. A push through ${formatPrice(recentHigh)} likely needs contained yields and steady leadership, while a clean break below ${formatPrice(tech.ma60)} would normally require higher yields and a volatility shock together.`,
    drivers,
    levels: [
      level('Spot', tech.currentPrice),
      level('20D moving average', tech.ma20),
      level('60D moving average', tech.ma60),
      level('20D high', Number.isFinite(recentHigh) ? recentHigh : null),
      level('20D low', Number.isFinite(recentLow) ? recentLow : null),
      macroLevel('VIX', lastClose(vix), '', 2),
      macroLevel('10Y yield', latestValue(dgs10), '%', 2),
    ],
    scenarios: [
      { name: 'Base case', probability: probabilities.base, narrative: `The index keeps grinding in a broad range while rates, volatility, and leadership stay mixed but not hostile. That supports tactical buy-the-dip behavior without a full melt-up.` },
      { name: 'Bull case', probability: probabilities.bull, narrative: `The S&P 500 reclaims or extends through ${formatPrice(recentHigh)} if volatility stays compressed, yields ease, and growth leadership remains intact.` },
      { name: 'Bear case', probability: probabilities.bear, narrative: `A move toward ${formatPrice(tech.ma60)} or lower becomes more likely if yields rise, the dollar firms, and volatility forces de-risking across the index.` },
    ],
    catalysts: sp500Catalysts(),
    sourceNote: 'Built from Yahoo Finance price histories, FRED macro series, and the finance-news mesh already loaded inside World Monitor. Missing macro fields reduce conviction but do not block the workspace.',
  };
}

export async function getAssetIntelligence(
  _ctx: ServerContext,
  req: GetAssetIntelligenceRequest,
): Promise<GetAssetIntelligenceResponse> {
  const assetId = normalizeAssetId(req.assetId);
  const cacheKey = `${CACHE_PREFIX}:${assetId}`;

  const result = await cachedFetchJson<GetAssetIntelligenceResponse>(cacheKey, CACHE_TTL_SECONDS, async () => {
    if (assetId === 'xauusd') return buildGoldWorkspace();
    return buildSp500Workspace();
  });

  return result ?? emptyResponse(assetId, 'Asset intelligence is temporarily unavailable.');
}