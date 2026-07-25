# host — 物理源泉をホストに繋ぐ側の実装

ガイガー基板 + ESP32(`firmware/geiger`)を USB で挿した計算機側で動くもの。

| ディレクトリ | 役割 |
|---|---|
| [`tubed`](tubed) | USB シリアルから 32B ブロックを読み、`/dev/random` と kuda に配る常駐デーモン (Rust) |

Worker 側(`src/`)とはネットワーク越しの `POST /ingest` でしか繋がらない。
仕様は `docs/tubed-spec.md`。
