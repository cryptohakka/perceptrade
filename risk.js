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
// 0.0001以下=0, 0.001以上=100
function calcHeatScore(avgFR) {
  return Math.min(100, Math.max(0, (Math.abs(avgFR) - 0.0001) / (0.001 - 0.0001) * 100));
}

// 軸2: CEX間乖離リスク (frDeviation)
// 0.0001以下=0, 0.001以上=100
function calcDeviationScore(frDeviation) {
  return Math.min(100, Math.max(0, (frDeviation - 0.0001) / (0.001 - 0.0001) * 100));
}

function assess(marketData) {
  const { sources, avgFR, frDeviation } = marketData;

  const heatScore = calcHeatScore(avgFR);
  const deviationScore = calcDeviationScore(frDeviation);
  const riskScore = heatScore * 0.5 + deviationScore * 0.5;

  const level = calcRiskLevel(riskScore);
  const frBias = calcFRBias(sources);
  const oiConc = calcOIConcentration(sources);

  return {
    riskScore,
    heatScore,
    deviationScore,
    riskLevel: level,
    frBias,
    oiConcentration: oiConc,
    avgFR,
    frDeviation,
    summary: `risk=${level} score=${riskScore.toFixed(1)} heat=${heatScore.toFixed(1)} dev=${deviationScore.toFixed(1)} frBias=${frBias} oiConc=${oiConc.toFixed(2)}`
  };
}

module.exports = { assess, calcRiskLevel, calcPositionSize, calcFRBias, calcHeatScore, calcDeviationScore, THRESHOLDS };
