const THRESHOLDS = {
  RISK_OFF: 70,
  NEUTRAL: 50,
  RISK_ON: 0
};
function calcRiskLevel(riskScore) {
  if (riskScore >= THRESHOLDS.RISK_OFF) return 'risk_off';
  if (riskScore >= THRESHOLDS.NEUTRAL) return 'neutral';
  return 'risk_on';
}
function calcPositionSize(baseSize, riskScore) {
  const level = calcRiskLevel(riskScore);
  if (level === 'risk_off') return baseSize * 0.25;
  if (level === 'neutral') return baseSize * 0.5;
  return baseSize;
}
function calcFRBias(sources) {
  const avgFR = sources.reduce((s, d) => s + d.fr, 0) / sources.length;
  if (avgFR > 0.0003) return 'short_bias';
  if (avgFR < -0.0003) return 'long_bias';
  return 'neutral';
}
function calcOIConcentration(sources) {
  const ois = sources.map(d => d.oi).filter(v => v > 0);
  if (ois.length < 2) return 0;
  const total = ois.reduce((s, v) => s + v, 0);
  const max = Math.max(...ois);
  return max / total;
}
// 軸1: 市場全体の過熱度 (avgFR絶対値)
function calcHeatScore(avgFR) {
  return Math.min(100, Math.max(0, (Math.abs(avgFR) - 0.00003) / (0.0003 - 0.00003) * 100));
}
// 軸2: CEX間FR乖離リスク
function calcDeviationScore(frDeviation) {
  return Math.min(100, Math.max(0, (frDeviation - 0.00003) / (0.0003 - 0.00003) * 100));
}
// 軸3: OI変化率スコア (各CEX + 合計)
// prevSources: [{exchange, oi}] 前サイクルのOIスナップショット
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
  // 最大CEX変化率(60%) + 合計変化率(40%) で合成
  const combined = maxChange * 0.6 + totalChange * 0.4;
  const score = Math.min(100, Math.max(0, (combined - 0.02) / (0.1 - 0.02) * 100));
  const frChanges = {};
  for (const src of sources) {
    const prev = prevSources.find(p => p.exchange === src.exchange);
    if (prev && prev.fr != null && src.fr != null) frChanges[src.exchange] = (src.fr - prev.fr) / Math.abs(prev.fr);
  }
  return { oiChangeScore: score, oiChanges: changes, totalOIChange: totalChange, frChanges };
}
function assess(marketData, prevSources = []) {
  const { sources, avgFR, frDeviation } = marketData;
  const heatScore = calcHeatScore(avgFR);
  const deviationScore = calcDeviationScore(frDeviation);
  const { oiChangeScore, oiChanges, totalOIChange, frChanges } = calcOIChangeScore(sources, prevSources);
  const riskScore = heatScore * 0.4 + deviationScore * 0.3 + oiChangeScore * 0.3;
  const level = calcRiskLevel(riskScore);
  const frBias = calcFRBias(sources);
  const oiConc = calcOIConcentration(sources);
  return {
    riskScore,
    heatScore,
    deviationScore,
    oiChangeScore,
    oiChanges,
    frChanges,
    totalOIChange,
    riskLevel: level,
    frBias,
    oiConcentration: oiConc,
    avgFR,
    frDeviation,
    summary: `risk=${level} score=${riskScore.toFixed(1)} heat=${heatScore.toFixed(1)} dev=${deviationScore.toFixed(1)} oiChg=${oiChangeScore.toFixed(1)} frBias=${frBias} oiConc=${oiConc.toFixed(2)}`
  };
}
module.exports = { assess, calcRiskLevel, calcPositionSize, calcFRBias, calcHeatScore, calcDeviationScore, calcOIChangeScore, THRESHOLDS };
