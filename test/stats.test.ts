import { describe, expect, it } from "vitest";
import {
  chiSquarePValue,
  chiSquareUniform,
  erf,
  erfc,
  uniformityReport,
} from "../src/stats";

describe("stats: erf/erfc", () => {
  it("erf(0)=0, erfc(0)=1", () => {
    expect(erf(0)).toBeCloseTo(0, 6);
    expect(erfc(0)).toBeCloseTo(1, 6);
  });
  it("既知値 erf(1)≈0.8427, erf(2)≈0.9953", () => {
    expect(erf(1)).toBeCloseTo(0.8427, 3);
    expect(erf(2)).toBeCloseTo(0.9953, 3);
  });
  it("奇関数: erf(-x) = -erf(x)", () => {
    expect(erf(-0.7)).toBeCloseTo(-erf(0.7), 6);
  });
});

describe("stats: chiSquareUniform", () => {
  it("完全一様(全ビン同数)は χ²=0", () => {
    const counts = new Array(256).fill(10);
    const r = chiSquareUniform(counts);
    expect(r.n).toBe(2560);
    expect(r.df).toBe(255);
    expect(r.chi2).toBeCloseTo(0, 9);
  });
  it("n=0 は chi2=0", () => {
    expect(chiSquareUniform(new Array(256).fill(0))).toMatchObject({ n: 0, chi2: 0, df: 255 });
  });
  it("極端な偏り(1ビンに集中)は χ² が (bins-1)*n 相当で巨大", () => {
    const counts = new Array(256).fill(0);
    counts[0] = 2560;
    const r = chiSquareUniform(counts);
    // 解析解: χ² = (bins-1)*n = 255*2560
    expect(r.chi2).toBeCloseTo(255 * 2560, 3);
  });
  it("既知の小ベクタ(2ビン)", () => {
    // observed [30,10], expected [20,20] → χ² = 100/20 + 100/20 = 10
    expect(chiSquareUniform([30, 10]).chi2).toBeCloseTo(10, 9);
  });
});

describe("stats: chiSquarePValue (Wilson-Hilferty, df=255)", () => {
  it("χ²=0 → p=1", () => {
    expect(chiSquarePValue(0, 255)).toBe(1);
  });
  it("χ²≈平均(=df)は上側pがやや0.5未満(右歪み)", () => {
    const p = chiSquarePValue(255, 255);
    expect(p).toBeGreaterThan(0.44);
    expect(p).toBeLessThan(0.5);
  });
  it("上側5%臨界値≈293.25 で p≈0.05", () => {
    // df=255 の χ²_0.05 ≈ 293.25(統計表)。近似の精度確認。
    const p = chiSquarePValue(293.25, 255);
    expect(p).toBeGreaterThan(0.03);
    expect(p).toBeLessThan(0.07);
  });
  it("極端に大きい χ² → p≈0", () => {
    expect(chiSquarePValue(255 * 10, 255)).toBeLessThan(1e-6);
  });
});

describe("stats: uniformityReport", () => {
  it("一様データは p 高・sufficient", () => {
    const r = uniformityReport(new Array(256).fill(20)); // n=5120
    expect(r.p_value).toBeGreaterThan(0.99);
    expect(r.sufficient).toBe(true);
    expect(r.note).toContain("一様");
  });
  it("偏りデータは p≈0", () => {
    const counts = new Array(256).fill(1);
    counts[0] = 100000;
    const r = uniformityReport(counts);
    expect(r.p_value).toBeLessThan(1e-6);
  });
  it("サンプル不足(n<1280)は sufficient=false と注記", () => {
    const counts = new Array(256).fill(0);
    counts[0] = 10; counts[1] = 5;
    const r = uniformityReport(counts);
    expect(r.n).toBe(15);
    expect(r.sufficient).toBe(false);
    expect(r.note).toContain("サンプルが少な");
  });
  it("n=0 は p_value=null", () => {
    expect(uniformityReport(new Array(256).fill(0)).p_value).toBeNull();
  });
});
