# market/

DSH 市场索引（format 1）。`dsh-market.example.json` 是**占位模板**：发布前把
`repository.url`、`source.url`、`source.commit` 换成真实仓库地址与提交哈希
（可参照 dsh-provider-proxy 仓库的 `pnpm check:market` / `pnpm release:market` 流程校验与生成）。

公开市场收录还需要：GitHub 仓库打上 `dsh-plugin` topic；向 awesome-deepseek-harness 提收录 PR。
