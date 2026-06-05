const THRESHOLDS = {
  RISK_OFF: 70,
  NEUTRAL: 40,
};

function calcRiskLevel(riskScore) {
  if (riskScore >= THRESHOLDS.RISK_OFF) return 'risk_off';
  if (riskScore >= THRESHOLDS.NEUTRAL) return 'neutral';
  return 'risk_on';
}

// CEX間FR標準偏差スコア
function calcDeviationScore(frDeviation) {
  return Math.min(100, Math.max(0, (frDeviation - 0.000005) / (0.0001 - 0.000005) * 100));
}

// OI変化率スコア
function calcOIChangeScore(sources, prevSources) {
  if (!prevSources || prevSources.length === 0) return { oiChangeScore: 0, oiChanges: {}, frChanges: {} };
  const changes = {};
  let totalCurrent = 0, totalPrev = 0;
  for (const src of sources) {
    const prev = prevSources.find(p => p.exchange === src.exchange);
    if (prev && prev.oi > 0 && src.oi > 0) {
      changes[src.exchange] = (src.oi - prev.oi) / prev.oi;
    }
    totalCurrent += src.oi || 0;
    totalPrev += prev?.oi || 0;
  }
  const maxChange = Math.max(...Object.values(changes).map(Math.abs), 0);
  const totalChange = totalPrev > 0 ? Math.abs((totalCurrent - totalPrev) / totalPrev) : 0;
  const combined = maxChange * 0.6 + totalChange * 0.4;
  const score = Math.min(100, Math.max(0, (combined - 0.005) / (0.05 - 0.005) * 100));
  const frChanges = {};
  for (const src of sources) {
    const prev = prevSources.find(p => p.exchange === src.exchange);
    if (prev && prev.fr != null && src.fr != null) frChanges[src.exchange] = (src.fr - prev.fr) / Math.abs(prev.fr || 0.00001);
  }
  return { oiChangeScore: score, oiChanges: changes, totalOIChange: totalChange, frChanges };
}

// sizeMutiplier: riskScoreが高いほどサイズを絞る
function calcSizeMultiplier(riskScore) {
  const level = calcRiskLevel(riskScore);
  if (level === 'risk_off') return 0.25;
  if (level === 'neutral') return 0.5;
  return 1.0;
}

function calcOIConcentration(sources) {
  const ois = sources.map(d => d.oi).filter(v => v > 0);
  if (ois.length < 2) return 0;
  const total = ois.reduce((s, v) => s + v, 0);
  return Math.max(...ois) / total;
}

function assess(marketData, prevSources = []) {
  const { sources, avgFR, frDeviation } = marketData;
  const deviationScore = calcDeviationScore(frDeviation);
  const { oiChangeScore, oiChanges, totalOIChange, frChanges } = calcOIChangeScore(sources, prevSources);
  // riskScore = サイズ抑制指標（高いほど危険）
  const riskScore = deviationScore * 0.5 + oiChangeScore * 0.5;
  const level = calcRiskLevel(riskScore);
  const sizeMultiplier = calcSizeMultiplier(riskScore);
  const oiConc = calcOIConcentration(sources);

  return {
    riskScore,
    deviationScore,
    oiChangeScore,
    oiChanges,
    frChanges,
    totalOIChange,
    riskLevel: level,
    sizeMultiplier,
    oiConcentration: oiConc,
    avgFR,
    frDeviation,
    summary: `risk=${level} score=${riskScore.toFixed(1)} dev=${deviationScore.toFixed(1)} oiChg=${oiChangeScore.toFixed(1)} sizeMult=${sizeMultiplier} oiConc=${oiConc.toFixed(2)}`
  };
}


// 単一CEX異常検知 — Crowd Risk Detection
// 単一CEX異常検知 — Crowd Risk Detection
function detectCrowdRisk(sources, frChanges = {}, oiChanges = {}) {
  const alerts = [];

  const frs = sources.map(s => s.fr).filter(v => v != null);
  if (frs.length >= 3) {
    const avgFR = frs.reduce((a, b) => a + b, 0) / frs.length;
    for (const src of sources) {
      if (src.fr == null) continue;
      const deviation = Math.abs(src.fr - avgFR);
      if (deviation > Math.abs(avgFR) * 2 + 0.00005) {
        alerts.push({
          type: 'fr_outlier',
          exchange: src.exchange,
          value: src.fr,
          avg: avgFR,
          msg: `${src.exchange} FR outlier: ${(src.fr * 100).toFixed(4)}% vs avg ${(avgFR * 100).toFixed(4)}%`
        });
      }
    }
  }

  const frChangeVals = Object.values(frChanges).filter(v => isFinite(v));
  if (frChangeVals.length >= 2) {
    const avgChange = frChangeVals.reduce((a, b) => a + b, 0) / frChangeVals.length;
    for (const [exchange, change] of Object.entries(frChanges)) {
      if (!isFinite(change)) continue;
      if (Math.abs(change - avgChange) > 0.5 && Math.abs(change) > 0.3) {
        alerts.push({
          type: 'fr_spike',
          exchange,
          change,
          msg: `${exchange} FR spike: ${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}% change`
        });
      }
    }
  }

  const oiChangeVals = Object.values(oiChanges).filter(v => isFinite(v));
  if (oiChangeVals.length >= 2) {
    const avgOIChange = oiChangeVals.reduce((a, b) => a + b, 0) / oiChangeVals.length;
    for (const [exchange, change] of Object.entries(oiChanges)) {
      if (!isFinite(change)) continue;
      if (Math.abs(change - avgOIChange) > 0.03 && Math.abs(change) > 0.02) {
        alerts.push({
          type: 'oi_concentration',
          exchange,
          change,
          msg: `${exchange} OI concentration: ${change > 0 ? '+' : ''}${(change * 100).toFixed(2)}% vs avg`
        });
      }
    }
  }

  return {
    alerts,
    hasCrowdRisk: alerts.length > 0,
    summary: alerts.length > 0
      ? alerts.map(a => a.msg).join(' | ')
      : 'no crowd concentration detected'
    };
}

module.exports = { assess, calcRiskLevel, calcSizeMultiplier, calcOIChangeScore, calcDeviationScore, detectCrowdRisk, THRESHOLDS };
