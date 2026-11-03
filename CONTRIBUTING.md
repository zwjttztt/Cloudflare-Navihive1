# 贡献指南（Contributing）

完整流程见 [`docs/contributing.md`](docs/contributing.md)（本地起服务、加端点要改的 6 个位置、三类测试怎么选）。这里只放三句最常被问到的：

1. **提交前跑 `npm run ci`**，全绿才推。它跑什么由 [`package.json`](package.json) 的 `scripts.ci` 决定 —— 别照别的文档抄清单，抄的那一刻就开始过时。
2. 版本号由 `node script/bump-version.mjs` 按暂存 diff 机械跳档，推之前把 `package.json` 一起提交。
3. 改动理由写进 [`CHANGELOG.md`](CHANGELOG.md)（长期文档的改动理由也写这里）；新增/挪动文档要同步 [`docs/README.md`](docs/README.md) 的索引，否则 `tests/docsIndex.test.ts` 会红。

安全问题的报告渠道与密钥轮换顺序见 [`SECURITY.md`](SECURITY.md) —— 涉及凭据、限速、鉴权边界的改动，先读那份再动手。
