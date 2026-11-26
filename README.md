<img src="assets/icon.svg" width="64" height="64" alt="">

# SFactory

SFactory は、Pi Coding Agent が解いたタスクの手順を JavaScript の Workflow として保存する拡張です。たとえば問い合わせの担当チームと優先度を付ける手順を保存すると、Pi は次の問い合わせを保存済みの `wf_<name>` ツールで処理できます。

![宣言的記憶では記録した解き方を読み直し、手続き記憶では保存した Workflow を実行する](assets/memory-models.svg)

[チケットのデモを試す](#チケットのデモを試す) · [Workflow の書き方](skills/workflow-compile/SKILL.md)

## 解いたタスクを Workflow にする

1. **記録する。** Pi が通常のツールでタスクを解きます。SFactory はツールの呼び出しと結果を記録します。
2. **検証して保存する。** Pi が `workflow_trace` で記録を読み、入力と手順を分けてコードを書きます。`workflow_save` は記録の応答を使ってコードを実行し、必要な更新操作を再現できた場合に保存します。リプレイ中は実際のツールを呼び出しません。
3. **次のタスクで実行する。** Pi が `wf_<name>` を選び、Workflow がツールの呼び出しや条件分岐を処理します。判断が必要な箇所は `decide()` でモデルに問い合わせます。扱えない入力では、実行済みの更新を伝えて残りを Pi に引き継ぎます。

![通常の Agent、Skills、Code Mode、SFactory の実行フロー](assets/execution-models.svg)

Skills は手順書を次のタスクに持ち越します。Code Mode は、そのタスクで使う複数のツール操作をコードにまとめられます。SFactory は、記録で検証したコードを次のタスクでも使えるツールとして保存します。成功した Workflow の実行例も、次にコードを更新するときのリプレイに使います。

## 判断点ごとにモデルを切り替える

チケットの取得や更新はコードで処理し、本文から担当チームを選ぶような判断を `decide()` に渡します。最初は LLM の回答を使い、Decision Model の回答と照合します。回答の一致率などが基準を満たした判断点では、信頼度が十分な回答を Decision Model に任せます。信頼度が低い場合や定期監査では LLM が判断します。

![Workflow の作成、再利用、判断の委譲に伴う大型 LLM の利用量の概念図](assets/workflow-adoption.svg)

同種のタスクを繰り返した場合の概念図です。Compile で Workflow を作るコストがかかり、再利用できる手順が増えると、タスクごとに手順を組み立てる負担が減ります。Shadow で判断点ごとの較正データを蓄積し、条件を満たした判断点は Mature で委譲できます。

## チケットのデモを試す

Node.js 22.19.0 以上で、リポジトリのルートから実行します。

```sh
npm ci
npm run demo:reset -- 1
npm run pi
```

Pi で `/login` を実行し、利用するモデルのプロバイダを設定します。Decision Model の利用には別途、対応する分類モデルへのアクセスが必要です。LLM のみで試す場合は `npm run pi:wf` で起動します。

1. 「未処理のサポートチケットをトリアージして。担当チームと優先度を付けて」と依頼します。
2. `/tickets reset 2` でチケットを入れ替え、同じ依頼をします。
3. 「いまのトリアージを再利用できるようにして」と依頼します。リプレイに通ると、`workflow_save` の結果に登録された `wf_<name>` が表示されます。
4. `/tickets reset 4` を実行し、保存済みの Workflow でトリアージを依頼します。`/wf` で Workflow の状態と実行回数を確認できます。
5. `/tickets reset 3` で通常の分類に当てはまらないチケットが混ざるバッチを用意します。Workflow が扱えないチケットで停止した場合は、Pi が残りを引き継ぎます。

API キーを使わずに一連の動作を確認するには、`npm test` を実行します。疑似モデルで初回実行、保存、再利用、エスカレーションを確認できます。

## 設定と保存先

| コマンド | 起動する構成 |
|---|---|
| `npm run pi:base` | Pi とデモ用のチケットツール |
| `npm run pi:codemode` | Pi と Code Mode |
| `npm run pi:wf` | Code Mode と Workflow Memory。判断には LLM を使います。 |
| `npm run pi` | Code Mode と Workflow Memory。利用可能な Decision Model があれば較正します。 |

<details>
<summary>環境変数と Workflow の状態</summary>

| 環境変数 | 設定 |
|---|---|
| `SFACTORY_DECIDE` | `auto` が既定です。`llm` で LLM のみを使用します。 |
| `SFACTORY_CLASSIFIER` | Decision Model を `provider/id` で指定します。既定は利用可能な最初の分類モデルです。 |
| `SFACTORY_ASK_MODEL` | `decide()` と `ask()` が使うチャットモデルです。既定はセッションのモデルです。 |
| `SFACTORY_MIN_SAMPLES` | 判断の委譲を検討するために必要な比較数です。既定は 20 です。 |
| `SFACTORY_TERMINATE` | `1` で `trusted` な Workflow の成功後に要約ターンを省きます。 |

新規保存時は `candidate`、初回成功で `probation`、成功が3回に達すると `trusted` になります。実行に失敗すると成功のカウントをリセットし、状態を1段戻します。エスカレーションの回数は別に記録します。

Workflow は QuickJS で実行します。保存時とコードのハッシュやツールのスキーマが異なる場合は実行を拒否します。既定の上限はツール呼び出し200回、`decide()` と `ask()` の合計200回、実行時間5分です。

```text
.pi/traces/                     Pi の実行記録。直近50件
.pi/workflows/<name>/
  workflow.js                   保存済みのコード
  meta.json                     実行状態、統計、判断点ごとの較正データ
  fixtures/                     リプレイに使う実行記録
  versions/                     過去のコード
  runs/                         失敗時とエスカレーション時の記録
```

</details>
