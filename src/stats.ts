// 乱数の質の可視化・検定(依存ゼロの純関数)。
//
// 重要: 乱数バイト(0–255)は**一様分布**に従うのが正常であって、正規分布ではない。
// 各値の出現回数がフラット(≒ n/256)なら健全。χ²適合度検定(df=255)で一様性を検定する。
// (「複数バイトの合計」は中心極限定理で正規に近づくが、それは別の話。)

// 標準正規の誤差関数 erf(x)。Abramowitz & Stegun 7.1.26(最大誤差 ~1.5e-7)。
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function erfc(x: number): number {
  return 1 - erf(x);
}

export interface ChiSquareResult {
  n: number;      // 総サンプル数
  chi2: number;   // χ²統計量
  df: number;     // 自由度(= bins - 1)
}

// 一様分布に対するχ²適合度統計量。counts は各値の出現回数(既定256ビン=0..255)。
export function chiSquareUniform(counts: number[]): ChiSquareResult {
  const bins = counts.length;
  const df = bins - 1;
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return { n: 0, chi2: 0, df };
  const expected = n / bins;
  let chi2 = 0;
  for (const o of counts) {
    const d = o - expected;
    chi2 += (d * d) / expected;
  }
  return { n, chi2, df };
}

// χ²分布の上側p値 P(χ²_df > x)。Wilson–Hilferty 近似(df が大きいほど高精度で、
// 今回の df=255 では十分)。(χ²/df)^(1/3) が平均 1-2/(9df)・分散 2/(9df) の正規に従う。
export function chiSquarePValue(chi2: number, df: number): number {
  if (df <= 0 || !Number.isFinite(chi2)) return NaN;
  if (chi2 <= 0) return 1;
  const mean = 1 - 2 / (9 * df);
  const sd = Math.sqrt(2 / (9 * df));
  const z = (Math.cbrt(chi2 / df) - mean) / sd;
  const p = 0.5 * erfc(z / Math.SQRT2); // 上側 P(Z > z)
  return Math.min(1, Math.max(0, p));
}

export interface UniformityReport {
  n: number;
  histogram: number[];      // 長さ256
  chi2: number;
  df: number;
  p_value: number | null;   // n=0 のとき null
  sufficient: boolean;      // 期待度数が各ビン5以上(n>=1280)か
  note: string;
}

// drops.byte の出現回数配列(長さ256)から一様性レポートを作る。
export function uniformityReport(histogram: number[]): UniformityReport {
  const { n, chi2, df } = chiSquareUniform(histogram);
  const p_value = n > 0 ? chiSquarePValue(chi2, df) : null;
  const sufficient = n >= 1280; // 期待度数 n/256 >= 5
  const note = sufficient
    ? "0–255は一様分布に従うのが正常(正規分布ではない)。p>0.05なら一様性と矛盾しない。"
    : "サンプルが少なく検定の信頼性は低い(各値の期待度数が5未満)。n≥1280で安定。";
  return { n, histogram, chi2, df, p_value, sufficient, note };
}
