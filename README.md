# task-management-app

Vue 3 + [Vite+](https://viteplus.dev/) + [Vize](https://github.com/ubugeeei-prod/vize)。

## セットアップ

Nix + direnv で Node と pnpm が入るので、リポジトリに `cd` するだけ。

```sh
direnv allow   # 初回のみ
pnpm install
```

direnv を使わない場合は `nix develop` でシェルに入る。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバ (Vite+) |
| `pnpm build` | 本番ビルド |
| `pnpm preview` | ビルド結果のプレビュー |
| `pnpm test` | Vitest (Vite+ 同梱) |
| `pnpm vize:check` | 型チェック |
| `pnpm vize:lint` | Lint (oxlint + Vize プラグイン) |
| `pnpm vize:fmt` | フォーマット確認 |
| `pnpm vize:fmt:fix` | フォーマット適用 |

`pnpm build` は型チェックを含まない。CI では `vize:check` を別途走らせる。

## エディタ

VS Code は `ubugeeei.vize` 拡張（`.vscode/extensions.json` で推奨済み）。
Vize が SFC のコンパイル・型チェック・フォーマットを担うため、Volar /
`vue-tsc` は入れていない。
