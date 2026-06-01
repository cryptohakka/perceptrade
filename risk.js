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

module.exports = { assess, calcRiskLevel, calcSizeMultiplier, calcOIChangeScore, calcDeviationScore, THRESHOLDS };
