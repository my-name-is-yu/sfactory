<img src="assets/icon.svg" width="64" height="64" alt="">

# SFactory

Pi Coding Agent 向けの Workflow Memory 拡張です。エージェントが解いたタスクを、次回以降は再構築せずに実行できる JavaScript プログラムとして蓄積します。

- **Workflow はツール**: 保存した Workflow は `wf_<name>` という Pi のツールになり、codemode と同じ QuickJS サンドボックスで動きます。適用するかどうかはモデルの通常のツール選択です。
- **リプレイゲート**: 記録済みの実行を副作用なしで再生し、同じ副作用を再現できたコードだけを保存します。
- **判断カスケード**: `decide()` は最初 LLM が答え、Decision Model が裏で同じ質問に答えます。一致が十分たまった判断点から Decision Model に切り替わります。
- **エスカレーション**: 想定外の入力では止まり、適用済みの副作用の一覧を付けてメインの LLM に戻します。

## 試す

Node 22 以上が必要です。

```sh
npm install
npm test          # キー不要。疑似モデルで cold → 保存 → warm → escalate まで通します
```

実モデルで試すには、Pi にプロバイダの認証を入れます(`npm run pi` を起動して `/login`、または `ANTHROPIC_API_KEY` などの環境変数)。Decision Model を使う場合は `TYPESAFE_API_KEY` や `OPENROUTER_API_KEY` など、`models.classify` が使えるプロバイダの認証も必要です。なくても動き、その場合 `decide()` は常に LLM が答えます。

デモ用に小さなサポート窓口(`tickets_*` ツール)が付いています。

```sh
npm run demo:reset -- 1     # バッチ1のチケットを用意
npm run pi
```

Pi の中で次の順に試します。

1. `未処理のサポートチケットをトリアージして。チームのラベルと優先度を付けて` (1回目。普通に解きます)
2. `/tickets reset 2` のあと、同じ依頼をもう一度。似た実行があったという通知が出ます
3. `いまのトリアージを再利用できるようにして` (モデルが `workflow_trace` で記録を読み、`workflow_save` で保存します)
4. `/tickets reset 4` のあと、同じ依頼。今度は `wf_*` を1回呼ぶだけで終わります
5. `/tickets reset 3` のあと、同じ依頼。どのカテゴリにも当てはまらないチケットで止まり、残りをモデルが引き継ぎます
6. `/wf` で状態、実行回数、Decision Model に移った判断点の数を確認できます

## 4構成の比較

| コマンド | 構成 |
|---|---|
| `npm run pi:base` | Pi 標準 |
| `npm run pi:codemode` | Pi + Code Mode |
| `npm run pi:wf` | + Workflow Memory (`decide()` は常に LLM) |
| `npm run pi` | + Decision Model |

実行ごとのターン数とトークン数は `.pi/traces/*.json` に残ります。4構成を自動で回して集計するランナーはまだありません。

## Workflow の書き方

モデル向けの手順は [skills/workflow-compile/SKILL.md](skills/workflow-compile/SKILL.md) にあります。コードは async 関数の本体です。

```js
const { tickets } = await tools.tickets_list({ status: input.status });
for (const t of tickets) {
  const full = await tools.tickets_get({ id: t.id });
  const category = await decide({
    id: "category",
    state: { subject: full.subject, body: full.body },
    type: "choice",
    instructions: "Which team should handle this support ticket?",
    criteria: { billing: "Charges, refunds, invoices", bug: "Something is broken" },
  });
  await tools.tickets_update({ id: t.id, label: category.answer, status: "triaged" });
}
```

| グローバル | 役割 |
|---|---|
| `input` | 入力(JSON Schema で検証済み) |
| `tools.<name>(args)` | 記録済みの実行で使われたツールだけが使えます |
| `decide({ id, state, type, instructions, criteria })` | 有限の選択肢からの判断。`choice` / `bool` / `score` |
| `ask(prompt, state, schema)` | 短い型付き生成 |
| `escalate(reason, state)` | 中止してメインの LLM に戻す。スクリプトからは捕捉できません |

## 保存されるもの

```
.pi/workflows/<name>/workflow.js      プログラム
.pi/workflows/<name>/meta.json        状態・統計・判断点の較正(ランタイムが管理)
.pi/workflows/<name>/fixtures/        新しい版が必ず再現すべき記録
.pi/workflows/<name>/versions/        過去の版
.pi/workflows/<name>/runs/            失敗・エスカレーションした実行の記録
.pi/traces/                           エージェント実行の記録(直近50件)
```

状態は `candidate` → `probation`(初回成功) → `trusted`(3回連続成功)と進み、失敗で1段戻ります。

## ランタイムが保証すること

- 保存は `workflow_save` 経由のみ。`write` / `edit` と、書き換えに見える `bash` は `.pi/workflows` に対してブロックされます(`bash` は文字列の一致による検出で、完全ではありません)
- `workflow.js` が保存時のハッシュと一致しなければ実行しません
- 使うツールのスキーマが保存時から変わっていれば、古いものとして実行しません
- Workflow の中から別の Workflow、`workflow_save`、`codemode` は呼べません
- ツール呼び出し200回、判断200回、5分の上限があります

## 環境変数

| 変数 | 意味 |
|---|---|
| `SFACTORY_DECIDE` | `auto`(既定)または `llm` |
| `SFACTORY_CLASSIFIER` | Decision Model を `provider/id` で指定。既定は利用可能な最初のもの |
| `SFACTORY_ASK_MODEL` | `decide()` / `ask()` に使うチャットモデル。既定はセッションのモデル |
| `SFACTORY_MIN_SAMPLES` | 判断点を Decision Model に移すまでに必要な比較数。既定 20 |
| `SFACTORY_TERMINATE` | `1` で、trusted な Workflow の成功後に要約のターンを省きます |

## 構成

| パス | 内容 |
|---|---|
| `extensions/sfactory/index.ts` | Pi との接続: 記録、ツール、ガード |
| `extensions/sfactory/src/engine.ts` | サンドボックスでの実行、上限、エスカレーション |
| `extensions/sfactory/src/replay.ts` | リプレイゲート |
| `extensions/sfactory/src/decide.ts` | 判断カスケードと較正 |
| `extensions/sfactory/src/store.ts` | ディスク上の Workflow と記録 |
| `demo/` | デモ用のチケットツール |
| `test/` | 単体テストと、疑似モデルによる E2E |
