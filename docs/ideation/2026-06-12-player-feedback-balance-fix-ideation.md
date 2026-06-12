---
date: 2026-06-12
topic: player-feedback-balance-fix
focus: プレイヤーフィードバック5件(中盤無理ゲー/F2スクショ/除染無効化/÷2並び/x2連動の理不尽)への修正計画
mode: repo-grounded
---

# Ideation: 軍勢ゲートシューター — プレイヤーフィードバック修正計画

## Grounding Context

**Codebase Context** (index.html 単一ファイル、1405行、HTML5 canvas):
- 敵HP (l.238-243): `enemyBaseHp() = ceil((lv²×1.3 + lv×4 + 2) × (1 + power/800)^0.8)`、power = soldiers×(1+rank×0.1) を毎スポーン即時参照(ラバーバンド)。lv = floor(time/18)+1 で時間二次成長。
- プレイヤーDPS: lanes = min(√soldiers, 12)、弾ダメ = soldiers/lanes/3 → DPSは兵数線形。線形 vs 二次×power^0.8 が中盤の壁(fb1)。
- x2ゲート即時適用 → 次スポーンHP約1.74倍(2^0.8)= fb5。
- ゲート生成 (l.444-472): lv5以降60%で「片方良ゲート保証」消失、anyPool独立2回抽選 → ÷2|÷2 が確率発生(fb4)。負ゲート値は兵数線形 `soldiers×0.12`。
- ゲート撃ち込み (l.793-815): 弾1発 = 固定+1。負値は兵数比例で膨らむため除染が形骸化(fb3)。
- skipEffect (l.486-489): ÷2を捨てても敵数x2(罠回避への二重罰)。
- スクリーンショット機能なし(fb2)。

**External Context** (Webリサーチ):
- Supersonicゲートランナー指針「挑戦は線形、報酬は指数的に」。
- Vampire Survivors: 敵は時間スケール、パワー非直結 → 無双ウィンドウが快感の核。
- TDバランス論: 高パワー帯はHPでなく敵数をスケール(弾スポンジ=壁感、群れ=爽快)。
- DDA研究: パワー直結ラバーバンドはトレッドミル化して動機を殺す。階段カーブ+息継ぎ谷。
- ジャンル慣習: ÷2|÷2ペアは出さない(テトリス7-bagが同型問題の標準解)。
- インタラクションスケーリング: パワー比例値への固定増分は必然的に形骸化。

過去学習: docs/solutions/ なし(スキップ)。Issue intelligence: 該当なし。

## Topic Axes

- A. 敵スケーリング曲線(lv²成長・パワー連動ラバーバンド)
- B. ゲート生成ロジック(罠ペア保証・÷2並び・負値スケール)
- C. ゲート撃ち込みインタラクション(除染・成長の有効性維持)
- D. 捨てゲートペナルティと納得感(pendingMod・敵強化の公平感)
- E. プレイ体験ユーティリティ(スクリーンショット・計測)

## Ranked Ideas

### 1. 敵のパワー追従を「遅延EMA」化+指数引き下げ
**Description:** `enemyBaseHp()` の即時 `state.soldiers` 参照を時定数約15秒のEMA(`trackedPower += (power - trackedPower) × dt/15`)に差し替え、指数を ^0.8 → ^0.6 へ。x2直後は敵が「古い兵力」を見ているため約15秒の無双ウィンドウが構造的に保証される。
**Axis:** A
**Basis:** direct: l.241 `Math.pow(1 + power / 800, 0.8)` が fb5「x2の瞬間に敵も実質x2」の直接原因。external: Vampire Survivors 時間スケール、DDA研究のトレッドミル批判。
**Rationale:** 5/6フレームが独立収束。最小の式変更で「成長が報われる窓」を構造保証。
**Downsides:** ÷2直後も敵が即弱体化しない(緊張感として許容)。
**Confidence:** 90% / **Complexity:** Low / **Status:** Explored

### 2. HPスポンジをやめ「敵の数」でスケール
**Description:** powerスケールに上限(3.0)を設け、超過分を湧き間隔短縮・同時湧き数増加に振替。高兵力時は「薄い大群を薙ぎ払う」体験へ。
**Axis:** A
**Basis:** external: TDバランス論「高パワー帯は数をスケール」。direct: fb1 の壁 = lv²×power^0.8 の単一HP集中。
**Rationale:** 5/6フレーム収束。オーバーキル稲妻・コンボ熱という既存の爽快装置が多数撃破で輝く。
**Downsides:** 描画負荷増。係数調整に計測(案7)が必要。
**Confidence:** 75% / **Complexity:** Medium / **Status:** Explored

### 3. ゲートペア禁則 — ÷2|÷2 を生成不能に
**Description:** `spawnGatePair()` で両側決定後にバリデーション: 同種罠ペア(÷2|÷2 等)は再抽選、罠ペア連続出現はクールダウン。「両方罠あり得る」緊張感は残す。
**Axis:** B
**Basis:** direct: l.459-461 の独立抽選で ÷2|÷2 が必然発生(fb4)。external: テトリス7-bag、ジャンル慣習。
**Rationale:** 6/6フレーム収束。難易度を下げずに「頭が悪い」事故だけを消す。
**Downsides:** ほぼなし。
**Confidence:** 95% / **Complexity:** Low / **Status:** Explored

### 4. 除染を弾ダメージ比例化+負ゲート値の対数化
**Description:** l.800 `side.val += 1` を負ゲートに対し弾ダメージ比例(×0.5、0クロス時は+1にクランプ)へ。生成側 l.455 の `soldiers×0.12` 線形項を対数化。進化判定(hits)は発数のまま。
**Axis:** C
**Basis:** direct: 負値は兵数比例・除染は固定+1という片務的非対称が fb3 の根因。external: 固定増分の形骸化原則。
**Rationale:** 6/6フレーム収束。「撃って除染」という固有の動詞を全ゲーム期間に蘇らせる。
**Downsides:** 係数は要プレイテスト。
**Confidence:** 95% / **Complexity:** Low / **Status:** Explored

### 5. skipEffect の意味論修正 — 罠を捨てても敵は強化されない
**Description:** l.488 の「÷2捨て→敵x2」を廃止。敵が拾って得をするのは正の価値物(+N, x2)のみ。罠は捨てても無害(自壊)。
**Axis:** D
**Basis:** direct: l.488 コメント「mul も div も敵が増える」— 罠回避という正しいプレイへの二重罰。reasoned: 世界観(敵が拾う)と効果の因果一致で⚠警告が意思決定情報になる。
**Rationale:** fb4 の÷2ペアを実質詰みにし fb1 の壁を増幅していた負のループを断つ。
**Downsides:** 「捨てる」緊張感が良ゲート側に限定される(本来の姿)。
**Confidence:** 85% / **Complexity:** Low / **Status:** Explored

### 6. F2スクリーンショット(スタッツ刻印付き)
**Description:** keydown に F2 分岐+preventDefault。canvas.toBlob() → PNG保存、兵数・★・WAVE・スコア・日時を帯状に焼き込み。シャッターフラッシュ+音。F12はDevTools衝突のため不採用。
**Axis:** E
**Basis:** direct: fb2。canvasは直接toBlob可能、外部依存ゼロ。
**Rationale:** 6/6フレーム収束。★昇華・高コンボの自慢動線。
**Downsides:** ほぼなし。
**Confidence:** 95% / **Complexity:** Low / **Status:** Explored

### 7. バランス計測HUD(F3デバッグオーバーレイ)
**Description:** F3 でDPS/敵HP/TTK/trackedPower vs 実パワー/湧き間隔を表示。30秒splitsにバランス指標を同梱。
**Axis:** E
**Basis:** reasoned: バランス変更4件の検証手段。体感頼みの調整往復を防ぐ複利装置。
**Rationale:** 修正計画自体の検証コストを恒久的に下げる。
**Downsides:** プレイヤー向け価値ゼロ(開発用)。
**Confidence:** 70% / **Complexity:** Low-Medium / **Status:** Explored

### 8. 死亡後復活(亡霊隊長)の削除 — ユーザー追加指示
**Description:** ラストスタンド/亡霊隊長システム(onSquadDeath → ghost 10秒 → ゲートで復活)を削除し、全滅は即ゲームオーバーにする。
**Axis:** D
**Basis:** direct: ユーザー指示「死亡後復活現状だと意味をなしてないのでやめましょう」。復活直後も敵HPは死亡時兵力基準のままで、少数復活兵では即溶けるため機能していない。
**Rationale:** 機能しない救済はゲームオーバーの儀式を長引かせるだけ。削除でコードも体験も単純化。
**Downsides:** 1ラン1回の保険がなくなる(現状でも保険として機能していないため実害なし)。
**Confidence:** 95% / **Complexity:** Low / **Status:** Explored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | TTK逆算の階段カーブ(全面再設計) | 案1+2で壁は解消見込み。修正計画の規模を超える |
| 2 | 逆ラバーバンド救済(ピンチ時良ゲート保証) | フィードバック対応に不要な新システム。後日候補 |
| 3 | ÷2を「精鋭化ゲート」に反転 | 経済システム変更を伴う。ブレインストーム変種 |
| 4 | ÷2ゲートも撃って解体できる | fb4は案3で十分。有望だが機能追加 |
| 5 | 撃ち切りで「反転ゲート」化(敵デバフ) | 新メカニクス追加。ブレインストーム変種 |
| 6 | 捨てゲートを撃って破壊しペナルティ無効化 | 案5で納得感は回復。ゲージUI追加はスコープ超過 |
| 7 | シャッフルバッグ式デッキ生成 | 案3(禁則リロール)に統合 — 同目的でより小さい差分 |
| 8 | 負ゲート対数化(単独案) | 案4に統合(生成側と除染側の両面修正) |
| 9 | ゲート貫通(addゲートの弾吸収を減衰貫通に) | 保留 — 吸収するのはaddゲートのみ(mul/divは素通り)。案4の比例除染で赤ゲートの吸収時間帯が大幅短縮されるため当面対処不要(ユーザー確認済み 2026-06-12) |

フィードバック対応マップ: fb1→案1+2 / fb2→案6 / fb3→案4 / fb4→案3+5 / fb5→案1。
