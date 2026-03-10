import { Panel } from './Panel';
import type { NewsItem } from '@/types';
import type {
  AssetIntelligenceCatalyst,
  AssetIntelligenceDriver,
  AssetIntelligenceLevel,
  AssetIntelligenceScenario,
  GetAssetIntelligenceResponse,
} from '@/generated/client/worldmonitor/market/v1/service_client';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';

type AssetSelection = 'xauusd' | 'sp500';

const STORAGE_KEY = 'wm-asset-intelligence-selection';

const ASSET_LABELS: Record<AssetSelection, string> = {
  xauusd: 'Gold / XAUUSD',
  sp500: 'S&P 500',
};

const NEWS_PRIORITY: Record<AssetSelection, string[]> = {
  xauusd: ['xauusd', 'commodities', 'analysis', 'centralbanks', 'economic', 'bonds', 'forex'],
  sp500: ['sp500', 'markets', 'analysis', 'economic', 'centralbanks', 'bonds', 'derivatives', 'institutional'],
};

const NEWS_ALIASES: Record<AssetSelection, string[]> = {
  xauusd: ['gold', 'xauusd', 'bullion', 'precious metal', 'lbma', 'gld', 'central bank gold'],
  sp500: ['s&p 500', 's&p', 'sp500', 'spx', 'spy', 'us stocks', 'wall street', 'equity market'],
};

function loadSelection(): AssetSelection {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'xauusd' || stored === 'sp500' ? stored : 'xauusd';
}

function toneColor(score: number): string {
  if (score >= 15) return '#8df0b2';
  if (score <= -15) return '#ff9f9f';
  return '#f4d06f';
}

function toneBackground(score: number): string {
  if (score >= 15) return 'rgba(141, 240, 178, 0.08)';
  if (score <= -15) return 'rgba(255, 159, 159, 0.08)';
  return 'rgba(244, 208, 111, 0.08)';
}

function formatSignedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function badgeTone(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes('bull') || normalized.includes('risk-on') || normalized.includes('constructive') || normalized.includes('high')) return 'rgba(141, 240, 178, 0.18)';
  if (normalized.includes('bear') || normalized.includes('risk-off') || normalized.includes('fragile') || normalized.includes('pressured') || normalized.includes('low')) return 'rgba(255, 159, 159, 0.18)';
  return 'rgba(244, 208, 111, 0.18)';
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = item.link || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function matchesAssetHeadline(assetId: AssetSelection, item: NewsItem, category: string): boolean {
  if (category === assetId) return true;
  const title = item.title.toLowerCase();
  return NEWS_ALIASES[assetId].some((alias) => title.includes(alias));
}

export class AssetIntelligencePanel extends Panel {
  private selectedAsset: AssetSelection = loadSelection();
  private dataByAsset: Partial<Record<AssetSelection, GetAssetIntelligenceResponse>> = {};
  private newsByCategory: Record<string, NewsItem[]> = {};

  constructor() {
    super({
      id: 'asset-intelligence',
      title: 'Asset Intelligence',
      infoTooltip: 'Macro-first workspace for Gold and the S&P 500. It ranks major drivers, shows scenarios, highlights watch levels, and filters finance headlines into asset-specific context.',
    });

    this.content.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const assetBtn = target?.closest<HTMLElement>('[data-asset-id]');
      if (!assetBtn) return;
      const next = assetBtn.dataset.assetId;
      if (next !== 'xauusd' && next !== 'sp500') return;
      if (next === this.selectedAsset) return;
      this.selectedAsset = next;
      localStorage.setItem(STORAGE_KEY, next);
      this.renderPanel();
    });

    this.showLoading('Building asset intelligence...');
  }

  public renderAssetData(
    responses: Partial<Record<AssetSelection, GetAssetIntelligenceResponse>>,
    newsByCategory: Record<string, NewsItem[]>,
    source: 'live' | 'cached' = 'live',
  ): void {
    this.dataByAsset = { ...this.dataByAsset, ...responses };
    this.newsByCategory = newsByCategory;
    const assetCount = Object.values(this.dataByAsset).filter(Boolean).length;
    if (assetCount > 0) {
      this.setDataBadge(source, `${assetCount} assets`);
    }
    this.renderPanel();
  }

  public updateNewsContext(newsByCategory: Record<string, NewsItem[]>): void {
    this.newsByCategory = newsByCategory;
    if (this.dataByAsset[this.selectedAsset]) {
      this.renderPanel();
    }
  }

  private relatedNews(assetId: AssetSelection): NewsItem[] {
    const results: NewsItem[] = [];
    for (const category of NEWS_PRIORITY[assetId]) {
      const items = this.newsByCategory[category] || [];
      for (const item of items) {
        if (matchesAssetHeadline(assetId, item, category)) {
          results.push(item);
        }
      }
    }
    return dedupeNews(results)
      .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
      .slice(0, 6);
  }

  private renderPanel(): void {
    const data = this.dataByAsset[this.selectedAsset];
    if (!data) {
      this.showLoading('Building asset intelligence...');
      return;
    }
    if (!data.available) {
      this.showError(data.executiveSummary || 'Asset intelligence is unavailable.', undefined);
      return;
    }

    const relatedNews = this.relatedNews(this.selectedAsset);
    const dayChangeColor = data.dayChangePercent >= 0 ? '#8df0b2' : '#ff9f9f';
    const html = `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${(['xauusd', 'sp500'] as AssetSelection[]).map((assetId) => `
            <button
              type="button"
              data-asset-id="${assetId}"
              style="border:1px solid ${assetId === this.selectedAsset ? 'var(--accent, #4fc3f7)' : 'var(--border)'}; background:${assetId === this.selectedAsset ? 'rgba(79,195,247,0.10)' : 'rgba(255,255,255,0.03)'}; color:var(--text); padding:8px 12px; font-size:12px; letter-spacing:0.04em; text-transform:uppercase; cursor:pointer"
            >${escapeHtml(ASSET_LABELS[assetId])}</button>
          `).join('')}
        </div>

        <section style="border:1px solid var(--border); background:linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)); padding:16px; display:flex; flex-direction:column; gap:14px">
          <div style="display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap">
            <div style="min-width:240px; flex:1">
              <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
                <strong style="font-size:20px; letter-spacing:-0.02em">${escapeHtml(data.title)}</strong>
                <span style="font-family:monospace; font-size:12px; color:var(--text-dim)">${escapeHtml(data.symbol)}</span>
              </div>
              <div style="margin-top:8px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap">
                <span style="font-size:28px; font-weight:700">${escapeHtml(data.priceDisplay)}</span>
                <span style="font-size:13px; color:${dayChangeColor}">${escapeHtml(formatSignedPercent(data.dayChangePercent))}</span>
                <span style="font-size:11px; color:var(--text-dim)">Updated ${escapeHtml(new Date(data.updatedAt).toLocaleTimeString())}</span>
              </div>
              <p style="margin:10px 0 0; font-size:13px; line-height:1.6; color:var(--text-dim)">${escapeHtml(data.executiveSummary)}</p>
            </div>
            <div style="display:grid; grid-template-columns:repeat(2, minmax(120px, 1fr)); gap:10px; min-width:min(100%, 320px)">
              ${this.renderHeaderMetric('Regime', data.regime, badgeTone(data.regime))}
              ${this.renderHeaderMetric('Conviction', data.conviction, badgeTone(data.conviction))}
              ${this.renderHeaderMetric('Tailwinds', String(data.supportiveDrivers), 'rgba(141, 240, 178, 0.18)')}
              ${this.renderHeaderMetric('Headwinds', String(data.headwindDrivers), 'rgba(255, 159, 159, 0.18)')}
            </div>
          </div>

          <div style="display:grid; grid-template-columns:2fr 1fr; gap:14px">
            <div style="border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:12px">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Desk View</div>
              <div style="margin-top:8px; font-size:13px; line-height:1.65; color:var(--text)">${escapeHtml(data.forecastSummary)}</div>
            </div>
            <div style="border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:12px">
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Sources</div>
              <div style="margin-top:8px; font-size:12px; line-height:1.6; color:var(--text-dim)">${escapeHtml(data.sourceNote)}</div>
            </div>
          </div>
        </section>

        <section style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px">
          ${data.scenarios.map((scenario) => this.renderScenario(scenario)).join('')}
        </section>

        <section style="display:grid; grid-template-columns:1.6fr 1fr; gap:14px">
          <div style="display:flex; flex-direction:column; gap:10px">
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Driver Board</div>
            ${data.drivers.map((driver) => this.renderDriver(driver)).join('')}
          </div>
          <div style="display:flex; flex-direction:column; gap:14px">
            <div>
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Watch Levels</div>
              <div style="margin-top:8px; display:grid; gap:8px">
                ${data.levels.map((item) => this.renderLevel(item)).join('')}
              </div>
            </div>
            <div>
              <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Catalyst Map</div>
              <div style="margin-top:8px; display:grid; gap:8px">
                ${data.catalysts.map((item) => this.renderCatalyst(item)).join('')}
              </div>
            </div>
          </div>
        </section>

        <section style="display:flex; flex-direction:column; gap:8px">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap">
            <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">Related Headlines</div>
            <div style="font-size:11px; color:var(--text-dim)">Filtered from the live finance feed mesh already running in this dashboard</div>
          </div>
          ${relatedNews.length > 0 ? `
            <div style="display:grid; gap:8px">
              ${relatedNews.map((item) => this.renderHeadline(item)).join('')}
            </div>
          ` : `
            <div style="border:1px dashed var(--border); padding:12px; color:var(--text-dim); font-size:12px">
              No related headlines are in the current live feed window for this asset yet.
            </div>
          `}
        </section>
      </div>
    `;

    this.setContent(html);
  }

  private renderHeaderMetric(label: string, value: string, background: string): string {
    return `
      <div style="border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:10px">
        <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">${escapeHtml(label)}</div>
        <div style="margin-top:8px; display:inline-flex; align-items:center; gap:6px; padding:4px 8px; background:${background}; font-size:12px">${escapeHtml(value)}</div>
      </div>
    `;
  }

  private renderScenario(scenario: AssetIntelligenceScenario): string {
    return `
      <div style="border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:12px; display:flex; flex-direction:column; gap:8px">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center">
          <strong style="font-size:13px">${escapeHtml(scenario.name)}</strong>
          <span style="font-family:monospace; font-size:12px; color:var(--text-dim)">${escapeHtml(String(scenario.probability))}%</span>
        </div>
        <div style="font-size:12px; line-height:1.6; color:var(--text-dim)">${escapeHtml(scenario.narrative)}</div>
      </div>
    `;
  }

  private renderDriver(driver: AssetIntelligenceDriver): string {
    const width = `${Math.min(100, Math.abs(driver.score))}%`;
    return `
      <div style="border:1px solid var(--border); background:${toneBackground(driver.score)}; padding:12px; display:flex; flex-direction:column; gap:8px">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
          <div>
            <div style="font-size:13px; font-weight:600">${escapeHtml(driver.label)}</div>
            <div style="margin-top:4px; font-family:monospace; font-size:12px; color:${toneColor(driver.score)}">${escapeHtml(driver.valueDisplay)}</div>
          </div>
          <span style="padding:3px 7px; font-size:10px; text-transform:uppercase; letter-spacing:0.08em; border:1px solid ${toneColor(driver.score)}; color:${toneColor(driver.score)}">${escapeHtml(driver.stance)}</span>
        </div>
        <div style="height:6px; background:rgba(255,255,255,0.08)">
          <div style="height:100%; width:${width}; background:${toneColor(driver.score)}"></div>
        </div>
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center">
          <div style="font-size:12px; line-height:1.55; color:var(--text-dim)">${escapeHtml(driver.detail)}</div>
          <div style="font-size:11px; color:var(--text-dim); white-space:nowrap">${escapeHtml(driver.horizon)}</div>
        </div>
      </div>
    `;
  }

  private renderLevel(item: AssetIntelligenceLevel): string {
    return `
      <div style="display:flex; justify-content:space-between; gap:10px; border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:10px">
        <span style="font-size:12px; color:var(--text-dim)">${escapeHtml(item.label)}</span>
        <span style="font-family:monospace; font-size:12px">${escapeHtml(item.valueDisplay)}</span>
      </div>
    `;
  }

  private renderCatalyst(item: AssetIntelligenceCatalyst): string {
    return `
      <div style="border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:10px">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:center">
          <strong style="font-size:12px">${escapeHtml(item.title)}</strong>
          <span style="font-size:10px; text-transform:uppercase; letter-spacing:0.08em; color:var(--text-dim)">${escapeHtml(item.importance)}</span>
        </div>
        <div style="margin-top:6px; font-size:12px; line-height:1.55; color:var(--text-dim)">${escapeHtml(item.description)}</div>
      </div>
    `;
  }

  private renderHeadline(item: NewsItem): string {
    const url = sanitizeUrl(item.link);
    return `
      <a href="${url}" target="_blank" rel="noreferrer" style="display:block; border:1px solid var(--border); background:rgba(255,255,255,0.02); padding:12px; text-decoration:none; color:var(--text)">
        <div style="font-size:12px; line-height:1.55">${escapeHtml(item.title)}</div>
        <div style="margin-top:6px; display:flex; justify-content:space-between; gap:10px; align-items:center; font-size:10px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.08em">
          <span>${escapeHtml(item.source)}</span>
          <span>${escapeHtml(item.pubDate.toLocaleString())}</span>
        </div>
      </a>
    `;
  }
}