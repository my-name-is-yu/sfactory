# 実験環境

SFactory が「解いた経験から Workflow を自律的に獲得し、再利用し、判断を Decision Model に移していけるか」を、実モデルで検証するための環境です。Workflow や回答は一切用意していません。モデルが課題を解く過程で `workflow_save` を自分で呼ぶかどうか、呼んだ結果どうなるかを記録します。

## 準備

```sh
npm ci
export OPENAI_API_KEY=sk-...        # これ1つで大型モデルも Decision Model も動きます
npm run exp -- doctor               # 認証と、それぞれ1回の実呼び出しを確認
```

すべて OpenAI API で動きます。大型モデルは Responses API の `openai/gpt-6.1-terra`、Decision Model は Decisions API の `openai/gpt-6-luna` です。`openai` プロバイダに OAuth でログインしていると Decisions API が使えないので、その場合は `npx pi auth logout openai` でログアウトしてください。構成 A・B・D は大型モデルだけを使います。

別のモデルで比べるときは `--model openai/gpt-5.6-terra` のように指定します。Codex OAuth を使う場合は `npx pi auth login openai-codex` のうえ `--model openai-codex/gpt-5.6-terra` です。

## 実行

```sh
npm run exp -- list                                   # エピソード一覧(正解は表示しません)
npm run exp -- run --arms A,E --limit 1 --out runs/smoke   # 最小の通し確認: 2構成 × 4試行
npm run exp -- run --out runs/tickets-1               # チケット課題の全体: 5構成 × 20試行
npm run exp -- run --task ci --out runs/ci-1          # CI課題
npm run exp -- report --out runs/tickets-1            # report.md と summary.json を作り直す
```

中断しても同じ `--out` で再実行すれば、終わった試行は飛ばして続きから走ります。主なオプションは `--model`(既定 `openai/gpt-6.1-terra`)、`--classifier`(既定 `openai/gpt-6-luna`)、`--thinking`(既定 `low`)、`--phases`、`--repeat`、`--timeout`、`--min-samples` です。

出力は次のとおりです。

```
runs/<name>/report.md                       集計表
runs/<name>/summary.json                    同じ内容の数値
runs/<name>/rep0/<構成>/trials/NNN-*.json    試行ごとの全記録
runs/<name>/rep0/<構成>/trials/NNN-*.transcript.jsonl   発話・ツール呼び出し・SFactory のイベント
runs/<name>/rep0/<構成>/memory/.pi/          その構成が獲得した Workflow と記録
```

## 段階的な進め方

本番の前に、開発用データ(`train` と `calib`)だけで次の段階を1つずつ成立させます。`test` と `adapt` は、システムを凍結するまで走らせません。直してよいのはシステム側(保存ゲート、手順書、ツールの説明文)だけで、データ・正解・依頼文は触りません。

| 段階 | コマンド | 合格条件 |
|---|---|---|
| 0. 再現 | `npm test` | スモークで拒否された実モデルの保存が、いまのゲートで通る(`test/fixtures/smoke-refused.json`) |
| 1. 獲得 | `for r in 0 1 2; do npm run exp -- run --arms D --phases train --repeat $r --out runs/s1; done` | 3反復中2回以上で、3試行目までに保存が成立 |
| 2. 再利用 | `for r in 0 1; do npm run exp -- run --arms A,D --phases train,calib --repeat $r --out runs/s2; done` | `calib` 4試行中3回以上で `wf_*` が使われ、項目正答率が A を下回らず、ターン数が減る |
| 3. 比較 | `npm run exp -- run --arms E --phases train,calib --out runs/s3` | Decision Model が裏で呼ばれ、判断点ごとの一致率が記録される |
| 4. 委譲 | `npm run exp -- run --arms E --phases train,calib --min-samples 10 --out runs/s4` | 判断点が1つ以上昇格し、単独採用と監査の一致率が出る |
| 5. 本番 | コミットしてから `for r in 0 1 2; do npm run exp -- run --repeat $r --out runs/final; done` | 合否なし。結果をそのまま報告 |

各段階の打ち切りは修正5回です。それでも通らなければ、成立しなかったこと自体を結果として残します。

2026年11月26日に段階0〜3を実行し、すべて合格しました。段階3で既定の設定のまま判断点が昇格したので、段階4は実行していません。段階5(本番)はまだです。本番は3反復で300試行、$6〜8、2〜3時間の見込みです。

調べるための道具は次のとおりです。

```sh
npm run exp -- inspect --out runs/s1 --arm D --trial 2            # 1試行の発話・ツール呼び出し・SFactoryの動き
npm run exp -- inspect --out runs/s1 --arm D --trial 2 --full     # 省略なし
npm run exp -- replay  --out runs/s1 --arm D                      # 直近の workflow_save を保存ゲートにかけ直す(モデルを呼びます)
npm run exp -- run --arms D --phases train --episodes train-2 --out runs/x   # 特定のエピソードだけ
```

`workflow_save` の呼び出しは、通っても拒否されても `memory/.pi/workflows/_attempts/` に内容と判定が残ります。`replay` はそれを読みます。

## 比較する構成

| | 構成 | Code Mode | Decision Model | Workflow Memory |
|---|---|---|---|---|
| A | Pi 標準 | | | |
| B | Pi + Code Mode | ✓ | | |
| C | Pi + Code Mode + Decision Model | ✓ | スクリプトから `models.classify` | |
| D | Pi + Code Mode + Workflow Memory | ✓ | | ✓(`decide()` は常に大型モデル) |
| E | SFactory 全部入り | ✓ | ✓ | ✓(判断点ごとに移行) |

C では Decision Model を使うかどうかはモデル次第です。使わなければ B と同じ挙動になり、それも結果として記録されます。

全構成で、ツールは課題用ツールと `read` だけです。`bash`・`edit`・`write` などは外してあります。正解データを隔離するためで、条件は全構成で同じです。

## 試行と記憶

- 1試行 = 新しい Pi セッション + 新しい世界(チケットや CI Run の状態)。会話履歴は引き継ぎません。
- 構成 D・E だけ、その構成専用の `memory/` ディレクトリ(Workflow と実行記録)を試行間で引き継ぎます。構成どうしで記憶は共有しません。
- フェーズは既定で `train → calib → test → adapt` の順です。

| フェーズ | データ | 学習 |
|---|---|---|
| `train` | 学習用 | する |
| `calib` | 較正用 | する(判断点が比較サンプルをためる) |
| `test` | 未見評価用 | **凍結** |
| `adapt` | 例外・適応評価用 | **凍結** |
| `test-online` / `adapt-online` | 同上 | する(`--phases` で指定したときだけ) |

凍結フェーズでは、各試行がフェーズ開始時点の記憶のコピーから始まり、終わるとコピーを捨てます。保存・記録・較正・昇格はすべて止まり、`workflow_save` などのツール自体が見えなくなります。試行どうしが影響し合うこともありません。

## 課題

### Support Ticket Triage

既存の `tickets_*` ツールをそのまま使います。ルーティング方針は `tickets_policy` で読めるガイドにあり、依頼文には書いていません。チーム、優先度、ステータスを設定し、対象外のチケットはガイドどおりに扱い、漏れがないか確認します。

チケットはすべて手書きで、分割間の重複はありません(学習24、較正36、未見32、適応67)。次のようなものを含みます。

- 言葉づかいが別のチームを指しているもの(「返金」と書いてあるが原因は不具合、など)
- 口調と緊急度が逆のもの(大文字で急かす機能要望、穏やかに書かれた進行中のデータ消失)
- 対象外(法的要請、営業、取材、スパム、判読不能)と、他言語のチケット

適応用エピソードは次の9種類です。

| エピソード | 内容 | 学習済み Workflow の適合 |
|---|---|---|
| `adapt-paraphrase` | 依頼が日本語 | そのまま使える |
| `adapt-volume` | 26件。一覧が3ページに分かれる(学習中は常に1ページ) | そのまま使えるはずだが、ページ送りを知らないと取りこぼす |
| `adapt-partial` | ロックされて更新できないチケットと、1回目だけ失敗する更新 | 同上 |
| `adapt-unknown` | 大半が対象外 | 同上 |
| `adapt-pending` | open ではなく pending のキューが対象。open には触れてはいけない | 変更が必要 |
| `adapt-extra` | 緊急のものだけ返信案も保存する | 追加の手順が必要 |
| `adapt-drift` | ガイドが v2 になり security チームが増える | 判断基準を固定していると誤る |
| `adapt-close-product` | 別の作業(triaged かつ product のものを閉じる) | **使うと誤り** |
| `adapt-draft-billing` | 別の作業(billing のものに返信案だけ) | **使うと誤り** |

### CI Failure Triage

模擬 CI を `ci_*` ツールで提供します。失敗した Run の一覧、ログ(末尾・検索・範囲指定)、PR の Diff、main での過去10回の結果とそのログ、診断の保存です。原因は regression / flaky / infra / dependency / config / unknown の6分類で、同じ原因の Run には同じ `cause_key` を付けます。

根本原因は20種類あります。ログの末尾や目立つ単語が原因と一致しないもの(タイムアウトに見えるデッドロック、後始末の接続エラーの手前にある本当の例外、Diff が近くを触っているだけの flaky、PR が CI 設定を変えたことによる失敗)を含みます。

チケット課題より小さく、適応用エピソードは既出の原因を別の条件で組み直したものです。

## 正解の隔離

- 正解は Verifier だけが読みます。ツールが返すデータには含まれません(テストで確認しています)。
- 世界の状態は実行プロセスのメモリ上にあり、試行ディレクトリにファイルとして置きません。
- `read` は試行ディレクトリ、手順書、ツールが参照を指示する Pi のドキュメントに限定しています。それ以外を読もうとした回数は `jailBlocks` に記録します。
- 並び順と ID はエピソードごとに決定的にシャッフルしており、位置から正解は分かりません。

## Verifier

最終状態と書き込み記録だけを読む決定的な関数です。モデルの発話は採点に使いません。

- **成功**: 変更すべき項目がすべて要求どおりの最終状態になり、変更してはいけないものが変わっていない。
- 項目ごとの正答数、手つかずの項目数(処理漏れ)も記録します。
- 副作用は、状態を変えなかった書き込み(重複・不要)、禁止された対象への書き込み、巻き添えで変わった項目、環境に拒否された書き込み、拒否後の再試行に分けて数えます。
- タイムアウトやエラーで終わった試行は失敗として数え、その時点の世界をそのまま採点します。

## 計測

モデル呼び出しは発生源ごとに数えます。

| 発生源 | 取り方 |
|---|---|
| Agent Loop | アシスタントメッセージごとの usage |
| Workflow 実行中の `decide()` / `ask()` | SFactory のテレメトリ(Agent Loop を通らない) |
| `workflow_save` のリプレイ中の判断 | 同上。検証コストとして別枠 |
| SFactory の Decision Model 呼び出し | 同上 |
| スクリプトからの `models.classify` | codemode のツール結果 |

大型モデルの合計は上の3つ(Agent Loop + 実行中の判断 + リプレイ中の判断)の和です。そのほか次を記録します。

- Decision Model: 呼び出し数、単独で採用された回数、Shadow、監査、確信度不足によるフォールバック、不一致
- Workflow: `workflow_save` の回数、保存、拒否、修復(v2以降)、類似実行の通知、再利用、誤適用、使えたのに使わなかった回数、エスカレーション、実行失敗
- 判断点ごとの較正状態(階層、閾値、サンプル数、一致率)を試行後ごとに
- 実行時間、累積トークン、累積コスト

## 既知の限界

- **実モデルで走らせたのは開発用データ(`train` と `calib`)の段階1〜3だけです。** 結果はルートの [README](../README.md#これまでの実験結果) と [results/2026-11-26-dev/](results/2026-11-26-dev/) にあります。未見評価用と例外・適応評価用のデータ、および CI 課題は、実モデルではまだ走らせていません。
- **Decision Model に任せる信頼度の下限は設けていません。** 開発用の実行では、一致率が高かったために閾値が観測された最低の信頼度まで下がりました。未見データで誤った回答を採用する恐れがあります。
- **学習用の1件(メールアドレスの変更方法を尋ねるチケット)は正解ラベルが疑わしいです。** ガイドの「やり方の質問は product」に従うとモデルの答えのほうが妥当に見えます。全構成に同じように効くので、構成間の比較は歪めませんが、`train-2` の成功率を下げています。
- 正解ラベルは1人で付けています。ガイドの文面から決まるように書きましたが、評価者間の一致は測っていません。厳密な成功率と項目正答率の両方を見てください。
- 「生成・検証・修復コスト」のうち Agent Loop の分は、`workflow_*` の呼び出しか手順書の読み込みを含むターンの usage として近似しています。コードを考えただけのターンは含まれません。リプレイ分は正確です。
- 1セル1回では試行間のばらつきが分かりません。`--repeat 1`, `--repeat 2` と分けて走らせると、それぞれ独立の記憶で繰り返せます。
- USD は Pi のカタログ価格からの計算値で、請求額そのものではありません。
- CI 課題は原因20種と小さく、較正に十分なサンプルはたまりません。

## 評価方法で参考にしたもの

| 研究 | 取り入れた点 |
|---|---|
| τ-bench | 発話ではなく最終状態で採点。方針は環境側の文書として与える |
| SkillsBench | 試行ごとに新しい環境。決定的な Verifier |
| SkillCache | cold → 獲得 → warm の流れ。獲得コストを warm の数字と分けて記録 |
| FlashScript | 未見インスタンスでの汎化。1例だけから作ったプログラムが汎化しない点の検証 |
| AnyS1 | 較正用データの分離。判断点ごとの閾値。Decision Model の寄与は構成 D と E の差で見る |
| Harness as a Language | 自己改善あり・なしを同じ課題列で比較 |
